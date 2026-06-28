import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'auth-username-login-test-secret';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const timestamp = Date.now();
    const email = `username-login-${timestamp}@example.invalid`;
    const password = 'UsernameLogin123!';
    const displayName = 'Username Login Test';

    // ── Register returns a real username ──────────────────────────────────
    const registerRes = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
      email,
      password,
      display_name: displayName,
    });
    assert.equal(registerRes.status, 201, `register failed: ${JSON.stringify(registerRes.data)}`);
    assert.equal(typeof registerRes.data.access_token, 'string');
    const derivedUsername = registerRes.data.user.username;
    assert.notEqual(derivedUsername, email, 'expected real username, got email fallback');
    assert.equal(derivedUsername, 'username-login-test');
    console.log(`PASS: register derived username "${derivedUsername}"`);

    // ── Login with username works ─────────────────────────────────────────
    const usernameLoginRes = await api(baseUrl, 'POST', '/v1/auth/token', undefined, {
      username: derivedUsername,
      password,
    });
    assert.equal(usernameLoginRes.status, 200, `username login failed: ${JSON.stringify(usernameLoginRes.data)}`);
    assert.equal(typeof usernameLoginRes.data.access_token, 'string');
    assert.equal(usernameLoginRes.data.user.username, derivedUsername);
    console.log('PASS: login with username returns 200 + token');

    // ── Login with email still works ──────────────────────────────────────
    const emailLoginRes = await api(baseUrl, 'POST', '/v1/auth/token', undefined, {
      email,
      password,
    });
    assert.equal(emailLoginRes.status, 200, `email login failed: ${JSON.stringify(emailLoginRes.data)}`);
    assert.equal(typeof emailLoginRes.data.access_token, 'string');
    assert.equal(emailLoginRes.data.user.username, derivedUsername);
    console.log('PASS: login with email still returns 200 + token');

    // ── Missing identifier is rejected ────────────────────────────────────
    const missingRes = await api(baseUrl, 'POST', '/v1/auth/token', undefined, {
      password,
    });
    assert.equal(missingRes.status, 422);
    console.log('PASS: missing identifier returns 422');

    // ── Wrong username is rejected with 401 (no leak) ─────────────────────
    const wrongUserRes = await api(baseUrl, 'POST', '/v1/auth/token', undefined, {
      username: 'definitely-not-a-user',
      password,
    });
    assert.equal(wrongUserRes.status, 401);
    console.log('PASS: wrong username returns 401');

    console.log('auth-username-login tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
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
