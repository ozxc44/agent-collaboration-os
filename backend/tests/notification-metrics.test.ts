import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'notif-metrics-test-secret';
process.env.AGENT_ONLINE_TTL_MS = '60000';
process.env.AGENT_STALE_TTL_MS = '300000';

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
    // Setup: register owner, admin, member, viewer, unrelated user
    const owner = await register(baseUrl, 'nm-owner');
    const admin = await register(baseUrl, 'nm-admin');
    const member = await register(baseUrl, 'nm-member');
    const viewer = await register(baseUrl, 'nm-viewer');
    const otherUser = await register(baseUrl, 'nm-other');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Notification Metrics Project',
      description: 'P1 notification metrics testing',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Add roles
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: admin.userId, role: 'admin',
    });
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: member.userId, role: 'member',
    });
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId, role: 'viewer',
    });

    // Create agents
    const agent1 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Metrics Online Agent',
    });
    assert.equal(agent1.status, 201);

    const agent2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Metrics Stale Agent',
    });
    assert.equal(agent2.status, 201);

    const agent3 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Metrics Offline Agent',
    });
    assert.equal(agent3.status, 201);

    const metricScenario = await setupMetricScenario(AppDataSource, {
      projectId,
      ownerUserId: owner.userId,
      onlineAgentId: agent1.data.id,
      staleAgentId: agent2.data.id,
      offlineAgentId: agent3.data.id,
    });

    // ── Test 1: Owner can access project notification metrics ──────────────
    console.log('\n── Test 1: Owner access ──');
    const ownerRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/notification-metrics`, owner.token);
    assert.equal(ownerRes.status, 200);
    assert.equal(ownerRes.data.project_id, projectId);
    assert.ok(Array.isArray(ownerRes.data.agents));
    assert.ok(ownerRes.data.summary);
    console.log('  ✅ Owner gets 200 with metrics');

    // ── Test 2: Admin can access project notification metrics ──────────────
    console.log('\n── Test 2: Admin access ──');
    const adminRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/notification-metrics`, admin.token);
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.data.project_id, projectId);
    console.log('  ✅ Admin gets 200 with metrics');

    // ── Test 3: Member is denied ───────────────────────────────────────────
    console.log('\n── Test 3: Member denied ──');
    const memberRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/notification-metrics`, member.token);
    assert.equal(memberRes.status, 403);
    console.log('  ✅ Member gets 403');

    // ── Test 4: Viewer is denied ───────────────────────────────────────────
    console.log('\n── Test 4: Viewer denied ──');
    const viewerRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/notification-metrics`, viewer.token);
    assert.equal(viewerRes.status, 403);
    console.log('  ✅ Viewer gets 403');

    // ── Test 5: Unauthenticated is denied ──────────────────────────────────
    console.log('\n── Test 5: Unauthenticated denied ──');
    const unauthRes = await fetch(`${baseUrl}/v1/projects/${projectId}/notification-metrics`);
    assert.equal(unauthRes.status, 401);
    console.log('  ✅ Unauthenticated gets 401');

    // ── Test 6: Unrelated user is denied ───────────────────────────────────
    console.log('\n── Test 6: Unrelated user denied ──');
    const otherRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/notification-metrics`, otherUser.token);
    assert.equal(otherRes.status, 403);
    console.log('  ✅ Unrelated user gets 403');

    // ── Test 7: Agent API key is denied ────────────────────────────────────
    console.log('\n── Test 7: Agent API key denied ──');
    const agentKeyRes = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/notification-metrics`, agent1.data.api_key);
    assert.equal(agentKeyRes.status, 403);
    console.log('  ✅ Agent API key gets 403');

    // ── Test 8: Concrete metric values are reported ────────────────────────
    console.log('\n── Test 8: Concrete metric values ──');
    const s = ownerRes.data.summary;
    assert.equal(s.total_agents, 3);
    assert.equal(s.online_count, 1);
    assert.equal(s.stale_count, 1);
    assert.equal(s.offline_count, 1);
    assert.equal(s.pending_inbox_total, 1);
    assertNumberAtLeast(
      s.oldest_unacked_age_seconds,
      metricScenario.oldestUnackedAgeSecondsMin,
      'summary.oldest_unacked_age_seconds',
    );
    assertNumberNear(s.ack_latency_p50_seconds, metricScenario.fastAckLatencySeconds, 0.001, 'summary.ack_latency_p50_seconds');
    assertNumberNear(s.ack_latency_p95_seconds, metricScenario.ackLatencySeconds, 0.001, 'summary.ack_latency_p95_seconds');
    assertNumberNear(
      s.ack_latency_max_seconds,
      metricScenario.ackLatencySeconds,
      0.001,
      'summary.ack_latency_max_seconds',
    );
    // SLA: p95=45, so 45 < 45 is false
    assert.equal(s.ack_latency_sla_pass, false, 'ack_latency_sla_pass should be false when p95 >= 45');

    assertNumberNear(
      s.task_review_latency_p50_seconds,
      metricScenario.taskReviewLatencySeconds,
      0.001,
      'summary.task_review_latency_p50_seconds',
    );
    assertNumberNear(
      s.task_review_latency_p95_seconds,
      metricScenario.taskReviewLatencySeconds,
      0.001,
      'summary.task_review_latency_p95_seconds',
    );
    assertNumberNear(
      s.task_review_latency_max_seconds,
      metricScenario.taskReviewLatencySeconds,
      0.001,
      'summary.task_review_latency_max_seconds',
    );
    // SLA: p95=90, so 90 < 90 is false
    assert.equal(s.task_review_latency_sla_pass, false, 'task_review_latency_sla_pass should be false when p95 >= 90');

    // Workload indicators
    assert.equal(s.waiting_review_count, 1, 'summary.waiting_review_count');
    assert.equal(s.blocked_task_count, 1, 'summary.blocked_task_count');

    // TTFT metric
    assertNumberNear(
      s.time_to_first_reviewed_task_ms,
      metricScenario.ttftMs,
      100,
      'summary.time_to_first_reviewed_task_ms',
    );
    assert.equal(s.ttft_task_id, metricScenario.reviewedTaskId, 'summary.ttft_task_id');
    assert.ok(s.ttft_phases, 'summary.ttft_phases should not be null');
    assert.equal(typeof s.ttft_phases.dispatched_at, 'string', 'ttft_phases.dispatched_at should be a string');
    assert.equal(typeof s.ttft_phases.claimed_at, 'string', 'ttft_phases.claimed_at should be a string');
    assert.equal(typeof s.ttft_phases.completed_at, 'string', 'ttft_phases.completed_at should be a string');
    assert.equal(typeof s.ttft_phases.reviewed_at, 'string', 'ttft_phases.reviewed_at should be a string');
    console.log('  ✅ Summary metrics match seeded backlog, latency, presence, SLA, workload, and TTFT values');

    // Per-agent fields
    assert.equal(ownerRes.data.agents.length, 3);
    const agentsById = new Map(ownerRes.data.agents.map((agent: any) => [agent.agent_id, agent]));
    const onlineAgent = agentsById.get(agent1.data.id) as any;
    const staleAgent = agentsById.get(agent2.data.id) as any;
    const offlineAgent = agentsById.get(agent3.data.id) as any;
    assert.ok(onlineAgent);
    assert.ok(staleAgent);
    assert.ok(offlineAgent);

    assert.equal(onlineAgent.agent_name, 'Metrics Online Agent');
    assert.equal(onlineAgent.presence, 'online');
    assert.equal(onlineAgent.pending_inbox_count, 1);
    assertNumberAtLeast(
      onlineAgent.oldest_unacked_age_seconds,
      metricScenario.oldestUnackedAgeSecondsMin,
      'onlineAgent.oldest_unacked_age_seconds',
    );
    // pending_by_type
    assert.ok(Array.isArray(onlineAgent.pending_by_type), 'onlineAgent.pending_by_type should be an array');
    const pbt = onlineAgent.pending_by_type.find((t: any) => t.event_type === 'metric_pending_backlog');
    assert.equal(pbt?.count, 1, 'onlineAgent pending_by_type metric_pending_backlog count');

    assert.equal(staleAgent.agent_name, 'Metrics Stale Agent');
    assert.equal(staleAgent.presence, 'stale');
    assert.equal(staleAgent.pending_inbox_count, 0);
    assert.equal(staleAgent.oldest_unacked_age_seconds, null);
    assert.ok(Array.isArray(staleAgent.pending_by_type), 'staleAgent.pending_by_type should be an array');
    assert.equal(staleAgent.pending_by_type.length, 0, 'staleAgent pending_by_type should be empty');

    assert.equal(offlineAgent.agent_name, 'Metrics Offline Agent');
    assert.equal(offlineAgent.presence, 'offline');
    assert.equal(offlineAgent.pending_inbox_count, 0);
    assert.equal(offlineAgent.oldest_unacked_age_seconds, null);
    assert.ok(Array.isArray(offlineAgent.pending_by_type), 'offlineAgent.pending_by_type should be an array');
    assert.equal(offlineAgent.pending_by_type.length, 0, 'offlineAgent pending_by_type should be empty');
    console.log('  ✅ Per-agent metrics include pending_by_type breakdown');

    // ── Test 9: Admin aggregate only includes owner/admin projects ─────────
    console.log('\n── Test 9: Admin aggregate scope ──');
    const adminAgg = await api(baseUrl, 'GET', '/v1/admin/notification-metrics', owner.token);
    assert.equal(adminAgg.status, 200);
    assert.ok(Array.isArray(adminAgg.data.projects));
    assert.ok(adminAgg.data.aggregate);
    // Owner should see the project in aggregate
    assert.ok(adminAgg.data.projects.some((p: any) => p.project_id === projectId));
    assert.equal(adminAgg.data.aggregate.total_agents, 3);
    assert.equal(adminAgg.data.aggregate.online_count, 1);
    assert.equal(adminAgg.data.aggregate.stale_count, 1);
    assert.equal(adminAgg.data.aggregate.offline_count, 1);
    assert.equal(adminAgg.data.aggregate.pending_inbox_total, 1);
    assertNumberAtLeast(
      adminAgg.data.aggregate.oldest_unacked_age_seconds,
      metricScenario.oldestUnackedAgeSecondsMin,
      'admin.aggregate.oldest_unacked_age_seconds',
    );
    assertNumberNear(adminAgg.data.aggregate.ack_latency_p50_seconds, metricScenario.fastAckLatencySeconds, 0.001, 'admin.aggregate.ack_latency_p50_seconds');
    assertNumberNear(adminAgg.data.aggregate.ack_latency_max_seconds, metricScenario.ackLatencySeconds, 0.001, 'admin.aggregate.ack_latency_max_seconds');
    assertNumberNear(
      adminAgg.data.aggregate.task_review_latency_p50_seconds,
      metricScenario.taskReviewLatencySeconds,
      0.001,
      'admin.aggregate.task_review_latency_p50_seconds',
    );
    assertNumberNear(
      adminAgg.data.aggregate.task_review_latency_max_seconds,
      metricScenario.taskReviewLatencySeconds,
      0.001,
      'admin.aggregate.task_review_latency_max_seconds',
    );
    // Aggregate SLA and workload
    assert.equal(adminAgg.data.aggregate.ack_latency_sla_pass, false, 'admin aggregate ack_sla_pass');
    assert.equal(adminAgg.data.aggregate.task_review_latency_sla_pass, false, 'admin aggregate review_sla_pass');
    assert.equal(adminAgg.data.aggregate.waiting_review_count, 1, 'admin aggregate waiting_review_count');
    assert.equal(adminAgg.data.aggregate.blocked_task_count, 1, 'admin aggregate blocked_task_count');
    // Aggregate TTFT
    assertNumberNear(
      adminAgg.data.aggregate.time_to_first_reviewed_task_ms,
      metricScenario.ttftMs,
      100,
      'admin.aggregate.time_to_first_reviewed_task_ms',
    );
    assert.equal(adminAgg.data.aggregate.ttft_task_id, metricScenario.reviewedTaskId, 'admin aggregate ttft_task_id');
    assert.ok(adminAgg.data.aggregate.ttft_phases, 'admin aggregate ttft_phases');
    console.log('  ✅ Admin aggregate includes owned projects');

    // Other user should get empty aggregate (not owner/admin of any project)
    const otherAgg = await api(baseUrl, 'GET', '/v1/admin/notification-metrics', otherUser.token);
    assert.equal(otherAgg.status, 200);
    assert.equal(otherAgg.data.projects.length, 0);
    assert.equal(otherAgg.data.aggregate.time_to_first_reviewed_task_ms, null, 'unrelated user TTFT should be null');
    assert.equal(otherAgg.data.aggregate.ttft_task_id, null, 'unrelated user ttft_task_id should be null');
    assert.equal(otherAgg.data.aggregate.ttft_phases, null, 'unrelated user ttft_phases should be null');
    console.log('  ✅ Unrelated user aggregate is empty with null TTFT');

    // Agent API key cannot access admin aggregate
    const agentAdminAgg = await apiWithKey(baseUrl, 'GET', '/v1/admin/notification-metrics', agent1.data.api_key);
    assert.equal(agentAdminAgg.status, 403);
    console.log('  ✅ Agent API key denied on admin aggregate');

    // ── Test 10: TTFT is null for project with no reviewed tasks ──────────
    console.log('\n── Test 10: Null TTFT for unreviewed project ──');
    const { ProjectOrchestration: PO, ProjectOrchestrationStatus: POS, ProjectOrchestrationTask: POT, ProjectOrchestrationTaskStatus: POTS } = await import('../src/entities');
    const unreviewedProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Unreviewed Project',
      description: 'Project with no reviewed tasks',
    });
    assert.equal(unreviewedProject.status, 201);
    const unreviewedProjectId = unreviewedProject.data.id;

    // Add member access
    await api(baseUrl, 'POST', `/v1/projects/${unreviewedProjectId}/members`, owner.token, {
      user_id: admin.userId, role: 'admin',
    });

    // Create an orchestration with a non-reviewed task
    const unreviewedOrch = await AppDataSource.getRepository(PO).save(
      AppDataSource.getRepository(PO).create({
        projectId: unreviewedProjectId,
        title: 'Unreviewed Orchestration',
        objective: 'Test null TTFT.',
        status: POS.RUNNING,
        basePath: 'unreviewed',
        mainAgentId: agent1.data.id,
        createdByUserId: owner.userId,
      }),
    );
    await AppDataSource.getRepository(POT).save(
      AppDataSource.getRepository(POT).create({
        projectId: unreviewedProjectId,
        orchestrationId: unreviewedOrch.id,
        title: 'Pending review task',
        goal: 'Not yet reviewed.',
        status: POTS.READY_FOR_REVIEW,
        assignedAgentId: agent1.data.id,
        workerTaskPath: 'unreviewed/task.md',
        workerContextPath: 'unreviewed/context.md',
        dispatchedAt: new Date(),
        completedAt: new Date(),
      }),
    );

    const unreviewedMetrics = await api(
      baseUrl,
      'GET',
      `/v1/projects/${unreviewedProjectId}/notification-metrics`,
      owner.token,
    );
    assert.equal(unreviewedMetrics.status, 200);
    assert.equal(unreviewedMetrics.data.summary.time_to_first_reviewed_task_ms, null, 'unreviewed project TTFT should be null');
    assert.equal(unreviewedMetrics.data.summary.ttft_task_id, null, 'unreviewed project ttft_task_id should be null');
    assert.equal(unreviewedMetrics.data.summary.ttft_phases, null, 'unreviewed project ttft_phases should be null');
    console.log('  ✅ TTFT is null for project with no reviewed tasks');

    console.log('\n✅ All notification-metrics tests passed.');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const email = `${prefix}+test@example.com`;
  const res = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpassword123', display_name: prefix }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Register ${prefix} failed: ${res.status} ${JSON.stringify(data)}`);
  return { token: data.access_token, userId: data.user.id };
}

