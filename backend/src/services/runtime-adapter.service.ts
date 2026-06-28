import { createHash, createHmac, randomUUID } from 'crypto';
import {
  AgentInvokeRequest,
  AgentInvokeResponse,
  AgentReportedMetric,
  AgentResponseMessage,
  AgentRuntimeConfigSnapshot,
  AgentSessionSnapshot,
  RUNTIME_MAX_ATTEMPTS,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_USER_AGENT,
  RecentMessage,
  ProjectMemorySnapshot,
  RuntimeEventAppend,
  RuntimeEventRepository,
  RuntimeFailureType,
  RuntimeFetch,
  RuntimeHttpResponse,
  RuntimeInvokeConfig,
  SanitizedAgentResponseMessage,
  AgentInvokeTrigger,
} from './runtime-types';

const DEFAULT_TIMEOUT_MS = 30_000;
const ATTEMPT = RUNTIME_MAX_ATTEMPTS;

export interface BuildSignedHeadersInput {
  rawBody: string | Buffer;
  invokeSecret: string;
  timestamp: number | string;
  deliveryId: string;
  projectId: string;
  sessionId: string;
  agentId: string;
  runId: string;
  attempt?: number;
  traceId: string;
  idempotencyKey?: string;
}

export interface InvokeAgentInput {
  projectId: string;
  sessionId: string;
  agentId: string;
  endpointUrl: string;
  invokeSecret: string;
  trigger: AgentInvokeTrigger;
  agent: AgentRuntimeConfigSnapshot;
  session: AgentSessionSnapshot;
  recentMessages?: RecentMessage[];
  projectMemories?: ProjectMemorySnapshot[];
  projectRules?: { path: string; content: string; updated_at: string } | null;
  runtime?: Partial<RuntimeInvokeConfig>;
  runId?: string;
  deliveryId?: string;
  traceId?: string;
  correlationId?: string;
  createdAt?: string;
  timeoutMs?: number;
}

export interface InvokeAgentWithRepositoryInput extends InvokeAgentInput {
  eventRepository: RuntimeEventRepository;
  fetchFn?: RuntimeFetch;
  now?: () => Date;
}

export interface RuntimeAdapterServiceOptions {
  fetchFn?: RuntimeFetch;
  now?: () => Date;
  timeoutMs?: number;
}

export interface InvokeAgentResult {
  ok: boolean;
  status: 'completed' | 'failed';
  agentStatus?: AgentInvokeResponse['status'];
  runId: string;
  deliveryId: string;
  attempt: number;
  httpStatus?: number;
  failureType?: RuntimeFailureType;
  failureCode?: string;
  failureMessage?: string;
  messages: SanitizedAgentResponseMessage[];
  metrics: AgentReportedMetric[];
}

interface FailureDetails {
  failureType: RuntimeFailureType;
  message: string;
  code?: string;
  httpStatus?: number;
  retryable?: boolean;
  responseBody?: string;
}

interface ResponseValidationResult {
  response?: AgentInvokeResponse;
  failure?: FailureDetails;
}

