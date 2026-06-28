import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agent-key-scope-test-secret';

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

    // Create a public project
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'AgentKey Scope Test',
      description: 'Testing agentKey project-scoped access',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // Create an agent in the project (get API key)
    const agentRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'TestAgent',
      description: 'Agent for scope testing',
    });
    check('create agent', agentRes.status, 201);
    const agentId = agentRes.data.id;
    const agentApiKey = agentRes.data.api_key;

    // Create a second agent (for deny tests)
    const agent2Res = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'OtherAgent',
      description: 'Another agent for deny tests',
    });
    check('create second agent', agent2Res.status, 201);
    const agent2Id = agent2Res.data.id;
    const agent2ApiKey = agent2Res.data.api_key;

    // Add otherUser as a project member so they have JWT access
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: otherUser.userId,
      role: 'member',
    });

    // Create a session with the agent as participant
    const session = await api(baseUrl, 'POST', `/v1/projects/${projectId}/sessions`, owner.token, {
      agent_ids: [agentId],
      title: 'Test Session',
    });
    check('create session', session.status, 201);
    const sessionId = session.data.id;

    // Create a file in the project
    const file = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Test Project',
      message: 'Initial file',
    });
    check('create file', file.status, 201);
    const fileId = file.data.id;

    // Create a memory in the project
    const memory = await api(baseUrl, 'POST', `/v1/projects/${projectId}/memories`, owner.token, {
      content: 'User-owned memory.',
      tags: ['user'],
    });
    check('create memory as user', memory.status, 201);

    // ── ALLOW cases ───────────────────────────────────────────────────────
    console.log('\n── ALLOW cases ──');

    // Agent can read its own profile
    const agentProfile = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agentId}`, agentApiKey);
    check('agent read own profile', agentProfile.status, 200);
    check('agent profile id', agentProfile.data.id, agentId);

    const otherAgentProfile = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${agent2Id}`, agentApiKey);
    check('agent denied read other agent profile', otherAgentProfile.status, 403);

    // Agent can read project files list
    const filesList = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/files`, agentApiKey);
    check('agent list project files', filesList.status, 200);
    check('files list has data', Array.isArray(filesList.data.data), true);

    // Agent can read a specific file
    const fileGet = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/files/${fileId}`, agentApiKey);
    check('agent get file', fileGet.status, 200);
    check('file path', fileGet.data.path, 'README.md');

    // Agent can read file revisions
    const revisions = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/files/${fileId}/revisions`, agentApiKey);
    check('agent list file revisions', revisions.status, 200);

    const directFileWrite = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/files`, agentApiKey, {
      path: 'agent-direct-write.md',
      content: 'Agents must use user-token writes or proposal flow.',
    });
    // Agents are now authenticated for file writes (X-API-Key accepted) but scoped to
    // deliverables/ only. Writing outside deliverables/ returns 403 (forbidden path),
    // not 401 (unauthenticated). This is the path-safety boundary introduced when
    // agent file delivery was enabled.
    check('agent denied direct project file write (outside deliverables/)', directFileWrite.status, 403);

    // Agent CAN write under deliverables/<agent>/ (delivery channel)
    const deliverableWrite = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/files`, agentApiKey, {
      path: `deliverables/${agentId}/scope-test.md`,
      content: 'Agent delivery is allowed under deliverables/.',
    });
    check('agent can write under deliverables/<agent>/', deliverableWrite.status, 201);

    // Agent can read project memories
    const memoriesList = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/memories`, agentApiKey);
    check('agent list memories', memoriesList.status, 200);

    // Agent can create agent-scoped memory for itself
    const agentMemory = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/memories`, agentApiKey, {
      content: 'Agent self memory.',
      tags: ['agent-note'],
    });
    check('agent create own memory', agentMemory.status, 201);
    check('memory agent_id matches', agentMemory.data.agent_id, agentId);
    check('memory visibility is agent', agentMemory.data.visibility, 'agent');

    // Agent can send a session message (it's a participant)
    const msg = await apiWithKey(baseUrl, 'POST', `/v1/sessions/${sessionId}/messages`, agentApiKey, {
      content: 'Hello from agent',
    });
    check('agent send session message', msg.status, 201);

    // Agent can list session messages
    const messages = await apiWithKey(baseUrl, 'GET', `/v1/sessions/${sessionId}/messages`, agentApiKey);
    check('agent list session messages', messages.status, 200);
    check('messages list has data', Array.isArray(messages.data.data), true);

    // Agent can list events for sessions it participates in
    const events = await apiWithKey(baseUrl, 'GET', `/v1/sessions/${sessionId}/events`, agentApiKey);
    check('agent list session events', events.status, 200);

    // Agent can report own health
    const health = await apiWithKey(baseUrl, 'POST', `/v1/agents/${agentId}/health`, agentApiKey, {
      status: 'healthy',
      metrics: [{ name: 'cpu', value: 42, unit: '%' }],
    });
    check('agent report own health', health.status, 202);

    // Agent can list sessions
    const sessionsList = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/sessions`, agentApiKey);
    check('agent list sessions', sessionsList.status, 200);

    // ── DENY cases ────────────────────────────────────────────────────────
    console.log('\n── DENY cases ──');

    // Agent cannot manage members (JWT-only route rejects agent key)
    const addMember = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/members`, agentApiKey, {
      user_id: otherUser.userId,
      role: 'viewer',
    });
    check('agent denied manage members', addMember.status, 401);

    // Agent cannot patch project (JWT-only route rejects agent key)
    const patchProject = await apiWithKey(baseUrl, 'PATCH', `/v1/projects/${projectId}`, agentApiKey, {
      name: 'Hacked Name',
    });
    check('agent denied edit project', patchProject.status, 401);

    // Agent cannot delete project (JWT-only route rejects agent key)
    const deleteProject = await apiWithKey(baseUrl, 'DELETE', `/v1/projects/${projectId}`, agentApiKey);
    check('agent denied delete project', deleteProject.status, 401);

    // Agent cannot create/register new agents (JWT-only route rejects agent key)
    const createAgent = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, agentApiKey, {
      name: 'UnauthorizedAgent',
    });
    check('agent denied create agent', createAgent.status, 401);

    // Agent cannot review join requests (JWT-only route rejects agent key)
    const privateProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Private Test Project',
    });
    const joinReq = await api(baseUrl, 'POST', `/v1/projects/${privateProject.data.id}/join-requests`, otherUser.token, {
      note: 'Please let me in',
    });
    // Create an agent in the private project
    const privAgent = await api(baseUrl, 'POST', `/v1/projects/${privateProject.data.id}/agents`, owner.token, {
      name: 'PrivateAgent',
    });
    const reviewAttempt = await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${privateProject.data.id}/join-requests/${joinReq.data.id}`,
      privAgent.data.api_key,
      { status: 'approved' },
    );
    check('agent denied review join request', reviewAttempt.status, 401);

    // Agent cannot clone private project (JWT-only route rejects agent key)
    const cloneAttempt = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${privateProject.data.id}/clone`,
      privAgent.data.api_key,
      { name: 'Agent Clone' },
    );
    check('agent denied clone private project', cloneAttempt.status, 401);

    // Agent cannot write memory for another agent
    const otherAgentMemory = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/memories`, agentApiKey, {
      content: 'Trying to write as other agent',
      agent_id: agent2Id,
    });
    check('agent denied write memory for another agent', otherAgentMemory.status, 403);

    // Agent cannot send as another agent
    const sendAsOther = await apiWithKey(baseUrl, 'POST', `/v1/sessions/${sessionId}/messages`, agentApiKey, {
      content: 'Impersonating another agent',
      sender_ref: agent2Id,
    });
    check('agent denied send as another agent', sendAsOther.status, 403);

    // Agent cannot send message to a session it's not a participant in
    const session2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/sessions`, owner.token, {
      agent_ids: [agent2Id],
      title: 'Other Session',
    });
    const sendNoParticipant = await apiWithKey(baseUrl, 'POST', `/v1/sessions/${session2.data.id}/messages`, agentApiKey, {
      content: 'Not a participant',
    });
    check('agent denied send to non-participant session', sendNoParticipant.status, 403);

    const readNoParticipant = await apiWithKey(baseUrl, 'GET', `/v1/sessions/${session2.data.id}/messages`, agentApiKey);
    check('agent denied read non-participant messages', readNoParticipant.status, 403);

    const getNoParticipant = await apiWithKey(baseUrl, 'GET', `/v1/sessions/${session2.data.id}`, agentApiKey);
    check('agent denied read non-participant session', getNoParticipant.status, 403);

    const patchSession = await apiWithKey(baseUrl, 'PATCH', `/v1/sessions/${sessionId}`, agentApiKey, {
      title: 'Agent should not patch sessions',
    });
    check('agent denied patch session', patchSession.status, 401);

    const filteredSessions = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/sessions`, agentApiKey);
    const visibleSessionIds = Array.isArray(filteredSessions.data.data)
      ? filteredSessions.data.data.map((item: any) => item.id)
      : [];
    check('agent session list hides non-participant session', visibleSessionIds.includes(session2.data.id), false);

    // dispatch_ttl is clamped to 1 for agent messages
    // We test this by verifying the message is created (not rejected) — TTL is internal
    const ttlMsg = await apiWithKey(baseUrl, 'POST', `/v1/sessions/${sessionId}/messages`, agentApiKey, {
      content: 'Message with high TTL',
      dispatch_ttl: 5,
    });
    check('agent message with clamped dispatch_ttl succeeds', ttlMsg.status, 201);

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
    password: 'AgentKeyTest123!',
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
