import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-overview-test-secret';

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
    const owner = await register(baseUrl, 'overview-owner');
    const other = await register(baseUrl, 'overview-other');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Overview Test',
      description: 'Testing project overview aggregation',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const otherProject = await api(baseUrl, 'POST', '/v1/projects', other.token, {
      name: 'Other Overview Project',
      visibility: 'private',
    });
    assert.equal(otherProject.status, 201);

    // Create agents and bring them online
    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Overview Main Agent',
    });
    assert.equal(mainAgent.status, 201);

    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Overview Worker Agent',
    });
    assert.equal(workerAgent.status, 201);

    const unassignedAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Overview Unassigned Agent',
    });
    assert.equal(unassignedAgent.status, 201);

    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);

    // Seed project files with convention paths
    const seedFiles = [
      { path: 'README.md', content: '# Project Overview\n\nRead me first.' },
      { path: 'docs/architecture.md', content: 'Architecture notes' },
      { path: 'deliverables/report.md', content: 'Final report' },
      { path: 'deliverables/slides.md', content: 'Slides' },
      { path: '.agent/RESULT.md', content: 'Agent result artifact' },
      { path: '.agent/REVIEW.md', content: 'Agent review artifact' },
      { path: '.agent/TRACE.md', content: 'Agent trace artifact' },
    ];
    for (const item of seedFiles) {
      const r = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
        path: item.path,
        content: item.content,
      });
      assert.equal(r.status, 201, `seed ${item.path}`);
    }

    // Create orchestrations and tasks
    const orch1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'First Orchestration',
      objective: 'Create ready-for-review and blocked tasks.',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
    });
    assert.equal(orch1.status, 201);

    const readyTask = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orch1.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Ready for review task',
        goal: 'Task that will be completed for review.',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(readyTask.status, 201);

    const blockedTask = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orch1.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Blocked task',
        goal: 'Task that will be marked blocked.',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(blockedTask.status, 201);

    // Worker claims and completes tasks
    await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orch1.data.id}/tasks/${readyTask.data.id}/claim`,
      workerAgent.data.api_key,
    );

    const readyComplete = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orch1.data.id}/tasks/${readyTask.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nReady for review.',
        evidence: { ok: true },
        status: 'ready_for_review',
      },
    );
    assert.equal(readyComplete.status, 200);

    await apiWithKey(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/orchestrations/${orch1.data.id}/tasks/${blockedTask.data.id}/claim`,
      workerAgent.data.api_key,
    );

    const blockedComplete = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/orchestrations/${orch1.data.id}/tasks/${blockedTask.data.id}/complete`,
      workerAgent.data.api_key,
      {
        result_md: '# Result\n\nBlocked on dependency.',
        evidence: { reason: 'dependency missing' },
        status: 'blocked',
      },
    );
    assert.equal(blockedComplete.status, 200);

    // A second orchestration where only mainAgent participates (no worker tasks)
    const orch2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Planning Orchestration',
      objective: 'Orchestration with no tasks yet.',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [],
    });
    assert.equal(orch2.status, 201);

    // Seed workload units
    await seedWorkUnit(AppDataSource, {
      projectId,
      agentId: workerAgent.data.id,
      orchestrationId: orch1.data.id,
      taskId: readyTask.data.id,
      status: 'reviewed_approved',
      finalWorkUnits: 2.5,
    });

    // Seed stale inbox item for worker
    await seedInboxItem(AppDataSource, {
      projectId,
      recipientAgentId: workerAgent.data.id,
      eventType: 'task_dispatched',
      title: 'Stale inbox item',
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    // Seed fresh inbox item for unassigned agent (should not appear in stale list)
    await seedInboxItem(AppDataSource, {
      projectId,
      recipientAgentId: unassignedAgent.data.id,
      eventType: 'task_dispatched',
      title: 'Fresh inbox item',
      createdAt: new Date(),
    });

    // Seed health signal
    await seedHealthMetric(AppDataSource, {
      projectId,
      agentId: workerAgent.data.id,
      name: 'cpu_usage',
      value: 42.0,
      unit: 'percent',
      status: 'healthy',
      recordedAt: new Date(),
    });

    // ─── Test 1: Owner gets full overview with correct shape ─────────────────
    console.log('Test 1: Owner overview shape and counts');
    const overview = await api(baseUrl, 'GET', `/v1/projects/${projectId}/overview`, owner.token);
    assert.equal(overview.status, 200);
    assert.equal(overview.data.project.id, projectId);
    assert.equal(overview.data.project.name, 'Project Overview Test');
    assert.equal(overview.data.project.visibility, 'public');
    assert.equal(typeof overview.data.generated_at, 'string');

    // Summary
    assert.equal(overview.data.summary.agents.total, 3);
    assert.equal(overview.data.summary.agents.online, 2);
    assert.equal(overview.data.summary.agents.offline, 1);

    assert.equal(overview.data.summary.orchestrations.total, 2);
    assert.equal(overview.data.summary.orchestrations.planning, 1);
    assert.equal(overview.data.summary.orchestrations.blocked, 1);

    assert.equal(overview.data.summary.tasks.total, 2);
    assert.equal(overview.data.summary.tasks.ready_for_review, 1);
    assert.equal(overview.data.summary.tasks.blocked, 1);
    assert.equal(overview.data.summary.tasks.open_work, 0);

    // Files include seeded convention files plus orchestration/task artifacts
    assert.ok(overview.data.summary.files.total_count >= seedFiles.length);
    assert.ok(overview.data.summary.files.recent_count >= seedFiles.length);

    // Inbox includes auto-generated task notifications plus seeded items
    assert.ok(overview.data.summary.inbox.pending_total >= 2);
    assert.ok(overview.data.summary.inbox.unacked_total >= 2);

    // Attention
    assert.equal(overview.data.attention.ready_for_review.length, 1);
    assert.equal(overview.data.attention.ready_for_review[0].task_id, readyTask.data.id);
    assert.equal(overview.data.attention.blocked_failed.length, 1);
    assert.equal(overview.data.attention.blocked_failed[0].task_id, blockedTask.data.id);
    assert.equal(overview.data.attention.stale_inbox.length, 1);
    assert.equal(overview.data.attention.stale_inbox[0].recipient_agent_id, workerAgent.data.id);

    // Recent
    assert.equal(overview.data.recent.orchestrations.length, 2);
    const recentOrchestrationIds = overview.data.recent.orchestrations.map((o: any) => o.id);
    assert.ok(recentOrchestrationIds.includes(orch1.data.id));
    assert.ok(recentOrchestrationIds.includes(orch2.data.id));

    assert.ok(overview.data.recent.files.length >= 5);
    const recentPaths = overview.data.recent.files.map((f: any) => f.path);
    assert.ok(recentPaths.includes('README.md'));
    assert.ok(recentPaths.includes('.agent/RESULT.md'));
    assert.ok(recentPaths.includes('deliverables/report.md'));

    // Workload includes auto-created units from task completion plus the seeded approved unit
    assert.ok(overview.data.workload.total_units >= 1);
    assert.ok(overview.data.workload.reviewed_units >= 1);
    assert.ok(overview.data.workload.total_final_work_units >= 2.5);

    // Health
    assert.equal(overview.data.health.signals.length, 1);
    assert.equal(overview.data.health.signals[0].name, 'cpu_usage');

    console.log('  ✅ Owner overview correct');

    // ─── Test 2: Auth and membership requirements ────────────────────────────
    console.log('Test 2: Auth and membership');
    const noAuth = await api(baseUrl, 'GET', `/v1/projects/${projectId}/overview`);
    assert.equal(noAuth.status, 401);

    const badToken = await api(baseUrl, 'GET', `/v1/projects/${projectId}/overview`, 'invalid-token');
    assert.equal(badToken.status, 401);

    const crossOverview = await api(
      baseUrl,
      'GET',
      `/v1/projects/${otherProject.data.id}/overview`,
      owner.token,
    );
    assert.equal(crossOverview.status, 403);

    console.log('  ✅ Auth and membership enforced');

    // ─── Test 3: Agent-scoped overview ───────────────────────────────────────
    console.log('Test 3: Agent-scoped overview');
    const workerOverview = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/overview`,
      workerAgent.data.api_key,
    );
    assert.equal(workerOverview.status, 200);

    // Worker can see orch1 (assigned task) but not orch2 (no assignment)
    const workerOrchestrationIds = workerOverview.data.recent.orchestrations.map((o: any) => o.id);
    assert.ok(workerOrchestrationIds.includes(orch1.data.id));
    assert.ok(!workerOrchestrationIds.includes(orch2.data.id));
    assert.equal(workerOverview.data.summary.orchestrations.total, 1);

    // Worker can see both tasks (assigned) but not tasks from other projects
    assert.equal(workerOverview.data.summary.tasks.total, 2);
    assert.equal(workerOverview.data.attention.ready_for_review.length, 1);
    assert.equal(workerOverview.data.attention.blocked_failed.length, 1);

    // Worker's inbox scoped (includes auto-generated task notifications)
    assert.ok(workerOverview.data.summary.inbox.pending_total >= 1);
    assert.ok(workerOverview.data.summary.inbox.unacked_total >= 1);

    // Agent cannot access other project
    const workerOtherProject = await apiWithKey(
      baseUrl,
      'GET',
      `/v1/projects/${otherProject.data.id}/overview`,
      workerAgent.data.api_key,
    );
    assert.equal(workerOtherProject.status, 403);

    console.log('  ✅ Agent scoping correct');

    // ─── Test 4: Bounded lists ───────────────────────────────────────────────
    console.log('Test 4: Bounded lists');
    const bounded = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/overview?attention_limit=1&recent_orchestrations_limit=1&recent_files_limit=2&recent_health_limit=1`,
      owner.token,
    );
    assert.equal(bounded.status, 200);
    assert.ok(bounded.data.attention.ready_for_review.length <= 1);
    assert.ok(bounded.data.attention.blocked_failed.length <= 1);
    assert.ok(bounded.data.recent.orchestrations.length <= 1);
    assert.ok(bounded.data.recent.files.length <= 2);
    assert.ok(bounded.data.health.signals.length <= 1);

    console.log('  ✅ Bounded lists respected');

    // ─── Test 5: Additive compatibility ──────────────────────────────────────
    console.log('Test 5: Additive compatibility');
    const summary = await api(baseUrl, 'GET', `/v1/projects/${projectId}/summary`, owner.token);
    assert.equal(summary.status, 200);
    assert.ok(summary.data.files.total_count >= seedFiles.length);

    const orchestrations = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/orchestrations`,
      owner.token,
    );
    assert.equal(orchestrations.status, 200);
    assert.equal(orchestrations.data.data.length, 2);

    const workload = await api(baseUrl, 'GET', `/v1/projects/${projectId}/workload`, owner.token);
    assert.equal(workload.status, 200);
    assert.ok(workload.data.summary.total_units >= 1);

    console.log('  ✅ Existing endpoints unchanged');

    console.log('project-overview tests passed');
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
    password: 'ProjectOverviewTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const r = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, { status: 'healthy' });
  assert.equal(r.status, 200);
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

