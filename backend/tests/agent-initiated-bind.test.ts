import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agent-bind-test-secret';

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
    // ── Setup ───────────────────────────────────────────────────────────
    const human = await register(baseUrl, 'human');
    const otherUser = await register(baseUrl, 'other');

    const project = await api(baseUrl, 'POST', '/v1/projects', human.token, {
      name: 'Agent Bind Test',
      description: 'Testing agent-initiated binding',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // Create agent via API (returns api_key once)
    const agentRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, human.token, {
      name: 'BindTestAgent',
      description: 'Agent for binding test',
    });
    check('create agent', agentRes.status, 201);
    const agentId = agentRes.data.id;
    const agentKey = agentRes.data.api_key;

    // ── Test 1: Agent initiates binding by email ────────────────────────
    console.log('\n── Agent-initiated bind by email ──');
    const bindReq = await apiWithKey(baseUrl, 'POST', '/v1/agent/request-owner-bind', agentKey, {
      target_user_email: human.email,
    });
    check('agent bind request returns 201', bindReq.status, 201);
    check('request type is owner_agent_bind', bindReq.data.request_type, 'owner_agent_bind');
    check('status is pending_owner', bindReq.data.status, 'pending_owner');
    check('requested_by_user_id is null (agent-initiated)', bindReq.data.requested_by_user_id, null);
    check('target_agent_id is the requesting agent', bindReq.data.target_agent_id, agentId);
    check('target_user_id is the human user', bindReq.data.target_user_id, human.userId);
    const requestId = bindReq.data.id;

    // ── Test 2: Duplicate request returns 409 ───────────────────────────
    console.log('\n── Duplicate bind request ──');
    const dupReq = await apiWithKey(baseUrl, 'POST', '/v1/agent/request-owner-bind', agentKey, {
      target_user_email: human.email,
    });
    check('duplicate returns 409', dupReq.status, 409);

    // ── Test 3: Already bound returns 409 ───────────────────────────────
    // First approve the request, then try again
    console.log('\n── Human approves agent-initiated bind ──');
    const approveRes = await api(baseUrl, 'POST', `/v1/requests/${requestId}/approve`, human.token);
    check('approve returns 200', approveRes.status, 200);
    check('status is approved', approveRes.data.status, 'approved');

    // Verify binding took effect
    const meAfter = await api(baseUrl, 'GET', '/v1/auth/me', human.token);
    check('auth/me shows bound agent', meAfter.data.owner_agent_id, agentId);

    // Already bound → 409
    console.log('\n── Already bound returns 409 ──');
    const alreadyBound = await apiWithKey(baseUrl, 'POST', '/v1/agent/request-owner-bind', agentKey, {
      target_user_email: human.email,
    });
    check('already bound returns 409', alreadyBound.status, 409);

    // ── Test 4: Agent receives inbox notification on approval ───────────
    console.log('\n── Agent inbox notification on approval ──');
    const inbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', agentKey);
    check('inbox returns 200', inbox.status, 200);
    const bindApproved = inbox.data.data.find((item: any) =>
      item.event_type === 'owner_agent_bound' &&
      item.payload?.collaboration_request_id === requestId
    );
    check('owner_agent_bound inbox item exists', Boolean(bindApproved), true);

    // ── Test 5: Human can list pending bind requests ────────────────────
    console.log('\n── Human can list bind requests ──');
    // Unbind first, create new request
    await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', human.token, { agent_id: null });

    const bindReq2 = await apiWithKey(baseUrl, 'POST', '/v1/agent/request-owner-bind', agentKey, {
      target_user_id: human.userId,
    });
    check('second bind request by user_id', bindReq2.status, 201);

    // Human lists requests filtering for owner_agent_bind
    const listRes = await api(baseUrl, 'GET', '/v1/requests?request_type=owner_agent_bind&status=pending_owner', human.token);
    check('list requests returns 200', listRes.status, 200);
    const pendingBind = listRes.data.data.find((r: any) => r.id === bindReq2.data.id);
    check('pending bind request visible to human', Boolean(pendingBind), true);
    check('pending bind has correct target_user_id', pendingBind?.target_user_id, human.userId);

    // ── Test 6: Other user cannot approve agent-initiated bind ──────────
    console.log('\n── Non-target user cannot approve ──');
    const otherApprove = await api(baseUrl, 'POST', `/v1/requests/${bindReq2.data.id}/approve`, otherUser.token);
    check('other user denied approve', otherApprove.status, 403);

    // ── Test 7: Human rejects agent-initiated bind ──────────────────────
    console.log('\n── Human rejects agent-initiated bind ──');
    const rejectRes = await api(baseUrl, 'POST', `/v1/requests/${bindReq2.data.id}/reject`, human.token);
    check('reject returns 200', rejectRes.status, 200);
    check('status is rejected', rejectRes.data.status, 'rejected');

    // Verify binding did NOT happen
    const meAfterReject = await api(baseUrl, 'GET', '/v1/auth/me', human.token);
    check('auth/me still null after reject', meAfterReject.data.owner_agent_id, null);

    // ── Test 8: Agent-initiated by user_id works ────────────────────────
    console.log('\n── Agent-initiated bind by user_id ──');
    const bindById = await apiWithKey(baseUrl, 'POST', '/v1/agent/request-owner-bind', agentKey, {
      target_user_id: human.userId,
    });
    check('bind by user_id returns 201', bindById.status, 201);

    // ── Test 9: Nonexistent user returns 404 ────────────────────────────
    console.log('\n── Nonexistent user ──');
    const notFound = await apiWithKey(baseUrl, 'POST', '/v1/agent/request-owner-bind', agentKey, {
      target_user_email: 'nonexistent@example.invalid',
    });
    check('nonexistent user returns 404', notFound.status, 404);

    // ── Test 10: No email/user_id returns 404 ───────────────────────────
    console.log('\n── Missing identifiers ──');
    const noId = await apiWithKey(baseUrl, 'POST', '/v1/agent/request-owner-bind', agentKey, {});
    check('missing identifiers returns 404', noId.status, 404);

    // ── Test 11: Unauth cannot access endpoint ──────────────────────────
    console.log('\n── Unauthenticated access ──');
    const unauth = await api(baseUrl, 'POST', '/v1/agent/request-owner-bind', undefined, {
      target_user_email: human.email,
    });
    check('unauth returns 401', unauth.status, 401);

    // ── Test 12: Existing human-initiated bind still works ──────────────
    console.log('\n── Existing human-initiated bind compatibility ──');
    // Clean up previous request first
    await apiWithKey(baseUrl, 'POST', `/v1/requests/${bindById.data.id}/reject`, agentKey);

    const humanBind = await api(baseUrl, 'POST', '/v1/requests', human.token, {
      request_type: 'owner_agent_bind',
      target_agent_id: agentId,
    });
    check('human-initiated bind returns 201', humanBind.status, 201);
    check('human-initiated status is pending_agent', humanBind.data.status, 'pending_agent');
    check('human-initiated has requested_by_user_id', humanBind.data.requested_by_user_id, human.userId);

    // Agent approves human-initiated request
    const agentApprove = await apiWithKey(baseUrl, 'POST', `/v1/requests/${humanBind.data.id}/approve`, agentKey);
    check('agent approves human-initiated bind', agentApprove.status, 200);
    check('agent-approved status', agentApprove.data.status, 'approved');

    const meFinal = await api(baseUrl, 'GET', '/v1/auth/me', human.token);
    check('human-initiated binding works', meFinal.data.owner_agent_id, agentId);

    // ── Summary ─────────────────────────────────────────────────────────
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

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string; email: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'AgentBindTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
    email,
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
