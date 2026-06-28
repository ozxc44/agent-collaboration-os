import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'credential-lifecycle-test-secret';

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
    const owner = await register(baseUrl, 'owner');
    const nonMember = await register(baseUrl, 'nonmember');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Credential Lifecycle Test',
      description: 'Testing rotate/revoke agent API keys',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // Create an agent
    const agentRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'LifecycleAgent',
      description: 'Agent for credential lifecycle testing',
    });
    check('create agent', agentRes.status, 201);
    const agentId = agentRes.data.id;
    const originalApiKey = agentRes.data.api_key;

    // Verify original key works
    const profileWithOriginal = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agentId}`, originalApiKey);
    check('original key works for agent profile', profileWithOriginal.status, 200);

    // ── Rotate Key ────────────────────────────────────────────────────────
    console.log('\n── Rotate Key ──');

    const rotateRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/rotate-key`, owner.token);
    check('rotate returns 200', rotateRes.status, 200);
    check('rotate returns new api_key', typeof rotateRes.data.api_key, 'string');
    check('new key starts with zzk_', rotateRes.data.api_key.startsWith('zzk_'), true);
    check('new key differs from original', rotateRes.data.api_key !== originalApiKey, true);
    check('rotate returns agent id', rotateRes.data.id, agentId);
    check('rotate returns api_key_prefix', typeof rotateRes.data.api_key_prefix, 'string');

    const newApiKey = rotateRes.data.api_key;

    // Old key must fail after rotation
    const oldKeyAfterRotate = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agentId}`, originalApiKey);
    check('old key fails after rotate', oldKeyAfterRotate.status, 401);

    // New key must work after rotation
    const newKeyAfterRotate = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agentId}`, newApiKey);
    check('new key works after rotate', newKeyAfterRotate.status, 200);
    check('new key returns correct agent', newKeyAfterRotate.data.id, agentId);

    // New key works for heartbeat
    const heartbeatWithNew = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', newApiKey, {
      status: 'active',
    });
    check('new key works for heartbeat', heartbeatWithNew.status, 200);

    // Old key fails for heartbeat
    const heartbeatWithOld = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', originalApiKey, {
      status: 'active',
    });
    check('old key fails for heartbeat after rotate', heartbeatWithOld.status, 401);

    // ── Non-member cannot rotate ──────────────────────────────────────────
    console.log('\n── Non-member Rotate Deny ──');

    const nonMemberRotate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/rotate-key`, nonMember.token);
    check('non-member denied rotate', nonMemberRotate.status, 403);

    // ── Agent key cannot rotate itself ────────────────────────────────────
    console.log('\n── Agent Key Cannot Rotate Itself ──');

    const agentSelfRotate = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/rotate-key`, newApiKey);
    check('agent key denied rotate itself', agentSelfRotate.status, 401);

    // ── Revoke Key ────────────────────────────────────────────────────────
    console.log('\n── Revoke Key ──');

    const revokeRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/revoke-key`, owner.token);
    check('revoke returns 200', revokeRes.status, 200);
    check('revoke returns agent id', revokeRes.data.id, agentId);
    check('revoke nullifies api_key_prefix', revokeRes.data.api_key_prefix, null);

    // Revoked key must fail
    const revokedKeyAuth = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agentId}`, newApiKey);
    check('revoked key fails auth', revokedKeyAuth.status, 401);

    // Revoked key fails for heartbeat
    const revokedHeartbeat = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', newApiKey, {
      status: 'active',
    });
    check('revoked key fails heartbeat', revokedHeartbeat.status, 401);

    // ── Non-member cannot revoke ──────────────────────────────────────────
    console.log('\n── Non-member Revoke Deny ──');

    // Rotate first so we have a key to try to revoke
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/rotate-key`, owner.token);
    const nonMemberRevoke = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/revoke-key`, nonMember.token);
    check('non-member denied revoke', nonMemberRevoke.status, 403);

    // ── Agent key cannot revoke itself ────────────────────────────────────
    console.log('\n── Agent Key Cannot Revoke Itself ──');

    // Get current key after rotate
    const agentInfo = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agentId}`, owner.token);
    // We need to get the latest key — but rotate only returns it once.
    // Instead, rotate again to get a fresh key.
    const rotateAgain = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/rotate-key`, owner.token);
    const freshKey = rotateAgain.data.api_key;

    const agentSelfRevoke = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/revoke-key`, freshKey);
    check('agent key denied revoke itself', agentSelfRevoke.status, 401);

    // ── Revoked agent can be rotated back ─────────────────────────────────
    console.log('\n── Revoked Agent Re-activation ──');

    // Revoke the fresh key
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/revoke-key`, owner.token);

    // Rotate to get a new key (re-activate)
    const reActivate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/rotate-key`, owner.token);
    check('rotate after revoke succeeds', reActivate.status, 200);
    check('rotate after revoke returns new key', typeof reActivate.data.api_key, 'string');

    const reactivatedKey = reActivate.data.api_key;
    const reactivatedAuth = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agentId}`, reactivatedKey);
    check('reactivated key works', reactivatedAuth.status, 200);

    // ── Retire Agent (Lifecycle) ──────────────────────────────────────
    console.log('\n── Retire Agent ──');

    // Retire the agent (no superseder) via project-scoped endpoint
    const retireRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agentId}/retire`, owner.token, {});
    check('retire returns 200', retireRes.status, 200);
    check('retire sets lifecycle_status to retired', retireRes.data.lifecycle_status, 'retired');
    check('retire sets status to inactive', retireRes.data.status, 'inactive');
    check('retire sets retired_at', typeof retireRes.data.retired_at, 'string');
    check('retire preserves api_key_prefix', typeof retireRes.data.api_key_prefix, 'string');

    // Retired agent key does NOT work for auth — the auth middleware
    // filters out agents with status INACTIVE (auth.ts line 160).
    // Key hash is preserved but auth is denied at the middleware level.
    const retiredKeyAuth = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agentId}`, reactivatedKey);
    check('retired agent key denied auth (status INACTIVE)', retiredKeyAuth.status, 401);

    // Non-member cannot retire
    const nonMemberRetire = await api(baseUrl, 'POST', `/v1/agents/${agentId}/retire`, nonMember.token, {});
    check('non-member denied retire', nonMemberRetire.status, 403);

    // Cannot retire an already-retired agent (409 Conflict)
    const doubleRetire = await api(baseUrl, 'POST', `/v1/agents/${agentId}/retire`, owner.token, {});
    check('double retire returns 409', doubleRetire.status, 409);

    // ── Supersede Scenario ───────────────────────────────────────────
    console.log('\n── Supersede Agent ──');

    // Create a fresh agent for supersede testing
    const freshAgentRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'OriginalAgent',
      description: 'Will be superseded',
    });
    check('create agent for supersede', freshAgentRes.status, 201);
    const originalAgentId = freshAgentRes.data.id;
    const originalAgentKey = freshAgentRes.data.api_key;

    // Create a replacement agent
    const replacementRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'ReplacementAgent',
      description: 'Supersedes the original',
    });
    check('create replacement agent', replacementRes.status, 201);
    const replacementAgentId = replacementRes.data.id;

    // Supersede original → replacement (root V1 retire endpoint supports SUPERSEDED lifecycle)
    const supersedeRes = await api(baseUrl, 'POST', `/v1/agents/${originalAgentId}/retire`, owner.token, {
      superseded_by: replacementAgentId,
    });
    check('supersede returns 200', supersedeRes.status, 200);
    check('supersede sets lifecycle_status to superseded', supersedeRes.data.lifecycle_status, 'superseded');
    check('supersede sets status to inactive', supersedeRes.data.status, 'inactive');
    check('supersede sets superseded_by_agent_id', supersedeRes.data.superseded_by_agent_id, replacementAgentId);
    check('supersede sets retired_at', typeof supersedeRes.data.retired_at, 'string');

    // Superseded agent's old key must be denied for profile and heartbeat
    const supersededProfile = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${originalAgentId}`, originalAgentKey);
    check('superseded agent old key denied profile', supersededProfile.status, 401);

    const supersededHeartbeat = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', originalAgentKey, {
      status: 'active',
    });
    check('superseded agent old key denied heartbeat', supersededHeartbeat.status, 401);

    // Verify superseded agent appears in agent list with correct lifecycle
    const agentList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents`, owner.token);
    check('agent list returns 200', agentList.status, 200);
    const supersededAgent = (agentList.data.data as any[]).find((a: any) => a.id === originalAgentId);
    check('superseded agent in list', supersededAgent !== undefined, true);
    if (supersededAgent) {
      check('list shows superseded lifecycle', supersededAgent.lifecycle_status, 'superseded');
      check('list shows superseded_by_agent_id', supersededAgent.superseded_by_agent_id, replacementAgentId);
    }

    // Cannot supersede with an inactive replacement (root V1 validates replacement activity)
    const inactiveReplacement = await api(baseUrl, 'POST', `/v1/agents/${replacementAgentId}/retire`, owner.token, {
      superseded_by: originalAgentId,
    });
    check('supersede with inactive replacement returns 409', inactiveReplacement.status, 409);

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
    password: 'CredLifecycle123!',
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