export function sha256Hex(rawBody: string | Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function buildSignedHeaders(input: BuildSignedHeadersInput): Record<string, string> {
  const attempt = input.attempt ?? ATTEMPT;
  const timestamp = String(input.timestamp);
  const bodyHash = sha256Hex(input.rawBody);
  const signedPayload = `${timestamp}.${input.deliveryId}.${bodyHash}`;
  const signature = createHmac('sha256', input.invokeSecret).update(signedPayload).digest('hex');
  const idempotencyKey = input.idempotencyKey ?? `${input.runId}:attempt:${attempt}`;

  return {
    'Content-Type': 'application/json',
    'User-Agent': RUNTIME_USER_AGENT,
    'X-ZZ-Protocol-Version': RUNTIME_PROTOCOL_VERSION,
    'X-ZZ-Project-Id': input.projectId,
    'X-ZZ-Session-Id': input.sessionId,
    'X-ZZ-Agent-Id': input.agentId,
    'X-ZZ-Run-Id': input.runId,
    'X-ZZ-Delivery-Id': input.deliveryId,
    'X-ZZ-Attempt': String(attempt),
    'X-ZZ-Timestamp': timestamp,
    'X-ZZ-Trace-Id': input.traceId,
    'X-ZZ-Idempotency-Key': idempotencyKey,
    'X-ZZ-Signature': `sha256=${signature}`,
  };
}

export async function invokeAgent(
  input: InvokeAgentWithRepositoryInput,
): Promise<InvokeAgentResult> {
  const service = new RuntimeAdapterService(input.eventRepository, {
    fetchFn: input.fetchFn,
    now: input.now,
    timeoutMs: input.timeoutMs,
  });

  return service.invokeAgent(input);
}

export class RuntimeAdapterService {
  constructor(
    private readonly eventRepository: RuntimeEventRepository,
    private readonly options: RuntimeAdapterServiceOptions = {},
  ) {}

  async invokeAgent(input: InvokeAgentInput): Promise<InvokeAgentResult> {
    const now = this.options.now ?? (() => new Date());
    const createdAt = input.createdAt ?? now().toISOString();
    const timestamp = Math.floor(now().getTime() / 1000);
    const timeoutMs = input.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const runId = input.runId ?? `run_${randomUUID().replace(/-/g, '')}`;
    const deliveryId = input.deliveryId ?? `deliv_${randomUUID().replace(/-/g, '')}`;
    const traceId = input.traceId ?? `trace_${randomUUID().replace(/-/g, '')}`;
    const correlationId = input.correlationId ?? runId;
    const idempotencyKey = `${runId}:attempt:${ATTEMPT}`;
    const endpointUrl = input.endpointUrl;
    const triggerMessageId = getTriggerMessageId(input.trigger);

    const request = buildInvokeRequest({
      ...input,
      runId,
      deliveryId,
      traceId,
      correlationId,
      createdAt,
      timeoutMs,
    });
    const rawBody = JSON.stringify(request);

    await this.appendLifecycleEvent({
      projectId: input.projectId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      actorType: 'system',
      type: 'agent.run.queued',
      traceId,
      idempotencyKey: `${idempotencyKey}:queued`,
      payload: {
        run_id: runId,
        agent_id: input.agentId,
        trigger_message_id: triggerMessageId,
        delivery_id: deliveryId,
        attempt: ATTEMPT,
        max_attempts: RUNTIME_MAX_ATTEMPTS,
        endpoint_url_hash: sha256Hex(endpointUrl),
        queued_at: createdAt,
      },
    });

    await this.appendLifecycleEvent({
      projectId: input.projectId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      actorType: 'system',
      type: 'agent.run.started',
      traceId,
      idempotencyKey: `${idempotencyKey}:started`,
      payload: {
        run_id: runId,
        agent_id: input.agentId,
        delivery_id: deliveryId,
        attempt: ATTEMPT,
        started_at: now().toISOString(),
      },
    });

    const headers = buildSignedHeaders({
      rawBody,
      invokeSecret: input.invokeSecret,
      timestamp,
      deliveryId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      runId,
      attempt: ATTEMPT,
      traceId,
      idempotencyKey,
    });

    const fetchFn = this.options.fetchFn ?? defaultFetch;
    const startedAtMs = now().getTime();
    const httpResult = await postAgent(fetchFn, endpointUrl, headers, rawBody, timeoutMs);
    const durationMs = Math.max(0, now().getTime() - startedAtMs);

    if (httpResult.failure) {
      return this.failRun(input, {
        runId,
        deliveryId,
        traceId,
        idempotencyKey,
        durationMs,
        failure: httpResult.failure,
      });
    }

    const httpResponse = httpResult.response;
    if (!httpResponse) {
      return this.failRun(input, {
        runId,
        deliveryId,
        traceId,
        idempotencyKey,
        durationMs,
        failure: {
          failureType: 'transport_error',
          message: 'No HTTP response received from agent',
        },
      });
    }

    const responseText = await httpResponse.text();
    const nonOkFailure = classifyNonOkHttpResponse(httpResponse.status, responseText);
    if (nonOkFailure) {
      return this.failRun(input, {
        runId,
        deliveryId,
        traceId,
        idempotencyKey,
        durationMs,
        failure: nonOkFailure,
      });
    }

    const parsed = parseAndValidateResponse(responseText);
    if (parsed.failure) {
      return this.failRun(input, {
        runId,
        deliveryId,
        traceId,
        idempotencyKey,
        durationMs,
        failure: {
          ...parsed.failure,
          httpStatus: httpResponse.status,
          responseBody: responseText,
        },
      });
    }

    const agentResponse = parsed.response as AgentInvokeResponse;

    if (agentResponse.status === 'failed' || agentResponse.status === 'rejected') {
      return this.failRun(input, {
        runId,
        deliveryId,
        traceId,
        idempotencyKey,
        durationMs,
        failure: {
          failureType: agentResponse.status === 'rejected' ? 'agent_rejected' : 'agent_error',
          code: agentResponse.error?.code,
          message:
            agentResponse.error?.message ??
            (agentResponse.status === 'rejected'
              ? 'Agent rejected the invoke request'
              : 'Agent reported a failed invoke run'),
          retryable: agentResponse.error?.retryable,
          httpStatus: httpResponse.status,
        },
        agentStatus: agentResponse.status,
        metrics: agentResponse.metrics ?? [],
      });
    }

    const messages =
      agentResponse.status === 'completed'
        ? sanitizeResponseMessages(agentResponse.messages ?? [], input.agentId, runId)
        : [];
    const metrics = agentResponse.metrics ?? [];

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      await this.appendLifecycleEvent({
        projectId: input.projectId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        actorType: 'agent',
        type: 'message.created',
        traceId,
        idempotencyKey: `${idempotencyKey}:message:${index}`,
        payload: {
          ...message,
          message_index: index,
          content_type: message.content_type,
        },
      });
    }

    await this.appendHealthMetricEvents(input, {
      runId,
      deliveryId,
      traceId,
      idempotencyKey,
      metrics,
      observedAt: now().toISOString(),
    });

    await this.appendLifecycleEvent({
      projectId: input.projectId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      actorType: 'system',
      type: 'agent.run.completed',
      traceId,
      idempotencyKey: `${idempotencyKey}:completed`,
      payload: {
        run_id: runId,
        agent_id: input.agentId,
        delivery_id: deliveryId,
        attempt: ATTEMPT,
        status: agentResponse.status,
        http_status: httpResponse.status,
        duration_ms: durationMs,
        message_count: messages.length,
        metric_count: metrics.length,
        output_message_ids: messages.map((message) => message.message_id),
        metrics,
        debug: agentResponse.debug,
        completed_at: now().toISOString(),
      },
    });

    return {
      ok: true,
      status: 'completed',
      agentStatus: agentResponse.status,
      runId,
      deliveryId,
      attempt: ATTEMPT,
      httpStatus: httpResponse.status,
      messages,
      metrics,
    };
  }

  private async failRun(
    input: InvokeAgentInput,
    context: {
      runId: string;
      deliveryId: string;
      traceId: string;
      idempotencyKey: string;
      durationMs: number;
      failure: FailureDetails;
      agentStatus?: AgentInvokeResponse['status'];
      metrics?: AgentReportedMetric[];
    },
  ): Promise<InvokeAgentResult> {
    const metrics = context.metrics ?? [];
    const failedAt = (this.options.now ?? (() => new Date()))().toISOString();

    await this.appendHealthMetricEvents(input, {
      runId: context.runId,
      deliveryId: context.deliveryId,
      traceId: context.traceId,
      idempotencyKey: context.idempotencyKey,
      metrics,
      observedAt: failedAt,
    });

    await this.appendLifecycleEvent({
      projectId: input.projectId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      actorType: 'system',
      type: 'agent.run.failed',
      traceId: context.traceId,
      idempotencyKey: `${context.idempotencyKey}:failed`,
      payload: {
        run_id: context.runId,
        agent_id: input.agentId,
        delivery_id: context.deliveryId,
        attempt: ATTEMPT,
        status: context.agentStatus ?? 'failed',
        error: {
          code: context.failure.code ?? context.failure.failureType,
          message: context.failure.message,
          retryable: context.failure.retryable ?? false,
        },
        failure_type: context.failure.failureType,
        error_code: context.failure.code,
        error_message: context.failure.message,
        retryable: context.failure.retryable ?? false,
        http_status: context.failure.httpStatus,
        duration_ms: context.durationMs,
        metrics,
        response_body: context.failure.responseBody,
        failed_at: failedAt,
      },
    });

    return {
      ok: false,
      status: 'failed',
      agentStatus: context.agentStatus,
      runId: context.runId,
      deliveryId: context.deliveryId,
      attempt: ATTEMPT,
      httpStatus: context.failure.httpStatus,
      failureType: context.failure.failureType,
      failureCode: context.failure.code,
      failureMessage: context.failure.message,
      messages: [],
      metrics,
    };
  }

  private async appendLifecycleEvent(event: RuntimeEventAppend): Promise<void> {
    await this.eventRepository.appendEvent(event);
  }

  private async appendHealthMetricEvents(
    input: InvokeAgentInput,
    context: {
      runId: string;
      deliveryId: string;
      traceId: string;
      idempotencyKey: string;
      metrics: AgentReportedMetric[];
      observedAt: string;
    },
  ): Promise<void> {
    for (let index = 0; index < context.metrics.length; index++) {
      const metric = context.metrics[index];
      await this.appendLifecycleEvent({
        projectId: input.projectId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        actorType: 'agent',
        type: 'health.metric',
        traceId: context.traceId,
        idempotencyKey: `${context.idempotencyKey}:metric:${index}`,
        payload: {
          project_id: input.projectId,
          session_id: input.sessionId,
          agent_id: input.agentId,
          run_id: context.runId,
          delivery_id: context.deliveryId,
          attempt: ATTEMPT,
          name: metric.name,
          value: metric.value,
          unit: normalizeMetricUnit(metric.unit),
          tags: metric.tags,
          details: metric.metadata,
          observed_at: context.observedAt,
        },
      });
    }
  }
}

