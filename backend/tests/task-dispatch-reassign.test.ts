import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-dispatch-reassign-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '90000';

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
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const w1User = await register(baseUrl, 'w1');
    const w2User = await register(baseUrl, 'w2');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Dispatch Reassign Test', visibility: 'public',
    });
    const projectId = project.data.id;
    for (const u of [pmUser, w1User, w2User]) {
      await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: u.userId, role: 'member' });
    }

    const pm = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm' });
    const pmKey = pm.data.api_key;
    const pmId = pm.data.id;
    const w1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, w1User.token, { name: 'w1' });
    const w1Key = w1.data.api_key;
    const w1Id = w1.data.id;
    const w2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, w2User.token, { name: 'w2' });
    const w2Key = w2.data.api_key;
    const w2Id = w2.data.id;
    for (const k of [pmKey, w1Key, w2Key]) {
      await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', k, {});
    }
    // pm is project-level main agent.
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmId });

    // ── Phase 2: dispatch + worker discovers via assigned-tasks ──────────
    const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'reassign orch', objective: 'parallel dispatch + reassign',
      main_agent_id: pmId, worker_agent_ids: [w1Id, w2Id],
    });
    const orchId = orch.data.id;

    // pm dispatches 2 tasks in parallel to w1 and w2.
    const t1 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'task-A', goal: 'do A', assigned_agent_id: w1Id, acceptance_criteria: ['a done'],
    });
    check('dispatch task A to w1', t1.status, 201);
    const t2 = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks`, pmKey, {
      title: 'task-B', goal: 'do B', assigned_agent_id: w2Id, acceptance_criteria: ['b done'],
    });
    check('dispatch task B to w2', t2.status, 201);

    // w1 sees ONLY its own task via assigned-tasks.
    const w1Tasks = await apiWithKey(baseUrl, 'GET', '/v1/agent/assigned-tasks', w1Key);
    check('w1 assigned-tasks 200', w1Tasks.status, 200);
    const w1Ids = (w1Tasks.data.data || []).map((t: any) => t.id);
    check('w1 sees its task A', w1Ids.includes(t1.data.id), true);
    check('w1 does NOT see w2 task B', w1Ids.includes(t2.data.id), false);
    check('assigned-tasks includes goal', (w1Tasks.data.data[0] || {}).goal, 'do A');

    // ── Phase 3: reassign task A from w1 to w2 ──────────────────────────
    const reassign = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t1.data.id}/reassign`, pmKey, {
      new_agent_id: w2Id, reason: 'w1 too slow',
    });
    check('reassign task A to w2', reassign.status, 201);
    const reassignedId = reassign.data.id;
    check('reassigned task assigned to w2', reassign.data.assigned_agent_id, w2Id);

    // old task is CANCELLED.
    const oldTask = await api(baseUrl, 'GET', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t1.data.id}`, owner.token);
    check('old task cancelled', oldTask.data.status, 'cancelled');

    // w2 now sees BOTH tasks (its original + the reassigned one) via assigned-tasks.
    const w2Tasks = await apiWithKey(baseUrl, 'GET', '/v1/agent/assigned-tasks', w2Key);
    const w2Ids = (w2Tasks.data.data || []).map((t: any) => t.id);
    check('w2 sees reassigned task', w2Ids.includes(reassignedId), true);
    check('w2 still sees its original task B', w2Ids.includes(t2.data.id), true);

    // w2 received a task_dispatched inbox for the reassignment.
    const w2Inbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox?unread=true', w2Key);
    const hasReassignNotify = (w2Inbox.data.data || []).some((i: any) => i.task_id === reassignedId);
    check('w2 notified of reassigned task', hasReassignNotify, true);

    // ── Phase 3 RBAC: a worker cannot reassign ──────────────────────────
    const reassignByWorker = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t2.data.id}/reassign`, w1Key, {
      new_agent_id: w2Id, reason: 'worker tries pm action',
    });
    check('worker denied reassign', reassignByWorker.status, 403);

    // ── Phase 3: cannot reassign a terminal task ────────────────────────
    const cancelReattempt = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations/${orchId}/tasks/${t1.data.id}/reassign`, pmKey, {
      new_agent_id: w2Id,
    });
    check('cannot reassign cancelled task', cancelReattempt.status, 409);

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
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
    password: 'TaskDispatch123!', display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => { console.error(err); process.exit(1); });