async function seedWorkUnit(
  ds: any,
  input: {
    projectId: string;
    agentId: string;
    orchestrationId: string;
    taskId: string;
    status: string;
    finalWorkUnits: number;
  },
): Promise<void> {
  const { AgentWorkUnit } = await import('../src/entities');
  const { randomUUID } = await import('crypto');
  const repo = ds.getRepository(AgentWorkUnit);
  const unit = repo.create({
    id: randomUUID(),
    projectId: input.projectId,
    agentId: input.agentId,
    orchestrationId: input.orchestrationId,
    taskId: input.taskId,
    sourceEvent: 'task_approved',
    status: input.status,
    finalWorkUnits: input.finalWorkUnits,
    normalizedWorkUnits: input.finalWorkUnits,
    completedAt: new Date(),
    reviewedAt: new Date(),
  });
  await repo.save(unit);
}

async function seedInboxItem(
  ds: any,
  input: {
    projectId: string;
    recipientAgentId: string;
    eventType: string;
    title: string;
    createdAt: Date;
  },
): Promise<void> {
  const { AgentInboxItem, InboxItemStatus } = await import('../src/entities');
  const { randomUUID } = await import('crypto');
  const repo = ds.getRepository(AgentInboxItem);
  const item = repo.create({
    id: randomUUID(),
    projectId: input.projectId,
    recipientAgentId: input.recipientAgentId,
    eventType: input.eventType,
    title: input.title,
    status: InboxItemStatus.UNREAD,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  await repo.save(item);
}

async function seedHealthMetric(
  ds: any,
  input: {
    projectId: string;
    agentId: string;
    name: string;
    value: number;
    unit: string;
    status: string;
    recordedAt: Date;
  },
): Promise<void> {
  const { HealthMetric, Event, Session } = await import('../src/entities');
  const { randomUUID } = await import('crypto');

  const sessionRepo = ds.getRepository(Session);
  const session = sessionRepo.create({
    id: randomUUID(),
    projectId: input.projectId,
    title: 'Health signal session',
    status: 'active',
    createdBy: input.agentId,
  });
  await sessionRepo.save(session);

  const eventId = randomUUID();
  const eventRepo = ds.getRepository(Event);
  const event = eventRepo.create({
    id: eventId,
    projectId: input.projectId,
    sessionId: session.id,
    seq: 1,
    agentId: input.agentId,
    type: 'health_metric',
    payloadJson: {},
  });
  await eventRepo.save(event);

  const repo = ds.getRepository(HealthMetric);
  const metric = repo.create({
    projectId: input.projectId,
    agentId: input.agentId,
    eventId: eventId,
    name: input.name,
    value: input.value,
    unit: input.unit,
    status: input.status,
    recordedAt: input.recordedAt,
  });
  await repo.save(metric);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
