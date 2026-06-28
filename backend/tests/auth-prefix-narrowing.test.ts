import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'auth-prefix-narrowing-test-secret';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

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
    // ── Setup ─────────────────────────────────────────────────────────────
    const owner = await register(baseUrl, 'prefix-owner');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Auth Prefix Narrowing Test',
      description: 'Verify prefix-based agent auth narrowing',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // Create two agents and capture their keys/prefixes
    const agent1Res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'PrefixAgent1',
    });
    check('create agent 1', agent1Res.status, 201);
    check('agent 1 has api_key_prefix', typeof agent1Res.data.api_key_prefix, 'string');
    check('agent 1 prefix is 8 chars', agent1Res.data.api_key_prefix.length, 8);
    const agent1Id = agent1Res.data.id;
    const agent1Key = agent1Res.data.api_key;
    const agent1Prefix = agent1Res.data.api_key_prefix;

    const agent2Res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'PrefixAgent2',
    });
    check('create agent 2', agent2Res.status, 201);
    check('agent 2 has api_key_prefix', typeof agent2Res.data.api_key_prefix, 'string');
    const agent2Id = agent2Res.data.id;
    const agent2Key = agent2Res.data.api_key;
    const agent2Prefix = agent2Res.data.api_key_prefix;

    // ── Verify each key works for its own agent ──────────────────────────
    console.log('\n── Own-key auth works ──');

    const profile1 = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, agent1Key);
    check('agent 1 key works for agent 1 profile', profile1.status, 200);
    check('agent 1 profile returns correct id', profile1.data.id, agent1Id);

    const profile2 = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent2Id}`, agent2Key);
    check('agent 2 key works for agent 2 profile', profile2.status, 200);
    check('agent 2 profile returns correct id', profile2.data.id, agent2Id);

    // ── Each key is rejected for the other agent's profile (different prefix) ──
    console.log('\n── Cross-agent key deny ──');

    const cross1 = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent2Id}`, agent1Key);
    check('agent 1 key denied for agent 2 profile', cross1.status, 403);

    const cross2 = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, agent2Key);
    check('agent 2 key denied for agent 1 profile', cross2.status, 403);

    // ── Prefix values are distinct ─────────────────────────────────────────
    console.log('\n── Prefix distinctness ──');

    // It's possible (though astronomically unlikely) that two random UUIDs
    // produce the same 8-char prefix. If this fails, the test can be re-run.
    check('agents have different prefixes', agent1Prefix !== agent2Prefix, true);

    // ── Prefix is reflected in the GET agent response ──────────────────────
    console.log('\n── Prefix persistence in API ──');

    const get1 = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, owner.token);
    check('GET agent 1 shows api_key_prefix', get1.data.api_key_prefix, agent1Prefix);

    // ── Heartbeat auth works with own key ──────────────────────────────────
    console.log('\n── Heartbeat auth ──');

    const hb1 = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', agent1Key, { status: 'active' });
    check('agent 1 heartbeat with own key', hb1.status, 200);
    check('heartbeat returns agent 1 id', hb1.data.agent_id, agent1Id);

    const hb2 = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', agent2Key, { status: 'active' });
    check('agent 2 heartbeat with own key', hb2.status, 200);
    check('heartbeat returns agent 2 id', hb2.data.agent_id, agent2Id);

    // ── Prefix narrowing avoids unrelated bcrypt work ───────────────────────
    console.log('\n── Prefix narrows bcrypt comparisons ──');

    const bcryptModule = require('bcryptjs') as any;
    const originalCompare = bcryptModule.compare;
    let compareCount = 0;
    bcryptModule.compare = async (...args: any[]) => {
      compareCount++;
      return originalCompare(...args);
    };

    try {
      compareCount = 0;
      const narrowedAuth = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', agent2Key, { status: 'active' });
      check('narrowed auth still succeeds', narrowedAuth.status, 200);
      check('valid key compares only matching prefix candidate', compareCount, 1);

      compareCount = 0;
      const wrongPrefixKey = 'zzk_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      const wrongPrefixAuth = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', wrongPrefixKey, { status: 'active' });
      check('wrong-prefix key is rejected', wrongPrefixAuth.status, 401);
      check('wrong-prefix key compares no unrelated hashes', compareCount, 0);
    } finally {
      bcryptModule.compare = originalCompare;
    }

    // ── Revoke clears prefix in response ───────────────────────────────────
    console.log('\n── Revoke clears prefix ──');

    const revokeRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agent1Id}/revoke-key`, owner.token);
    check('revoke returns 200', revokeRes.status, 200);
    check('revoke nullifies api_key_prefix', revokeRes.data.api_key_prefix, null);

    // Verify revoked key is rejected
    const revokedAttempt = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, agent1Key);
    check('revoked key fails auth', revokedAttempt.status, 401);

    // ── Rotate restores prefix with new value ──────────────────────────────
    console.log('\n── Rotate restores prefix ──');

    const rotateRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agent1Id}/rotate-key`, owner.token);
    check('rotate returns 200', rotateRes.status, 200);
    check('rotate restores api_key_prefix', typeof rotateRes.data.api_key_prefix, 'string');
    check('rotate new prefix is 8 chars', rotateRes.data.api_key_prefix.length, 8);

    const rotatedKey = rotateRes.data.api_key;
    const rotatedPrefix = rotateRes.data.api_key_prefix;

    // New key works after rotate
    const rotatedAuth = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, rotatedKey);
    check('rotated key works', rotatedAuth.status, 200);

    // ── Agent 2's key still works (unaffected by agent 1's rotate/revoke) ─
    console.log('\n── Agent isolation after rotate/revoke ──');

    const hb2After = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', agent2Key, { status: 'active' });
    check('agent 2 heartbeat still works after agent 1 revoke/rotate', hb2After.status, 200);

    // ── Verify the prefix returned in GET matches the rotated prefix ───────
    const getRotated = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, owner.token);
    check('GET after rotate shows new prefix', getRotated.data.api_key_prefix, rotatedPrefix);

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) {
      process.exit(1);
    }
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
    password: 'AuthPrefix123!',
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

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
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
