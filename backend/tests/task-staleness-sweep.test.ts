import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'task-staleness-sweep-test-secret';
process.env.TASK_STALE_MINUTES = '10';
process.env.AGENT_ONLINE_TTL_MS = '90000';

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const http = await import('node:http');
  const { ProjectOrchestration, ProjectOrchestrationStatus } = await import('../src/entities/project-orchestration.entity');
  const { ProjectOrchestrationTask, ProjectOrchestrationTaskStatus } = await import('../src/entities/project-orchestration-task.entity');
  const { runTaskStalenessSweep } = await import('../src/services/task-staleness-sweep.service');
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const owner = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
      email: `sweep-${Date.now()}@x.invalid`, password: 'SweepTest123!', display_name: 'sweep',
    });
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.data.access_token, { name: 'Sweep', visibility: 'public' });
    const projectId = project.data.id;
    const agent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.data.access_token, { name: 'pm' });
    const pmKey = agent.data.api_key;
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', pmKey, {});
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.data.access_token, { main_agent_id: agent.data.id });
    const ownerId = owner.data.user.id;

    // Seed an orchestration + a DISPATCHED task with an OLD dispatchedAt (25 min ago).
    const orchRepo = AppDataSource.getRepository(ProjectOrchestration);
    const orch = new ProjectOrchestration();
    orch.id = crypto.randomUUID(); orch.projectId = projectId; orch.title = 'sweep orch';
    orch.objective = 'x'; orch.status = ProjectOrchestrationStatus.RUNNING;
    orch.basePath = '.agent/o/x'; orch.mainAgentId = agent.data.id; orch.createdByUserId = ownerId;
    await orchRepo.save(orch);

    const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
    const old = new Date(Date.now() - 25 * 60_000);
    const staleTask = new ProjectOrchestrationTask();
    staleTask.id = crypto.randomUUID(); staleTask.projectId = projectId; staleTask.orchestrationId = orch.id;
    staleTask.title = 'stale'; staleTask.goal = 'never claimed';
    staleTask.status = ProjectOrchestrationTaskStatus.DISPATCHED;
    staleTask.assignedAgentId = agent.data.id; staleTask.workerTaskPath = 'x'; staleTask.workerContextPath = 'y';
    staleTask.dispatchedAt = old;
    await taskRepo.save(staleTask);

    // A fresh task (1 min ago) — should NOT be marked.
    const freshTask = new ProjectOrchestrationTask();
    freshTask.id = crypto.randomUUID(); freshTask.projectId = projectId; freshTask.orchestrationId = orch.id;
    freshTask.title = 'fresh'; freshTask.goal = 'recent';
    freshTask.status = ProjectOrchestrationTaskStatus.DISPATCHED;
    freshTask.assignedAgentId = agent.data.id; freshTask.workerTaskPath = 'x'; freshTask.workerContextPath = 'y';
    freshTask.dispatchedAt = new Date(Date.now() - 60_000);
    await taskRepo.save(freshTask);

    const result = await runTaskStalenessSweep();
    check('sweep marked 1 stale task', result.marked, 1);

    const reStale = await taskRepo.findOneBy({ id: staleTask.id });
    check('stale task flagged stale=true', (reStale!.metadata as any)?.stale, true);
    check('stale task has stale_notified_at', !!(reStale!.metadata as any)?.stale_notified_at, true);

    const reFresh = await taskRepo.findOneBy({ id: freshTask.id });
    check('fresh task NOT flagged', (reFresh!.metadata as any)?.stale ?? false, false);

    // Idempotent: second sweep marks nothing new (already notified).
    const result2 = await runTaskStalenessSweep();
    check('sweep idempotent (no new marks)', result2.marked, 0);

    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
  } finally {
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    await AppDataSource.destroy();
  }
}

async function api(baseUrl: string, method: string, path: string, token: string | undefined, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d: any = t; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

main().catch((e) => { console.error(e); process.exit(1); });
