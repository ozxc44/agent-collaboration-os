import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'user-search-test-secret';

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
    // Register two users with distinctive display names
    const alice = await register(baseUrl, 'alice-smith');
    const bob = await register(baseUrl, 'bob-jones');

    // ── Test 1: auth required ────────────────────────────────────────────
    {
      const res = await api(baseUrl, 'GET', '/v1/users/search?q=alice');
      assert.equal(res.status, 401);
      const body = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      assert.equal(body.detail, 'Missing Authorization header');
      console.log('PASS: auth required returns 401');
    }

    // ── Test 2: short query validation ───────────────────────────────────
    {
      const res = await api(baseUrl, 'GET', '/v1/users/search?q=a', alice.token);
      assert.equal(res.status, 422);
      const body = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      assert.equal(body.detail[0].msg.includes('at least 2 characters'), true);
      console.log('PASS: short query returns 422');
    }

    // ── Test 3: missing query parameter ──────────────────────────────────
    {
      const res = await api(baseUrl, 'GET', '/v1/users/search', alice.token);
      assert.equal(res.status, 422);
      console.log('PASS: missing query returns 422');
    }

    // ── Test 4: positive search by email ─────────────────────────────────
    {
      const res = await api(baseUrl, 'GET', `/v1/users/search?q=${encodeURIComponent('@example')}`, alice.token);
      assert.equal(res.status, 200);
      const body = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      assert.equal(Array.isArray(body.data), true);
      assert.equal(body.data.length >= 2, true, `expected >=2 users, got ${body.data.length}`);
      console.log(`PASS: email search returns ${body.data.length} users`);
    }

    // ── Test 5: positive search by display_name ──────────────────────────
    {
      const res = await api(baseUrl, 'GET', '/v1/users/search?q=alice', alice.token);
      assert.equal(res.status, 200);
      const body = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      assert.equal(Array.isArray(body.data), true);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].display_name, 'alice-smith');
      console.log('PASS: display_name search finds alice');
    }

    // ── Test 6: case-insensitive search ──────────────────────────────────
    {
      const res = await api(baseUrl, 'GET', '/v1/users/search?q=ALICE', alice.token);
      assert.equal(res.status, 200);
      const body = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].display_name, 'alice-smith');
      console.log('PASS: case-insensitive search works');
    }

    // ── Test 7: no results for non-matching query ────────────────────────
    {
      const res = await api(baseUrl, 'GET', '/v1/users/search?q=zznonexistent', alice.token);
      assert.equal(res.status, 200);
      const body = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      assert.equal(body.data.length, 0);
      console.log('PASS: non-matching query returns empty array');
    }

    // ── Test 8: limit parameter ──────────────────────────────────────────
    {
      const res = await api(baseUrl, 'GET', '/v1/users/search?q=ex&limit=1', alice.token);
      assert.equal(res.status, 200);
      const body = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      assert.equal(body.data.length, 1);
      console.log('PASS: limit parameter works');
    }

    // ── Test 9: no password_hash leakage ─────────────────────────────────
    {
      const res = await api(baseUrl, 'GET', '/v1/users/search?q=alice', alice.token);
      assert.equal(res.status, 200);
      const body = typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      const user = body.data[0];
      assert.equal(user.password_hash, undefined);
      assert.equal(user.passwordHash, undefined);
      // Ensure only safe fields are present
      assert.equal(typeof user.id, 'string');
      assert.equal(typeof user.email, 'string');
      assert.equal(typeof user.display_name, 'string');
      assert.equal(typeof user.created_at, 'string');
      console.log('PASS: no password_hash leakage');
    }

    console.log('user-search tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'UserSearchTest123!',
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
