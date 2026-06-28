import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agent-identity-test-secret';

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
    const otherUser = await register(baseUrl, 'other');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Agent Identity Test',
      description: 'Testing agent identity, lifecycle, and main-agent switch',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // ── 1. Duplicate names get distinct identity labels/codes ────────────────
    console.log('\n── Duplicate Name Identity Codes ──');

    const agent1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'DuplicateAgent',
    });
    check('agent1 created', agent1.status, 201);
    check('agent1 has identity_code', typeof agent1.data.identity_code, 'string');
    check('agent1 has display_label with code', agent1.data.display_label.includes('['), true);
    check('agent1 lifecycle active', agent1.data.lifecycle_status, 'active');
    check('agent1 owner_user_id set', agent1.data.owner_user_id, owner.userId);

    const agent2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'DuplicateAgent',
    });
    check('agent2 created', agent2.status, 201);
    check('agent2 has identity_code', typeof agent2.data.identity_code, 'string');
    check('agent1 and agent2 codes differ', agent1.data.identity_code !== agent2.data.identity_code, true);
    check('agent2 lifecycle active', agent2.data.lifecycle_status, 'active');

    const agent1Id = agent1.data.id;
    const agent2Id = agent2.data.id;
    const agent1Key = agent1.data.api_key;
    const agent2Key = agent2.data.api_key;

    // ── 2. Owner can list their agents ──────────────────────────────────────
    console.log('\n── Owner Lists Agents ──');

    const myAgents = await api(baseUrl, 'GET', '/v1/users/me/agents', owner.token);
    check('list my agents returns 200', myAgents.status, 200);
    check('my agents has data array', Array.isArray(myAgents.data.data), true);
    const ownedIds = myAgents.data.data.map((a: any) => a.id);
    check('owner sees agent1', ownedIds.includes(agent1Id), true);
    check('owner sees agent2', ownedIds.includes(agent2Id), true);
    check('my agents no api_key', myAgents.data.data.every((a: any) => a.api_key === undefined), true);

    // Other user should not see owner's agents
    const otherAgents = await api(baseUrl, 'GET', '/v1/users/me/agents', otherUser.token);
    check('other user sees no agents', otherAgents.data.data.length, 0);

    // ── 3. Lost-key recovery: owner rotates key, old key fails ──────────────
    console.log('\n── Lost-Key Recovery via Rotate ──');

    const rotateRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents/${agent1Id}/rotate-key`, owner.token);
    check('rotate returns 200', rotateRes.status, 200);
    check('rotate returns new api_key', typeof rotateRes.data.api_key, 'string');
    const newKey = rotateRes.data.api_key;

    // Old key fails
    const oldKeyAuth = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, agent1Key);
    check('old key fails after rotate', oldKeyAuth.status, 401);

    // New key works
    const newKeyAuth = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, newKey);
    check('new key works after rotate', newKeyAuth.status, 200);

    // ── 4. Retire/supersede: retired agent not dispatchable ─────────────────
    console.log('\n── Retire and Supersede ──');

    // Make agent2 online first
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', agent2Key, { status: 'active' });

    // Retire agent2 (no replacement)
    const retireRes = await api(baseUrl, 'POST', `/v1/agents/${agent2Id}/retire`, owner.token);
    check('retire returns 200', retireRes.status, 200);
    check('retired lifecycle_status', retireRes.data.lifecycle_status, 'retired');
    check('retired_at is set', retireRes.data.retired_at !== null, true);
    check('retired not superseded', retireRes.data.superseded_by_agent_id, null);

    // Double retire rejected
    const doubleRetire = await api(baseUrl, 'POST', `/v1/agents/${agent2Id}/retire`, owner.token);
    check('double retire rejected 409', doubleRetire.status, 409);

    // Create a replacement agent and supersede agent1
    const agent3 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'ReplacementAgent',
    });
    check('agent3 created', agent3.status, 201);
    const agent3Id = agent3.data.id;
    const agent3Key = agent3.data.api_key;

    // Make agent3 online
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', agent3Key, { status: 'active' });

    const supersedeRes = await api(baseUrl, 'POST', `/v1/agents/${agent1Id}/retire`, owner.token, {
      superseded_by: agent3Id,
    });
    check('supersede returns 200', supersedeRes.status, 200);
    check('superseded lifecycle_status', supersedeRes.data.lifecycle_status, 'superseded');
    check('superseded_by set', supersedeRes.data.superseded_by_agent_id, agent3Id);

    // Retired agent not dispatchable even with heartbeat
    const retiredAgentPresence = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent2Id}`, owner.token);
    check('retired agent not dispatchable', retiredAgentPresence.data.dispatchable, false);
    check('retired agent presence offline', retiredAgentPresence.data.presence, 'offline');

    // Superseded agent also not dispatchable
    const supersededAgentPresence = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent1Id}`, owner.token);
    check('superseded agent not dispatchable', supersededAgentPresence.data.dispatchable, false);

    // ── 5. Main-agent switch ──────────────────────────────────────────────
    console.log('\n── Main-Agent Switch ──');

    // Create two fresh online agents for orchestration
    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'MainAgent',
    });
    check('main agent created', mainAgent.status, 201);
    const mainAgentId = mainAgent.data.id;
    const mainAgentKey = mainAgent.data.api_key;

    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'WorkerAgent',
    });
    check('worker agent created', workerAgent.status, 201);
    const workerAgentId = workerAgent.data.id;
    const workerAgentKey = workerAgent.data.api_key;

    // Bring both online
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', mainAgentKey, { status: 'active' });
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', workerAgentKey, { status: 'active' });

    // Create orchestration with mainAgent
    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Test Orchestration',
      objective: 'Test main-agent switching',
      base_path: '.agent/orch/test-switch',
      main_agent_id: mainAgentId,
      worker_agent_ids: [workerAgentId],
    });
    check('orchestration created', orch.status, 201);
    const orchId = orch.data.id;
    check('orchestration main_agent_id', orch.data.main_agent_id, mainAgentId);

    // Create another agent for switching
    const replacementMainRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'NewMainAgent',
    });
    check('new main agent created', replacementMainRes.status, 201);
    const newMainAgentId = replacementMainRes.data.id;
    const newMainAgentKey = replacementMainRes.data.api_key;

    // Switch fails: new main agent is offline
    const offlineSwitch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/main-agent`, owner.token, {
      main_agent_id: newMainAgentId,
    });
    check('switch offline agent rejected 409', offlineSwitch.status, 409);

    // Bring new main agent online
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', newMainAgentKey, { status: 'active' });

    // Switch succeeds: new main agent is online
    const switchRes = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/main-agent`, owner.token, {
      main_agent_id: newMainAgentId,
    });
    check('switch main agent succeeds', switchRes.status, 200);
    check('switch updates main_agent_id', switchRes.data.main_agent_id, newMainAgentId);

    // Switch to retired agent fails
    const retiredSwitch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/main-agent`, owner.token, {
      main_agent_id: agent2Id, // retired agent
    });
    check('switch to retired agent rejected 409', retiredSwitch.status, 409);

    // Switch to wrong-project agent fails
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', otherUser.token, {
      name: 'Other Project',
      visibility: 'public',
    });
    check('other project created', otherProject.status, 201);
    const otherProjectAgent = await api(baseUrl, 'POST', `/v1/projects/${otherProject.data.id}/agents`, otherUser.token, {
      name: 'OtherAgent',
    });
    check('other project agent created', otherProjectAgent.status, 201);

    const wrongProjectSwitch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/orchestrations/${orchId}/main-agent`, owner.token, {
      main_agent_id: otherProjectAgent.data.id,
    });
    check('switch to wrong-project agent rejected 404', wrongProjectSwitch.status, 404);

    // ── 6. No raw API key in non-create responses ────────────────────────────
    console.log('\n── No Raw Key Leakage ──');

    const getAgent = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent3Id}`, owner.token);
    check('GET agent no api_key', getAgent.data.api_key, undefined);

    const listAgents = await api(baseUrl, 'GET', `/v1/projects/${projectId}/agents`, owner.token);
    check('list agents no api_key', listAgents.data.data.every((a: any) => a.api_key === undefined), true);

    const myAgentsList = await api(baseUrl, 'GET', '/v1/users/me/agents', owner.token);
    check('my agents no api_key', myAgentsList.data.data.every((a: any) => a.api_key === undefined), true);

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
    password: 'AgentIdentity123!',
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