function buildInvokeRequest(
  input: InvokeAgentInput & {
    runId: string;
    deliveryId: string;
    traceId: string;
    correlationId: string;
    createdAt: string;
    timeoutMs: number;
  },
): AgentInvokeRequest {
  return {
    protocol_version: RUNTIME_PROTOCOL_VERSION,
    project_id: input.projectId,
    session_id: input.sessionId,
    agent_id: input.agentId,
    run_id: input.runId,
    delivery_id: input.deliveryId,
    attempt: ATTEMPT,
    trigger: input.trigger,
    agent: input.agent,
    session: input.session,
    recent_messages: input.recentMessages ?? [],
    project_memories: input.projectMemories ?? [],
    project_rules: input.projectRules ?? null,
    runtime: {
      ...(input.runtime ?? {}),
      timeout_ms: input.timeoutMs,
      max_attempts: RUNTIME_MAX_ATTEMPTS,
      supports_async: false,
      supports_streaming: false,
    },
    trace_id: input.traceId,
    correlation_id: input.correlationId,
    created_at: input.createdAt,
  };
}

async function postAgent(
  fetchFn: RuntimeFetch,
  endpointUrl: string,
  headers: Record<string, string>,
  rawBody: string,
  timeoutMs: number,
): Promise<{ response?: RuntimeHttpResponse; failure?: FailureDetails }> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchFn(endpointUrl, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: controller.signal,
    });

    return { response };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (timedOut || isAbort) {
      return {
        failure: {
          failureType: 'timeout',
          message: `Agent invoke timed out after ${timeoutMs}ms`,
          retryable: false,
        },
      };
    }

    return {
      failure: {
        failureType: 'transport_error',
        message: err instanceof Error ? err.message : 'Agent invoke transport error',
        retryable: false,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyNonOkHttpResponse(status: number, responseBody: string): FailureDetails | undefined {
  if (status === 200) return undefined;

  if (status === 202) {
    return {
      failureType: 'unsupported_async_response',
      message: 'Agent returned HTTP 202, but runtime.v1 only supports synchronous HTTP 200 responses',
      httpStatus: status,
      retryable: false,
      responseBody,
    };
  }

  if (status === 401 || status === 403) {
    return {
      failureType: 'auth_error',
      message: `Agent endpoint returned HTTP ${status}`,
      httpStatus: status,
      retryable: false,
      responseBody,
    };
  }

  if (status === 429) {
    return {
      failureType: 'rate_limited',
      message: 'Agent endpoint rate limited the invoke request',
      httpStatus: status,
      retryable: false,
      responseBody,
    };
  }

  if (status === 404 || status === 410 || status === 502 || status === 503 || status === 504) {
    return {
      failureType: 'agent_unavailable',
      message: `Agent endpoint unavailable (HTTP ${status})`,
      httpStatus: status,
      retryable: false,
      responseBody,
    };
  }

  if (status === 408) {
    return {
      failureType: 'timeout',
      message: 'Agent endpoint returned HTTP 408',
      httpStatus: status,
      retryable: false,
      responseBody,
    };
  }

  if (status >= 500) {
    return {
      failureType: 'agent_error',
      message: `Agent endpoint returned HTTP ${status}`,
      httpStatus: status,
      retryable: false,
      responseBody,
    };
  }

  if (status === 400 || status === 409 || status === 422) {
    return {
      failureType: 'agent_rejected',
      message: `Agent endpoint rejected the invoke request (HTTP ${status})`,
      httpStatus: status,
      retryable: false,
      responseBody,
    };
  }

  return {
    failureType: 'invalid_response',
    message: `Agent endpoint returned unsupported HTTP ${status}`,
    httpStatus: status,
    retryable: false,
    responseBody,
  };
}

function parseAndValidateResponse(responseText: string): ResponseValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return {
      failure: {
        failureType: 'invalid_response',
        message: 'Agent response body is not valid JSON',
        retryable: false,
      },
    };
  }

  if (!isRecord(parsed)) {
    return invalidResponse('Agent response must be a JSON object');
  }

  if (!isAgentResponseStatus(parsed.status)) {
    return invalidResponse('Agent response status is missing or unsupported');
  }

  if (parsed.messages !== undefined) {
    if (!Array.isArray(parsed.messages)) {
      return invalidResponse('Agent response messages must be an array');
    }

    for (const message of parsed.messages) {
      if (!isRecord(message) || typeof message.content !== 'string') {
        return invalidResponse('Every agent response message must include string content');
      }
    }
  }

  if (parsed.metrics !== undefined) {
    if (!Array.isArray(parsed.metrics)) {
      return invalidResponse('Agent response metrics must be an array');
    }

    for (const metric of parsed.metrics) {
      if (!isRecord(metric) || typeof metric.name !== 'string' || typeof metric.value !== 'number') {
        return invalidResponse('Every agent reported metric must include name and numeric value');
      }
    }
  }

  if (parsed.error !== undefined) {
    if (!isRecord(parsed.error) || typeof parsed.error.code !== 'string' || typeof parsed.error.message !== 'string') {
      return invalidResponse('Agent response error must include code and message');
    }
  }

  return {
    response: parsed as unknown as AgentInvokeResponse,
  };
}

