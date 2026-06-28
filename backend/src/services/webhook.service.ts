import * as crypto from 'crypto';
import { AppDataSource } from '../data-source';
import { Project } from '../entities/project.entity';
import {
  ProjectWebhookDelivery,
  WebhookDeliveryStatus,
} from '../entities/project-webhook-delivery.entity';
import { EventEnvelope } from './event-stream.service';

const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000]; // 1m, 5m, 30m, 2h

/**
 * Parse WEBHOOK_RETRY_DELAYS_MS safely. Malformed input (a non-numeric entry,
 * a negative value, Infinity, or an empty/whitespace-only list) is REJECTED and
 * the default schedule is used instead — malformed values must never silently
 * produce surprising retry timing (e.g. NaN collapsing to an immediate retry
 * storm, or an empty list disabling retries entirely).
 *
 * Returns a new array each call; never mutates the default.
 */
export function parseRetryDelays(raw?: string): number[] {
  if (!raw || typeof raw !== 'string' || raw.trim() === '') {
    return [...DEFAULT_RETRY_DELAYS_MS];
  }
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    return [...DEFAULT_RETRY_DELAYS_MS];
  }
  const delays: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) {
      console.warn(
        `[webhook] Invalid WEBHOOK_RETRY_DELAYS_MS entry ${JSON.stringify(part)}; ` +
        `falling back to the default retry schedule to avoid surprising retry timing.`,
      );
      return [...DEFAULT_RETRY_DELAYS_MS];
    }
    delays.push(n);
  }
  return delays;
}

/**
 * Mask sensitive components of a webhook URL for logging: replace userinfo
 * (user:password@) with "***@" and the query string with "?***" so credentials
 * and query tokens are never written to delivery-failure / dead-letter logs.
 * Best-effort structural mask if the value is not a parseable URL.
 */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    if (u.search) {
      u.search = '?***';
    }
    return u.toString();
  } catch {
    return raw
      .replace(/[^\s:/@#]+:[^\s/@#]*@/g, '***@')
      .replace(/\?.*$/, '?***');
  }
}

/**
 * Mask any URL embedded in an arbitrary error/status string. Delivery errors
 * can echo the request URL verbatim (e.g. fetch's "Request cannot be constructed
 * from a URL that includes credentials: <full url>"), so the appended error text
 * is run through this before logging to keep failure logs secret-safe.
 */
export function maskMessage(msg: string): string {
  return msg.replace(/https?:\/\/[^\s"'<>]+/g, (u) => maskUrl(u));
}

const RETRY_DELAYS = parseRetryDelays(process.env.WEBHOOK_RETRY_DELAYS_MS);
const MAX_RETRIES = RETRY_DELAYS.length;
const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Error carrying an optional HTTP status code from a failed webhook delivery.
 * The message is already safe to log/mask at the call site.
 */
class WebhookDeliveryError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * WebhookService handles outbound webhook delivery with HMAC-SHA256 signing
 * and exponential backoff retry.
 */
class WebhookService {
  /**
   * Send a webhook event to a project's configured webhook URL.
   * Checks the project's webhookEnabledEvents whitelist before sending.
   * Returns true if the webhook was sent (or queued for retry), false if skipped.
   */
  async sendWebhook(projectId: string, eventEnvelope: EventEnvelope): Promise<boolean> {
    const projectRepo = AppDataSource.getRepository(Project);
    const project = await projectRepo.findOne({ where: { id: projectId } });

    if (!project) return false;

    // Check if webhook is configured
    if (!project.webhookUrl) return false;

    // Check if event type is in the whitelist
    const enabledEvents = project.webhookEnabledEvents || [];
    if (!enabledEvents.includes(eventEnvelope.type)) return false;

    // Fire-and-forget: send in background with retry
    this.deliverWithRetry(project.webhookUrl, project.webhookSecret || '', eventEnvelope, 0);

    return true;
  }

  private async deliverWithRetry(
    url: string,
    secret: string,
    event: EventEnvelope,
    attempt: number,
  ): Promise<void> {
    const deliveryRepo = AppDataSource.getRepository(ProjectWebhookDelivery);

    try {
      const statusCode = await this.deliver(url, secret, event);
      await deliveryRepo.save(
        deliveryRepo.create({
          projectId: event.projectId,
          eventId: event.id,
          eventType: event.type,
          attempt: attempt + 1,
          status: WebhookDeliveryStatus.SUCCESS,
          httpStatusCode: statusCode,
          maskedUrl: maskUrl(url),
        }),
      );
    } catch (err) {
      const message = maskMessage(err instanceof Error ? err.message : String(err));
      const statusCode = err instanceof WebhookDeliveryError ? err.statusCode : null;
      const willRetry = attempt < MAX_RETRIES;

      await deliveryRepo.save(
        deliveryRepo.create({
          projectId: event.projectId,
          eventId: event.id,
          eventType: event.type,
          attempt: attempt + 1,
          status: willRetry ? WebhookDeliveryStatus.RETRYING : WebhookDeliveryStatus.DEAD_LETTER,
          httpStatusCode: statusCode ?? null,
          message,
          maskedUrl: maskUrl(url),
        }),
      );

      // Total attempts = 1 initial + MAX_RETRIES retries. The retry log fires
      // for attempts that will be retried; the dead-letter fires on the final
      // attempt. Counts below name both "attempt N of (initial + retries)" and
      // "retry N of MAX_RETRIES" so the total is unambiguous.
      if (willRetry) {
        const delay = RETRY_DELAYS[attempt];
        console.warn(
          `[webhook] Delivery failed, attempt ${attempt + 1} of ${MAX_RETRIES + 1} ` +
          `(initial + retries; retry ${attempt + 1}/${MAX_RETRIES}) to ${maskUrl(url)}, ` +
          `retrying in ${delay}ms:`,
          message,
        );
        setTimeout(() => {
          this.deliverWithRetry(url, secret, event, attempt + 1);
        }, delay);
      } else {
        console.warn(
          `[webhook] Dead letter — all ${MAX_RETRIES} retries exhausted ` +
          `(${MAX_RETRIES + 1} total attempts = initial + retries) for ${maskUrl(url)}, ` +
          `event ${event.id} (type: ${event.type})`,
        );
      }
    }
  }

  private async deliver(url: string, secret: string, event: EventEnvelope): Promise<number> {
    const body = JSON.stringify({
      id: event.id,
      seq: event.seq,
      project_id: event.projectId,
      session_id: event.sessionId,
      agent_id: event.agentId,
      user_id: event.userId,
      type: event.type,
      payload: event.payload,
      created_at: event.createdAt,
      trace_id: event.traceId,
    });

    // Compute HMAC-SHA256 signature
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ZZ-Signature': `sha256=${signature}`,
          'User-Agent': 'zz-agent-webhook/1.0',
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new WebhookDeliveryError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      }

      return response.status;
    } catch (err) {
      if (err instanceof WebhookDeliveryError) {
        throw err;
      }
      throw new WebhookDeliveryError(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export const webhookService = new WebhookService();
