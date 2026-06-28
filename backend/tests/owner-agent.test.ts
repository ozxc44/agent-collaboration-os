import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'owner-agent-test-secret';

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
    // ── Setup users ───────────────────────────────────────────────────────
    const owner = await register(baseUrl, 'owner');
    const viewer = await register(baseUrl, 'viewer');
    const nonMember = await register(baseUrl, 'nonmember');

    // Owner creates a project
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Owner Agent Test Project',
      description: 'Testing owner-agent binding',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // Add viewer as a viewer member
    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    check('add viewer member', addViewer.status, 201);

    // Owner creates an agent
    const agentRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'TestAgent',
      description: 'Agent for owner binding testing',
    });
    check('create agent', agentRes.status, 201);
    const agentId = agentRes.data.id;

    // Non-owner creates their own agent in a different project
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', nonMember.token, {
      name: 'Other Project',
      description: 'Other project',
      visibility: 'public',
    });
    check('create other project', otherProject.status, 201);
    const otherProjectId = otherProject.data.id;

    const otherAgentRes = await api(baseUrl, 'POST', `/v1/projects/${otherProjectId}/agents`, nonMember.token, {
      name: 'OtherAgent',
      description: 'Other agent',
    });
    check('create other agent', otherAgentRes.status, 201);
    const otherAgentId = otherAgentRes.data.id;

    // ── Test 1: auth/me includes owner_agent_id (initially null) ──────────
    console.log('\n── auth/me field ──');
    const meBefore = await api(baseUrl, 'GET', '/v1/auth/me', owner.token);
    check('auth/me returns 200', meBefore.status, 200);
    check('auth/me has owner_agent_id', 'owner_agent_id' in meBefore.data, true);
    check('auth/me owner_agent_id initially null', meBefore.data.owner_agent_id, null);

    // ── Test 2: GET /v1/users/me/owner-agent returns 404 when not bound ───
    console.log('\n── GET owner-agent not bound ──');
    const notBound = await api(baseUrl, 'GET', '/v1/users/me/owner-agent', owner.token);
    check('not bound returns 404', notBound.status, 404);

    // ── Test 3: Bind agent ────────────────────────────────────────────────
    console.log('\n── Bind agent ──');
    const bindRes = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', owner.token, {
      agent_id: agentId,
    });
    check('bind returns 200', bindRes.status, 200);
    check('bind returns owner_agent_id', bindRes.data.owner_agent_id, agentId);

    // Bound agent should receive owner_agent_bound inbox item
    const boundInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', agentRes.data.api_key);
    check('bound inbox returns 200', boundInbox.status, 200);
    const boundEvent = boundInbox.data.data.find((item: any) => item.event_type === 'owner_agent_bound');
    check('owner_agent_bound inbox item exists', Boolean(boundEvent), true);
    check('owner_agent_bound has user_id payload', boundEvent?.payload?.user_id, owner.userId);

    // auth/me now reflects binding
    const meAfterBind = await api(baseUrl, 'GET', '/v1/auth/me', owner.token);
    check('auth/me after bind', meAfterBind.data.owner_agent_id, agentId);

    // GET owner-agent returns agent without api_key
    const boundAgent = await api(baseUrl, 'GET', '/v1/users/me/owner-agent', owner.token);
    check('get bound agent returns 200', boundAgent.status, 200);
    check('bound agent has id', boundAgent.data.id, agentId);
    check('bound agent has name', boundAgent.data.name, 'TestAgent');
    check('bound agent no api_key', 'api_key' in boundAgent.data, false);
    check('bound agent has api_key_prefix', typeof boundAgent.data.api_key_prefix, 'string');

    // ── Test 4: Unbind agent ──────────────────────────────────────────────
    console.log('\n── Unbind agent ──');
    const unbindRes = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', owner.token, {
      agent_id: null,
    });
    check('unbind returns 200', unbindRes.status, 200);
    check('unbind returns null', unbindRes.data.owner_agent_id, null);

    // Previously bound agent should receive owner_agent_unbound inbox item
    const unboundInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', agentRes.data.api_key);
    check('unbound inbox returns 200', unboundInbox.status, 200);
    const unboundEvent = unboundInbox.data.data.find((item: any) => item.event_type === 'owner_agent_unbound');
    check('owner_agent_unbound inbox item exists', Boolean(unboundEvent), true);
    check('owner_agent_unbound has user_id payload', unboundEvent?.payload?.user_id, owner.userId);

    const meAfterUnbind = await api(baseUrl, 'GET', '/v1/auth/me', owner.token);
    check('auth/me after unbind', meAfterUnbind.data.owner_agent_id, null);

    const notBoundAfter = await api(baseUrl, 'GET', '/v1/users/me/owner-agent', owner.token);
    check('not bound after unbind returns 404', notBoundAfter.status, 404);

    // ── Test 5: Viewer cannot bind someone else's agent ───────────────────
    console.log('\n── Viewer binding denied ──');
    const viewerBind = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', viewer.token, {
      agent_id: agentId,
    });
    check('viewer denied bind', viewerBind.status, 403);

    // ── Test 6: Non-member cannot bind someone else's agent ───────────────
    console.log('\n── Non-member binding denied ──');
    const nonMemberBind = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', nonMember.token, {
      agent_id: agentId,
    });
    check('non-member denied bind', nonMemberBind.status, 403);

    // ── Test 7: Bind non-existent agent returns 404 ───────────────────────
    console.log('\n── Bind non-existent agent ──');
    const bindNonExistent = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', owner.token, {
      agent_id: '00000000-0000-0000-0000-000000000000',
    });
    check('bind non-existent agent returns 404', bindNonExistent.status, 404);

    // ── Test 8: Creator can bind their own agent even as member ───────────
    console.log('\n── Creator binding ──');
    // Owner is the creator, re-bind should work
    const creatorBind = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', owner.token, {
      agent_id: agentId,
    });
    check('creator can bind own agent', creatorBind.status, 200);

    // ── Test 9: Bound agent deleted → GET returns 404 ─────────────────────
    console.log('\n── Bound agent deleted ──');
    // Soft-delete the agent (mark inactive)
    const deleteAgent = await api(baseUrl, 'DELETE', `/v1/agents/${agentId}`, owner.token);
    check('delete agent returns 204', deleteAgent.status, 204);

    const boundDeleted = await api(baseUrl, 'GET', '/v1/users/me/owner-agent', owner.token);
    check('bound deleted agent returns 404', boundDeleted.status, 404);

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
    password: 'OwnerAgentTest123!',
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
