import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'webhook-security-test-secret';
process.env.WEBHOOK_SECRET = 'test-webhook-secret-32chars-long!!';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const webhookSecret = process.env.WEBHOOK_SECRET!;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  function makeSignature(timestamp: string, body: object): string {
    const sig = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${JSON.stringify(body)}`)
      .digest('hex');
    return `sha256=${sig}`;
  }

  try {
    // ─── Test 1: Valid signature is accepted ──────────────────────────────
    console.log('Test 1: Valid signature is accepted');
    const validBody = { event: 'test', payload: { session_id: 's1' } };
    const validSig = makeSignature(timestamp, validBody);
    const validRes = await fetch(`${baseUrl}/v1/projects/p1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZZ-Signature': validSig,
        'X-ZZ-Timestamp': timestamp,
      },
      body: JSON.stringify(validBody),
    });
    // 201 or 200 means signature was accepted (event publishing may fail if session doesn't exist)
    assert(
      validRes.status === 200 || validRes.status === 201,
      `Expected 200/201 for valid signature, got ${validRes.status}`,
    );

    // ─── Test 2: Invalid signature is rejected with 401 ───────────────────
    console.log('Test 2: Invalid signature is rejected with 401');
    const invalidBody = { event: 'test', payload: { session_id: 's1' } };
    const wrongSig = `sha256=${'a'.repeat(64)}`;
    const invalidRes = await fetch(`${baseUrl}/v1/projects/p1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZZ-Signature': wrongSig,
        'X-ZZ-Timestamp': timestamp,
      },
      body: JSON.stringify(invalidBody),
    });
    assert.equal(invalidRes.status, 401, 'Invalid signature should return 401');
    const invalidData = (await invalidRes.json()) as { detail?: string };
    assert.equal(invalidData.detail, 'Invalid signature');

    // ─── Test 3: Malformed signature (bad hex) is rejected with 401 ─────────
    console.log('Test 3: Malformed signature (non-hex) is rejected with 401');
    const malformedBody = { event: 'test', payload: { session_id: 's1' } };
    const malformedRes = await fetch(`${baseUrl}/v1/projects/p1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZZ-Signature': 'sha256=notvalidhex!@#$%^&*()',
        'X-ZZ-Timestamp': timestamp,
      },
      body: JSON.stringify(malformedBody),
    });
    assert.equal(malformedRes.status, 401, 'Malformed signature should return 401');
    const malformedData = (await malformedRes.json()) as { detail?: string };
    assert.equal(malformedData.detail, 'Invalid signature format');

    // ─── Test 4: Wrong-length signature is rejected with 401 ───────────────
    console.log('Test 4: Wrong-length signature is rejected with 401');
    const shortBody = { event: 'test', payload: { session_id: 's1' } };
    const shortRes = await fetch(`${baseUrl}/v1/projects/p1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZZ-Signature': 'sha256=abc123',
        'X-ZZ-Timestamp': timestamp,
      },
      body: JSON.stringify(shortBody),
    });
    assert.equal(shortRes.status, 401, 'Short signature should return 401');
    const shortData = (await shortRes.json()) as { detail?: string };
    assert.equal(shortData.detail, 'Invalid signature format');

    // ─── Test 5: Missing signature header returns 401 ─────────────────────
    console.log('Test 5: Missing signature header returns 401');
    const noSigBody = { event: 'test', payload: { session_id: 's1' } };
    const noSigRes = await fetch(`${baseUrl}/v1/projects/p1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZZ-Timestamp': timestamp,
      },
      body: JSON.stringify(noSigBody),
    });
    assert.equal(noSigRes.status, 401, 'Missing signature should return 401');

    // ─── Test 6: Missing timestamp header returns 401 ─────────────────────
    console.log('Test 6: Missing timestamp header returns 401');
    const noTsBody = { event: 'test', payload: { session_id: 's1' } };
    const noTsSig = makeSignature(timestamp, noTsBody);
    const noTsRes = await fetch(`${baseUrl}/v1/projects/p1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZZ-Signature': noTsSig,
      },
      body: JSON.stringify(noTsBody),
    });
    assert.equal(noTsRes.status, 401, 'Missing timestamp should return 401');

    // ─── Test 7: Production mode with empty webhook secret fails closed ────
    console.log('Test 7: Production mode with empty secret fails closed');

    // Override WEBHOOK_SECRET to empty for this test
    const originalEnv = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = '';

    const prodServer = http.createServer(app);
    await new Promise<void>((resolve) => prodServer.listen(0, resolve));
    const prodAddr = prodServer.address();
    assert(prodAddr && typeof prodAddr === 'object');
    const prodBaseUrl = `http://127.0.0.1:${prodAddr.port}`;

    // Start with NODE_ENV=production
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const prodEmptyBody = { event: 'test', payload: { session_id: 's1' } };
    const prodEmptyRes = await fetch(`${prodBaseUrl}/v1/projects/p1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ZZ-Signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        'X-ZZ-Timestamp': timestamp,
      },
      body: JSON.stringify(prodEmptyBody),
    });
    assert.equal(prodEmptyRes.status, 500, 'Empty webhook secret in production should return 500');
    const prodEmptyData = (await prodEmptyRes.json()) as { detail?: string };
    assert.equal(prodEmptyData.detail, 'Webhook misconfigured');

    process.env.NODE_ENV = originalNodeEnv;
    process.env.WEBHOOK_SECRET = originalEnv!;
    await new Promise<void>((resolve) => prodServer.close(() => resolve()));

    console.log('All webhook security tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
