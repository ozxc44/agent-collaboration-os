/**
 * Project Webhook Delivery History Test
 *
 * Proves the backend contract for project-scoped webhook delivery history:
 *  1. Successful deliveries are persisted with status=success.
 *  2. Failed deliveries that will retry are persisted with status=retrying.
 *  3. Exhausted retries are persisted with status=dead_letter.
 *  4. Retry attempt counts match the configured schedule.
 *  5. Project members (owner/admin/member/viewer) can read history; outsiders
 *     and anonymous callers are denied.
 *  6. History is returned newest-first and pagination/filtering work.
 *  7. Response never exposes webhook secret, raw request/response bodies, or
 *     an unmasked webhook URL.
 *
 * Usage:
 *  cd backend && npm run build && node dist/tests/project-webhook-delivery.test.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-webhook-delivery-test-secret';
process.env.WEBHOOK_RETRY_DELAYS_MS = '10,20,50,100'; // fast retries for testing

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { webhookService } = await import('../src/services/webhook.service');
  const { ProjectWebhookDelivery, WebhookDeliveryStatus } = await import(
    '../src/entities/project-webhook-delivery.entity'
  );

  await AppDataSource.initialize();
  const server = http.createServer(app);
  const deliveryRepo = AppDataSource.getRepository(ProjectWebhookDelivery);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let receiver: http.Server | null = null;

  try {
    // ─── Local webhook receiver ────────────────────────────────────────
    const receivedBodies: Array<{ body: Record<string, unknown> }> = [];
    const failureBudget = new Map<string, number>(); // Infinity => always fail
    const attemptsByEvent = new Map<string, number>();

    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = {};
        }
        const id = typeof parsed.id === 'string' ? parsed.id : '(unknown)';
        const seen = attemptsByEvent.get(id) ?? 0;
        attemptsByEvent.set(id, seen + 1);
        const budget = failureBudget.has(id) ? failureBudget.get(id)! : Number.POSITIVE_INFINITY;
        const status = seen < budget ? 500 : 200;
        receivedBodies.push({ body: parsed });
        res.writeHead(status);
        res.end();
      });
    });

    await new Promise<void>((resolve) => receiver!.listen(0, resolve));
    const recvAddr = receiver.address() as AddressInfo;
    const recvPort = recvAddr.port;

    // ─── Users and project ─────────────────────────────────────────────
    const owner = await register(baseUrl, 'webhook-history-owner');
    const viewer = await register(baseUrl, 'webhook-history-viewer');
    const member = await register(baseUrl, 'webhook-history-member');
    const outsider = await register(baseUrl, 'webhook-history-outsider');

    const cleanWebhookUrl = `http://127.0.0.1:${recvPort}/hook`;
    const rawWebhookUrl = `http://leakuser:hunter2@127.0.0.1:${recvPort}/hook?api_key=s3cr3t&ref=x`;
    const maskedWebhookUrl = `http://***@127.0.0.1:${recvPort}/hook?***`;

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Webhook Delivery History Test',
      description: 'Backend coverage for webhook delivery history',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const configureClean = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      webhook_url: cleanWebhookUrl,
      webhook_secret: 'webhook-secret-must-not-leak',
      webhook_enabled_events: ['history.success', 'history.retry', 'history.dead', 'history.recover'],
    });
    assert.equal(configureClean.status, 200);

    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addViewer.status, 201);

    const addMember = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: member.userId,
      role: 'member',
    });
    assert.equal(addMember.status, 201);

    // ─── Test 1: Successful delivery is recorded ───────────────────────
    console.log('Test 1: Successful delivery is persisted');
    const successEvent = makeEvent(projectId, 'history.success', { ok: true });
    failureBudget.set(successEvent.id, 0);
    const sentSuccess = await webhookService.sendWebhook(projectId, successEvent);
    assert.equal(sentSuccess, true);

    await waitForDeliveryRecords(deliveryRepo, projectId, successEvent.id, 1);
    const successRecords = await deliveryRepo.find({
      where: { projectId, eventId: successEvent.id },
      order: { attempt: 'ASC' },
    });
    assert.equal(successRecords.length, 1);
    assert.equal(successRecords[0].status, WebhookDeliveryStatus.SUCCESS);
    assert.equal(successRecords[0].attempt, 1);
    assert.equal(successRecords[0].httpStatusCode, 200);
    assert.equal(successRecords[0].maskedUrl, cleanWebhookUrl);
    console.log('  ✓ success record persisted with HTTP 200');

    // ─── Test 2: Retry then dead-letter ────────────────────────────────
    console.log('Test 2: Failed delivery retries then dead-letters');
    const deadEvent = makeEvent(projectId, 'history.dead', { shouldFail: true });
    // No budget entry => always 500. With 4 retry delays there are 5 attempts.
    const sentDead = await webhookService.sendWebhook(projectId, deadEvent);
    assert.equal(sentDead, true);

    await waitForDeliveryRecords(deliveryRepo, projectId, deadEvent.id, 5);
    const deadRecords = await deliveryRepo.find({
      where: { projectId, eventId: deadEvent.id },
      order: { attempt: 'ASC' },
    });
    assert.equal(deadRecords.length, 5, 'expected 1 initial + 4 retry attempts');
    for (let i = 0; i < deadRecords.length; i++) {
      assert.equal(deadRecords[i].attempt, i + 1);
      assert.equal(deadRecords[i].httpStatusCode, 500);
      if (i < deadRecords.length - 1) {
        assert.equal(deadRecords[i].status, WebhookDeliveryStatus.RETRYING);
      } else {
        assert.equal(deadRecords[i].status, WebhookDeliveryStatus.DEAD_LETTER);
      }
    }
    console.log('  ✓ 4 retrying records and 1 dead_letter record persisted');

    // ─── Test 3: Retry recovery ────────────────────────────────────────
    console.log('Test 3: Retry recovers after transient failures');
    const recoverEvent = makeEvent(projectId, 'history.recover', { recoverAfter: 2 });
    failureBudget.set(recoverEvent.id, 2); // fail 2x, succeed on 3rd
    const sentRecover = await webhookService.sendWebhook(projectId, recoverEvent);
    assert.equal(sentRecover, true);

    await waitForDeliveryRecords(deliveryRepo, projectId, recoverEvent.id, 3);
    // Grace window to ensure no extra attempt sneaks in.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const recoverRecords = await deliveryRepo.find({
      where: { projectId, eventId: recoverEvent.id },
      order: { attempt: 'ASC' },
    });
    assert.equal(recoverRecords.length, 3);
    assert.equal(recoverRecords[0].status, WebhookDeliveryStatus.RETRYING);
    assert.equal(recoverRecords[0].httpStatusCode, 500);
    assert.equal(recoverRecords[1].status, WebhookDeliveryStatus.RETRYING);
    assert.equal(recoverRecords[1].httpStatusCode, 500);
    assert.equal(recoverRecords[2].status, WebhookDeliveryStatus.SUCCESS);
    assert.equal(recoverRecords[2].httpStatusCode, 200);
    console.log('  ✓ 2 retrying records then 1 success record persisted');

    // ─── Test 4: Delivery history endpoint returns safe, newest-first data ─
    console.log('Test 4: Delivery history endpoint shape, ordering, and masking');
    const history = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries?limit=100`,
      owner.token,
    );
    assert.equal(history.status, 200);
    assert.equal(history.data.total >= 9, true, 'expected at least 9 delivery records');
    assert.ok(Array.isArray(history.data.data));
    const payloadText = JSON.stringify(history.data);
    assert.ok(
      !payloadText.includes('webhook-secret-must-not-leak'),
      'history response must not expose webhook secret',
    );
    assert.ok(
      !payloadText.includes('"raw"'),
      'history response must not include raw request/response bodies',
    );

    // Newest first: created_at should be non-increasing.
    assert.ok(history.data.data.length > 0);
    for (let i = 1; i < history.data.data.length; i++) {
      const prev = new Date(history.data.data[i - 1].created_at).getTime();
      const curr = new Date(history.data.data[i].created_at).getTime();
      assert.ok(
        prev >= curr,
        `expected newest-first ordering at index ${i}: ${history.data.data[i - 1].created_at} < ${history.data.data[i].created_at}`,
      );
    }

    for (const row of history.data.data) {
      assert.equal(row.project_id, projectId);
      assert.ok(Object.values(WebhookDeliveryStatus).includes(row.status));
    }
    console.log('  ✓ response is secret-safe, newest-first, and well-formed');

    // ─── Test 5: Pagination ────────────────────────────────────────────
    console.log('Test 5: Pagination and status filter');
    const page1 = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries?limit=5&offset=0`,
      owner.token,
    );
    assert.equal(page1.status, 200);
    assert.equal(page1.data.data.length, 5);
    assert.equal(page1.data.limit, 5);
    assert.equal(page1.data.offset, 0);

    const page2 = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries?limit=5&offset=5`,
      owner.token,
    );
    assert.equal(page2.status, 200);
    assert.equal(page2.data.data.length, 4);
    assert.equal(page2.data.offset, 5);

    const successFilter = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries?status=success`,
      owner.token,
    );
    assert.equal(successFilter.status, 200);
    assert.ok(successFilter.data.data.length >= 2);
    for (const row of successFilter.data.data) {
      assert.equal(row.status, 'success');
    }

    const deadFilter = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries?status=dead_letter`,
      owner.token,
    );
    assert.equal(deadFilter.status, 200);
    assert.equal(deadFilter.data.data.length, 1);
    assert.equal(deadFilter.data.data[0].event_id, deadEvent.id);
    console.log('  ✓ pagination and status filter work');

    // ─── Test 6: Masking of credential-bearing webhook URLs ─────────────
    console.log('Test 6: Credential webhook URL is masked in history');
    const maskedProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Webhook Mask Test',
      description: 'Masking coverage',
    });
    assert.equal(maskedProject.status, 201);
    const maskedProjectId = maskedProject.data.id;

    const configureMasked = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${maskedProjectId}`,
      owner.token,
      {
        webhook_url: rawWebhookUrl,
        webhook_secret: 'masked-secret-must-not-leak',
        webhook_enabled_events: ['history.mask'],
      },
    );
    assert.equal(configureMasked.status, 200);

    const maskEvent = makeEvent(maskedProjectId, 'history.mask', { masked: true });
    const sentMask = await webhookService.sendWebhook(maskedProjectId, maskEvent);
    assert.equal(sentMask, true);

    // Wait for the dead-letter (fetch refuses credential URLs, so all 5 attempts fail).
    await waitForDeliveryRecords(deliveryRepo, maskedProjectId, maskEvent.id, 5);

    const maskedHistory = await api(
      baseUrl,
      'GET',
      `/v1/projects/${maskedProjectId}/webhook-deliveries?limit=100`,
      owner.token,
    );
    assert.equal(maskedHistory.status, 200);
    assert.equal(maskedHistory.data.total, 5);
    const maskedPayloadText = JSON.stringify(maskedHistory.data);
    assert.ok(
      !maskedPayloadText.includes('hunter2'),
      'history response must not expose raw URL password',
    );
    assert.ok(
      !maskedPayloadText.includes('s3cr3t'),
      'history response must not expose raw URL query secret',
    );
    assert.ok(
      !maskedPayloadText.includes('masked-secret-must-not-leak'),
      'history response must not expose webhook secret',
    );

    for (const row of maskedHistory.data.data) {
      assert.equal(row.masked_url, maskedWebhookUrl);
      assert.ok(row.message == null || !row.message.includes('hunter2'));
      assert.ok(row.message == null || !row.message.includes('s3cr3t'));
    }
    console.log('  ✓ credential URL and secrets are masked in persisted history');

    // ─── Test 7: RBAC ──────────────────────────────────────────────────
    console.log('Test 7: RBAC — members allowed, outsiders/anonymous denied');
    const viewerHistory = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries`,
      viewer.token,
    );
    assert.equal(viewerHistory.status, 200, 'viewer should read delivery history');

    const memberHistory = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries`,
      member.token,
    );
    assert.equal(memberHistory.status, 200, 'member should read delivery history');

    const outsiderHistory = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries`,
      outsider.token,
    );
    assert.equal(outsiderHistory.status, 403, 'outsider should not read delivery history');

    const anonymousHistory = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/webhook-deliveries`,
    );
    assert.equal(anonymousHistory.status, 401, 'anonymous caller should be denied');
    console.log('  ✓ RBAC enforced');

    console.log('\nproject-webhook-delivery tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve) => {
      if (receiver) {
        receiver.close(() => resolve());
      } else {
        resolve();
      }
    });
    await AppDataSource.destroy();
  }
}

function makeEvent(projectId: string, type: string, payload: Record<string, unknown>) {
  return {
    id: `evt_${randomUUID().replace(/-/g, '')}`,
    seq: 1,
    projectId,
    sessionId: `session-${type}`,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}

async function waitForDeliveryRecords(
  deliveryRepo: any,
  projectId: string,
  eventId: string,
  targetCount: number,
  timeoutMs = 3_000,
): Promise<void> {
  const seen = () => deliveryRepo.count({ where: { projectId, eventId } });
  if ((await seen()) >= targetCount) return;
  return new Promise<void>((resolve, reject) => {
    const poll = setInterval(async () => {
      if ((await seen()) >= targetCount) {
        clearInterval(poll);
        clearTimeout(failTimer);
        resolve();
      }
    }, 5);
    const failTimer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for ${targetCount} delivery record(s) for ${eventId}`));
    }, timeoutMs);
  });
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectWebhookDeliveryTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