function sanitizeResponseMessages(
  messages: AgentResponseMessage[],
  agentId: string,
  runId: string,
): SanitizedAgentResponseMessage[] {
  return messages.map((message) => {
    const visibility = message.visibility === 'direct' ? 'direct' : 'session';
    const recipientParticipantIds = Array.isArray(message.recipient_participant_ids)
      ? message.recipient_participant_ids.filter((item): item is string => typeof item === 'string')
      : [];
    const sanitized: SanitizedAgentResponseMessage = {
      message_id: randomUUID(),
      role: 'agent',
      sender_type: 'agent',
      sender_id: agentId,
      agent_id: agentId,
      run_id: runId,
      caused_by_run_id: runId,
      content: message.content,
      content_type: typeof message.content_type === 'string' ? message.content_type : 'text',
      visibility,
      recipient_participant_ids: recipientParticipantIds,
      dispatch_ttl: normalizeDispatchTtl(message.dispatch_ttl),
    };

    if (isRecord(message.metadata)) {
      sanitized.metadata = message.metadata;
    }

    if (isSupportedTarget(message.target)) {
      sanitized.target = message.target;
    }

    return sanitized;
  });
}

function invalidResponse(message: string): ResponseValidationResult {
  return {
    failure: {
      failureType: 'invalid_response',
      message,
      retryable: false,
    },
  };
}

function isAgentResponseStatus(value: unknown): value is AgentInvokeResponse['status'] {
  return value === 'completed' || value === 'no_reply' || value === 'failed' || value === 'rejected';
}

function getTriggerMessageId(trigger: AgentInvokeTrigger): string | undefined {
  const messageId = 'message_id' in trigger ? trigger.message_id : undefined;
  return typeof messageId === 'string' && messageId.length > 0 ? messageId : undefined;
}

function normalizeDispatchTtl(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return Math.min(value, 8);
  }
  return 0;
}

function normalizeMetricUnit(value: unknown): 'count' | 'ms' | 'percent' | 'bytes' | 'tokens' {
  if (value === 'ms' || value === 'percent' || value === 'bytes' || value === 'tokens') {
    return value;
  }
  return 'count';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedTarget(value: unknown): value is AgentResponseMessage['target'] {
  if (!isRecord(value)) return false;
  if (value.type !== 'session' && value.type !== 'agent' && value.type !== 'user') return false;
  return value.id === undefined || typeof value.id === 'string';
}

const defaultFetch: RuntimeFetch = async (url, init) => {
  return fetch(url, init);
};
