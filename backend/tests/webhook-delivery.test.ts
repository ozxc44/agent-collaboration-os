/**
 * Webhook Delivery Reliability Test
 *
 * Proves the webhook service's delivery, retry, backoff, and failure-log
 * behavior using local ephemeral HTTP receivers (no external network calls).
 *
 * Tests:
 *  1. Successful delivery — local receiver gets the payload + signature header
 *  2. Failure triggers retry — non-200 response causes initial + retries, then
 *     dead-letter; the test WAITS for the dead-letter log so no retry chain
 *     bleeds into the next test.
 *  3. Retry recovery — server fails N times, then succeeds. Attempt count is
 *     named explicitly as "initial + retries" (fail 2×, succeed on the 3rd
 *     attempt = 1 initial + 2 retries).
 *  4. Failure logs mask credentials — userinfo and query secrets are masked.
 *  5. Unit checks — parseRetryDelays + maskUrl edge cases.
 *
 * Usage:
 *  cd backend && npm run build && node dist/tests/webhook-delivery.test.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'test';
process.env.WEBHOOK_RETRY_DELAYS_MS = '10,20,50,100'; // fast retries for testing

const DEFAULT_DELAYS = [60_000, 300_000, 1_800_000, 7_200_000];

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${label}`);
  } catch (err: any) {
    failed++;
    console.log(`  ❌ ${label}: ${err.message}`);
  }
}

/** Wait until `receivedBodies` has at least `targetCount` entries for `eventId`. */
function waitForEventAttempts(
  receivedBodies: Array<{ body: Record<string, unknown> }>,
  eventId: string,
  targetCount: number,
  timeoutMs = 3_000,
): Promise<void> {
  const seen = () => receivedBodies.filter((r) => r.body.id === eventId).length;
  if (seen() >= targetCount) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (seen() >= targetCount) {
        clearInterval(poll);
        clearTimeout(failTimer);
        resolve();
      }
    }, 5);
    const failTimer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for ${targetCount} attempt(s) for ${eventId}; got ${seen()}`));
    }, timeoutMs);
  });
}

/** Wait until warnLogs contains a "Dead letter" line mentioning `eventId`. */
function waitForDeadLetter(warnLogs: string[], eventId: string, timeoutMs = 3_000): Promise<void> {
  const hit = () => warnLogs.some((l) => l.includes('Dead letter') && l.includes(eventId));
  if (hit()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      if (hit()) {
        clearInterval(poll);
        clearTimeout(failTimer);
        resolve();
      }
    }, 5);
    const failTimer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for dead-letter log for ${eventId}`));
    }, timeoutMs);
  });
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const { Project, User } = await import('../src/entities');
  const { webhookService, parseRetryDelays, maskUrl, maskMessage } = await import('../src/services/webhook.service');

  await AppDataSource.initialize();

  // Capture console.warn so the tests can assert on delivery/dead-letter logs.
  const warnLogs: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnLogs.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    origWarn(...args);
  };

  // ─── Shared test state ────────────────────────────────────────────
  const receivedBodies: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
  // Per-event leading-failure budget: the first N requests for an event id get
  // 500; the rest get 200. No entry (Infinity) => always fail (dead-letter).
  // Deterministic — no time-based race between counting and status flipping.
  const failureBudget = new Map<string, number>();
  const attemptsByEvent = new Map<string, number>();
  let receiver: http.Server | null = null;

  try {
    // ─── Start local webhook receiver ────────────────────────────────
    receiver = http.createServer((req, res) => {
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = v;
      }

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
        receivedBodies.push({ headers, body: parsed });
        res.writeHead(status);
        res.end();
      });
    });

    await new Promise<void>((resolve) => receiver!.listen(0, resolve));
    const addr = receiver.address() as AddressInfo;
    const port = addr.port;

    // ─── Create a user and project with webhook configured ─────────────
    const manager = AppDataSource.manager;
    const user = await manager.save(
      User,
      manager.create(User, {
        email: `webhook-delivery-${Date.now()}@example.com`,
        passwordHash: 'hashed-password',
        displayName: 'Webhook Delivery Test',
      }),
    );
    const project = await manager.save(
      Project,
      manager.create(Project, {
        name: `webhook-delivery-${Date.now()}`,
        ownerId: user.id,
        webhookUrl: `http://127.0.0.1:${port}`,
        webhookSecret: 'test-webhook-secret-for-delivery-test',
        webhookEnabledEvents: ['delivery.test', 'failure.test', 'recovery.test', 'mask.test'],
      }),
    );

    // ─── Test 1: Successful delivery ─────────────────────────────────
    console.log('Test 1: Webhook is successfully delivered to a local receiver');
    const successEvent = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      seq: 1,
      projectId: project.id,
      sessionId: 'session-test-1',
      type: 'delivery.test',
      payload: { message: 'hello world', count: 42 },
      createdAt: new Date().toISOString(),
    };

    failureBudget.set(successEvent.id, 0); // succeed immediately
    const sent = await webhookService.sendWebhook(project.id, successEvent);
    assert.equal(sent, true, 'sendWebhook should return true for a configured project');

    await waitForEventAttempts(receivedBodies, successEvent.id, 1, 2_000);
    const successMatches = receivedBodies.filter((r) => r.body.id === successEvent.id);
    assert.equal(successMatches.length, 1, 'Should receive exactly one delivery on success');

    const delivered = successMatches[0];
    assert.equal(delivered.body.id, successEvent.id);
    assert.equal(delivered.body.type, successEvent.type);
    const payload = delivered.body.payload as Record<string, unknown>;
    assert.equal(payload.message, 'hello world');
    assert.equal(payload.count, 42);
    assert.ok(delivered.body.created_at, 'Should include created_at');
    assert.ok(delivered.headers['x-zz-signature'], 'Should include HMAC signature header');
    assert.ok(
      (delivered.headers['x-zz-signature'] as string).startsWith('sha256='),
      'Signature header should start with sha256=',
    );
    console.log('  ✓ Payload, timestamp, and signature header verified');

    // ─── Test 2: Non-200 response triggers retry then dead-letter ─────
    console.log('Test 2: Non-200 response triggers initial + retries, then dead-letter');
    const failEvent = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      seq: 2,
      projectId: project.id,
      sessionId: 'session-test-2',
      type: 'failure.test',
      payload: { shouldFail: true },
      createdAt: new Date().toISOString(),
    };

    // No budget entry => always 500. With 4 retry delays the client makes
    // 1 initial + 4 retries = 5 total attempts, then dead-letters.
    await webhookService.sendWebhook(project.id, failEvent);

    await waitForEventAttempts(receivedBodies, failEvent.id, 5, 3_000);
    const failMatches = receivedBodies.filter((r) => r.body.id === failEvent.id);
    assert.equal(
      failMatches.length,
      5,
      `Expected 5 total attempts (1 initial + 4 retries); got ${failMatches.length}`,
    );
    // Each retry must carry the same event payload.
    for (const m of failMatches) {
      assert.equal(m.body.id, failEvent.id);
    }
    // Wait for the dead-letter log to flush BEFORE the next test so the
    // retry chain cannot bleed into Test 3's output.
    await waitForDeadLetter(warnLogs, failEvent.id);
    const deadLetterLine = warnLogs.find((l) => l.includes('Dead letter') && l.includes(failEvent.id))!;
    assert.ok(
      /5 total attempts/.test(deadLetterLine),
      `Dead-letter log should state 5 total attempts (initial + retries):\n${deadLetterLine}`,
    );
    console.log('  ✓ 5 attempts (initial + 4 retries) then dead-letter; chain settled before next test');

    // ─── Test 3: Retry recovery — fail N times, then succeed ────────
    console.log('Test 3: Retry recovers after transient failures');
    const recoveryEvent = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      seq: 3,
      projectId: project.id,
      sessionId: 'session-test-3',
      type: 'recovery.test',
      payload: { recoverAfter: 2 },
      createdAt: new Date().toISOString(),
    };

    // Budget 2: requests 1 and 2 get 500, request 3 gets 200. So the client
    // makes exactly 3 attempts = 1 initial + 2 retries (fail 2×, succeed 3rd).
    failureBudget.set(recoveryEvent.id, 2);
    await webhookService.sendWebhook(project.id, recoveryEvent);

    await waitForEventAttempts(receivedBodies, recoveryEvent.id, 3, 3_000);
    // Grace window > max retry delay (100ms) to confirm NO 4th attempt sneaks
    // in (which would mean recovery did not actually settle).
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    const recoveryMatches = receivedBodies.filter((r) => r.body.id === recoveryEvent.id);
    assert.equal(
      recoveryMatches.length,
      3,
      `Expected exactly 3 attempts (1 initial + 2 retries; fail 2× → succeed 3rd); got ${recoveryMatches.length}`,
    );
    console.log('  ✓ 3 attempts (initial + 2 retries): fail 2× then succeed on 3rd');

    // ─── Test 4: Failure logs mask userinfo + query secrets ──────────
    console.log('Test 4: Delivery-failure logs mask userinfo and query secrets');
    const maskEvent = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      seq: 4,
      projectId: project.id,
      sessionId: 'session-test-4',
      type: 'mask.test',
      payload: { masked: true },
      createdAt: new Date().toISOString(),
    };

    // Second project whose webhook URL embeds BOTH userinfo credentials and a
    // query secret. Node's fetch refuses a URL that includes credentials, so
    // delivery fails every attempt and dead-letters — which is exactly what we
    // want: every failure/dead-letter log line must mask the URL (and the fetch
    // error message that echoes it) without leaking the secret values.
    const credProject = await manager.save(
      Project,
      manager.create(Project, {
        name: `webhook-mask-${Date.now()}`,
        ownerId: user.id,
        webhookUrl: `http://leakuser:hunter2@127.0.0.1:${port}/hook?api_key=s3cr3t&ref=x`,
        webhookSecret: 'irrelevant',
        webhookEnabledEvents: ['mask.test'],
      }),
    );

    await webhookService.sendWebhook(credProject.id, maskEvent);
    // Wait for the terminal dead-letter (it carries event.id) so the chain is
    // fully settled before cleanup — no retry timers linger past the test.
    await waitForDeadLetter(warnLogs, maskEvent.id);

    // The secret values must not appear ANYWHERE in the captured warn logs
    // (not in the masked URL field, and not in the appended error message).
    const anyLeak = warnLogs.find(
      (l) => l.includes('hunter2') || l.includes('s3cr3t') || l.includes('api_key=s3cr3t'),
    );
    assert.ok(!anyLeak, `Secret leaked into a failure log:\n${anyLeak}`);

    const maskDeadLetterLine = warnLogs.find((l) => l.includes('Dead letter') && l.includes(maskEvent.id))!;
    assert.ok(maskDeadLetterLine.includes('***@'), `Userinfo should be masked (***@):\n${maskDeadLetterLine}`);
    assert.ok(maskDeadLetterLine.includes('?***'), `Query should be masked (?***):\n${maskDeadLetterLine}`);
    console.log('  ✓ userinfo masked as ***@ and query masked as ?***; no secret in any failure log');

    // ─── Test 5: Unit checks for parseRetryDelays + maskUrl ──────────
    console.log('Test 5: parseRetryDelays + maskUrl edge cases');
    check('parseRetryDelays accepts a clean comma list', () => {
      assert.deepEqual(parseRetryDelays('10,20,50,100'), [10, 20, 50, 100]);
    });
    check('parseRetryDelays falls back on a non-numeric entry', () => {
      assert.deepEqual(parseRetryDelays('abc'), DEFAULT_DELAYS);
      assert.deepEqual(parseRetryDelays('10,abc,30'), DEFAULT_DELAYS);
    });
    check('parseRetryDelays falls back on negative / empty / undefined', () => {
      assert.deepEqual(parseRetryDelays('-5'), DEFAULT_DELAYS);
      assert.deepEqual(parseRetryDelays(''), DEFAULT_DELAYS);
      assert.deepEqual(parseRetryDelays('   '), DEFAULT_DELAYS);
      assert.deepEqual(parseRetryDelays(undefined), DEFAULT_DELAYS);
    });
    check('parseRetryDelays tolerates stray commas and numeric forms', () => {
      assert.deepEqual(parseRetryDelays('10,,20'), [10, 20]);
      assert.deepEqual(parseRetryDelays('1e3'), [1000]);
    });
    check('maskUrl masks userinfo + query, leaves clean URLs intact', () => {
      const masked = maskUrl('http://leakuser:hunter2@127.0.0.1:8080/hook?api_key=s3cr3t');
      assert.ok(masked.includes('***@'), masked);
      assert.ok(masked.includes('?***'), masked);
      assert.ok(!masked.includes('hunter2'), masked);
      assert.ok(!masked.includes('s3cr3t'), masked);
      // A clean URL (no userinfo/query) is not altered beyond normalization.
      const clean = maskUrl('http://127.0.0.1:8080');
      assert.ok(clean.startsWith('http://127.0.0.1:8080'), clean);
      assert.ok(!clean.includes('***'), `clean URL should not be masked: ${clean}`);
    });
    check('maskMessage masks URLs embedded in error text', () => {
      const raw = 'Request cannot be constructed from a URL that includes credentials: http://leakuser:hunter2@127.0.0.1:8080/h?k=s3cr3t';
      const masked = maskMessage(raw);
      assert.ok(!masked.includes('hunter2'), masked);
      assert.ok(!masked.includes('s3cr3t'), masked);
      assert.ok(masked.includes('***@'), masked);
      assert.ok(masked.includes('?***'), masked);
      // A plain HTTP status error (no URL) is left intact for debuggability.
      assert.equal(maskMessage('HTTP 500: Internal Server Error'), 'HTTP 500: Internal Server Error');
    });

    if (failed === 0) {
      console.log('\nAll webhook delivery reliability tests passed');
    }
  } finally {
    console.warn = origWarn;
    await new Promise<void>((resolve) => {
      if (receiver) {
        receiver.close(() => resolve());
      } else {
        resolve();
      }
    });
    await AppDataSource.destroy();
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