async function setupMetricScenario(
  AppDataSource: any,
  input: {
    projectId: string;
    ownerUserId: string;
    onlineAgentId: string;
    staleAgentId: string;
    offlineAgentId: string;
  },
): Promise<{
  ackLatencySeconds: number;
  fastAckLatencySeconds: number;
  oldestUnackedAgeSecondsMin: number;
  taskReviewLatencySeconds: number;
  ttftMs: number;
  reviewedTaskId: string;
}> {
  const {
    Agent,
    AgentInboxItem,
    InboxItemStatus,
    ProjectOrchestration,
    ProjectOrchestrationStatus,
    ProjectOrchestrationTask,
    ProjectOrchestrationTaskStatus,
  } = await import('../src/entities');
  const { v4: uuidv4 } = await import('uuid');

  const nowMs = Date.now();
  const ackLatencySeconds = 45;
  const fastAckLatencySeconds = 5;
  const oldestUnackedAgeSeconds = 120;
  const taskReviewLatencySeconds = 90;

  await AppDataSource.getRepository(Agent).update(input.onlineAgentId, {
    lastHeartbeatAt: new Date(nowMs - 5_000),
  });
  await AppDataSource.getRepository(Agent).update(input.staleAgentId, {
    lastHeartbeatAt: new Date(nowMs - 120_000),
  });
  await AppDataSource.getRepository(Agent).update(input.offlineAgentId, {
    lastHeartbeatAt: new Date(nowMs - 600_000),
  });

  const inboxRepo = AppDataSource.getRepository(AgentInboxItem);
  const pendingId = uuidv4();
  const pendingCreatedAt = new Date(nowMs - oldestUnackedAgeSeconds * 1000);
  await inboxRepo.insert({
    id: pendingId,
    projectId: input.projectId,
    recipientAgentId: input.onlineAgentId,
    eventType: 'metric_pending_backlog',
    title: 'Pending backlog item',
    body: 'Non-acked item used for pending backlog and oldest age metrics.',
    payload: { source: 'notification-metrics-test' },
    status: InboxItemStatus.UNREAD,
    createdAt: pendingCreatedAt,
    updatedAt: pendingCreatedAt,
  });

  const ackedCreatedAt = new Date(nowMs - 75_000);
  const ackedAt = new Date(ackedCreatedAt.getTime() + ackLatencySeconds * 1000);
  await inboxRepo.insert({
    id: uuidv4(),
    projectId: input.projectId,
    recipientAgentId: input.staleAgentId,
    eventType: 'metric_acked_item',
    title: 'Acked inbox item',
    body: 'Acked item used for ack latency metrics.',
    payload: { source: 'notification-metrics-test' },
    status: InboxItemStatus.ACKED,
    readAt: ackedAt,
    ackedAt,
    createdAt: ackedCreatedAt,
    updatedAt: ackedAt,
  });

  // Second ack item with fast latency to create p50/p95/max divergence
  const fastAckedCreatedAt = new Date(nowMs - 10_000);
  const fastAckedAt = new Date(fastAckedCreatedAt.getTime() + fastAckLatencySeconds * 1000);
  await inboxRepo.insert({
    id: uuidv4(),
    projectId: input.projectId,
    recipientAgentId: input.onlineAgentId,
    eventType: 'metric_acked_fast',
    title: 'Fast acked item',
    body: 'Fast-acked item for latency spread.',
    payload: { source: 'notification-metrics-test' },
    status: InboxItemStatus.ACKED,
    readAt: fastAckedAt,
    ackedAt: fastAckedAt,
    createdAt: fastAckedCreatedAt,
    updatedAt: fastAckedAt,
  });

  const orchestrationRepo = AppDataSource.getRepository(ProjectOrchestration);
  const orchestration = await orchestrationRepo.save(orchestrationRepo.create({
    projectId: input.projectId,
    title: 'Metrics Review Latency Orchestration',
    objective: 'Seed task review latency for notification metrics.',
    status: ProjectOrchestrationStatus.RUNNING,
    basePath: 'metrics-review-latency',
    mainAgentId: input.onlineAgentId,
    createdByUserId: input.ownerUserId,
  }));

  const dispatchedAt = new Date(nowMs - 300_000);
  const claimedAt = new Date(nowMs - 240_000);
  const completedAt = new Date(nowMs - 180_000);
  const reviewedAt = new Date(completedAt.getTime() + taskReviewLatencySeconds * 1000);
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
  const reviewedTask = await taskRepo.save(taskRepo.create({
    projectId: input.projectId,
    orchestrationId: orchestration.id,
    title: 'Reviewed metrics task',
    goal: 'Seed reviewed task latency.',
    status: ProjectOrchestrationTaskStatus.APPROVED,
    assignedAgentId: input.onlineAgentId,
    workerTaskPath: 'metrics-review-latency/task.md',
    workerContextPath: 'metrics-review-latency/context.md',
    resultPath: 'metrics-review-latency/result.md',
    evidencePath: 'metrics-review-latency/evidence.json',
    dispatchedAt,
    claimedAt,
    completedAt,
    reviewedAt,
  }));

  // Blocked task for workload indicators
  await taskRepo.save(taskRepo.create({
    projectId: input.projectId,
    orchestrationId: orchestration.id,
    title: 'Blocked metrics task',
    goal: 'Seed blocked task count.',
    status: ProjectOrchestrationTaskStatus.BLOCKED,
    assignedAgentId: input.onlineAgentId,
    workerTaskPath: 'blocked/task.md',
    workerContextPath: 'blocked/context.md',
  }));

  // Waiting review task for workload indicators
  await taskRepo.save(taskRepo.create({
    projectId: input.projectId,
    orchestrationId: orchestration.id,
    title: 'Waiting review metrics task',
    goal: 'Seed waiting review count.',
    status: ProjectOrchestrationTaskStatus.READY_FOR_REVIEW,
    assignedAgentId: input.onlineAgentId,
    workerTaskPath: 'waiting-review/task.md',
    workerContextPath: 'waiting-review/context.md',
  }));

  return {
    ackLatencySeconds,
    fastAckLatencySeconds,
    oldestUnackedAgeSecondsMin: oldestUnackedAgeSeconds - 1,
    taskReviewLatencySeconds,
    ttftMs: reviewedAt.getTime() - dispatchedAt.getTime(),
    reviewedTaskId: reviewedTask.id,
  };
}

function assertNumberNear(actual: unknown, expected: number, tolerance: number, label: string): void {
  assert.equal(typeof actual, 'number', `${label} should be a number`);
  const value = actual as number;
  assert.ok(
    Math.abs(value - expected) <= tolerance,
    `${label} expected ${expected} +/- ${tolerance}, got ${value}`,
  );
}

function assertNumberAtLeast(actual: unknown, minimum: number, label: string): void {
  assert.equal(typeof actual, 'number', `${label} should be a number`);
  const value = actual as number;
  assert.ok(value >= minimum, `${label} expected >= ${minimum}, got ${value}`);
}

async function api(
  baseUrl: string, method: string, path: string, token: string, body?: any,
): Promise<{ status: number; data: any }> {
  const options: any = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

async function apiWithKey(
  baseUrl: string, method: string, path: string, apiKey: string, body?: any,
): Promise<{ status: number; data: any }> {
  const options: any = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}
