import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'inbox-reliability-test-secret';
process.env.INBOX_LEASE_ENABLED = 'true';
process.env.INBOX_LEASE_TTL_MS = '1000'; // 1s for fast tests

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
    // Setup: owner, project, agents
    const owner = await register(baseUrl, 'reliability-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Reliability Test Project',
      description: 'Inbox reliability hardening tests',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Main Agent',
    });
    assert.equal(mainAgent.status, 201);

    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Worker Agent',
    });
    assert.equal(workerAgent.status, 201);

    await heartbeatAgent(baseUrl, mainAgent.data.api_key);
    await heartbeatAgent(baseUrl, workerAgent.data.api_key);

    // Create orchestration + task to seed inbox
    const orchestration = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
      title: 'Reliability Orchestration',
      objective: 'Test inbox reliability',
      main_agent_id: mainAgent.data.id,
      worker_agent_ids: [workerAgent.data.id],
    });
    assert.equal(orchestration.status, 201);

    // ─── Test 1: Active lease prevents duplicate delivery ───────────────────
    console.log('Test 1: Active lease suppresses immediate duplicate delivery');

    // Dispatch task to worker
    const task1 = await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Concurrent poll test task',
        goal: 'Test lease prevents duplicate delivery',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(task1.status, 201);

    // First poll leases the item.
    const poll1 = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', workerAgent.data.api_key);
    assert.equal(poll1.status, 200);
    const item1 = poll1.data.data.find((i: any) => i.task_id === task1.data.id);
    assert.ok(item1, 'Poll 1 should see the task_dispatched item');
    assert.ok(item1.lease_token, 'Item should be leased');
    assert.ok(item1.lease_expires_at, 'Item should have lease_expires_at');

    // Immediate second poll must not redeliver the unexpired lease.
    const poll2 = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', workerAgent.data.api_key);
    assert.equal(poll2.status, 200);
    const duplicate = poll2.data.data.find((i: any) => i.task_id === task1.data.id);
    assert.equal(duplicate, undefined, 'Poll 2 should not receive an actively leased item');
    assert.equal(poll2.data.meta.unread_count, 1,
      'Leased but unacked item should still count as pending');

    // Ack it for cleanup
    const ack1 = await apiWithKey(
      baseUrl, 'POST', `/v1/agent/inbox/${item1.id}/ack`, workerAgent.data.api_key,
    );
    assert.equal(ack1.status, 200);

    // ─── Test 2: Lease expiry redelivers unacked item ─────────────────────────
    console.log('Test 2: Lease expiry redelivers unacked item');

    const task2 = await apiWithKey(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
      mainAgent.data.api_key,
      {
        title: 'Lease expiry test task',
        goal: 'Test redelivery after lease expires',
        assigned_agent_id: workerAgent.data.id,
      },
    );
    assert.equal(task2.status, 201);

    // Poll to lease it
    const leasePoll = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?unread=true', workerAgent.data.api_key,
    );
    assert.equal(leasePoll.status, 200);
    const leasedItem = leasePoll.data.data.find((i: any) => i.task_id === task2.data.id);
    assert.ok(leasedItem, 'Should find the leased item');
    const originalLeaseToken = leasedItem.lease_token;
    assert.ok(originalLeaseToken, 'Item should have a lease token');
    assert.ok(leasedItem.lease_expires_at, 'Item should have lease_expires_at');

    // Wait for lease to expire (TTL is 1000ms)
    await sleep(1200);

    // Poll again — expired lease should be cleared and re-leased
    const rePoll = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?unread=true', workerAgent.data.api_key,
    );
    assert.equal(rePoll.status, 200);
    const redeliveredItem = rePoll.data.data.find((i: any) => i.task_id === task2.data.id);
    assert.ok(redeliveredItem, 'Item should be redelivered after lease expiry');
    assert.ok(redeliveredItem.lease_token, 'Redelivered item should have a new lease token');
    assert.notEqual(redeliveredItem.lease_token, originalLeaseToken,
      'Redelivered item should have a different lease token');
    assert.equal(redeliveredItem.delivery_attempts, 2,
      'Delivery attempts should be 2 after redelivery');

    // ─── Test 3: Duplicate ack is idempotent ─────────────────────────────────
    console.log('Test 3: Duplicate ack is idempotent');

    const firstAck = await apiWithKey(
      baseUrl, 'POST', `/v1/agent/inbox/${redeliveredItem.id}/ack`, workerAgent.data.api_key,
    );
    assert.equal(firstAck.status, 200);
    assert.equal(firstAck.data.status, 'acked');
    const firstAckedAt = firstAck.data.acked_at;

    // Small delay to ensure timestamps would differ if not idempotent
    await sleep(50);

    const secondAck = await apiWithKey(
      baseUrl, 'POST', `/v1/agent/inbox/${redeliveredItem.id}/ack`, workerAgent.data.api_key,
    );
    assert.equal(secondAck.status, 200);
    assert.equal(secondAck.data.status, 'acked');
    assert.equal(secondAck.data.acked_at, firstAckedAt,
      'Duplicate ack should return same acked_at (idempotent)');

    // ─── Test 4: Cursor restart/out-of-order does not hide pending items ──────
    console.log('Test 4: Cursor restart does not hide pending items');

    // Create 3 tasks
    const tasks: any[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await apiWithKey(
        baseUrl, 'POST',
        `/v1/projects/${projectId}/orchestrations/${orchestration.data.id}/tasks`,
        mainAgent.data.api_key,
        {
          title: `Cursor test task ${i}`,
          goal: `Test cursor ${i}`,
          assigned_agent_id: workerAgent.data.id,
        },
      );
      assert.equal(t.status, 201);
      tasks.push(t.data);
    }

    // Poll with limit=1 (cursor-like), ack one, then poll again
    const cursorPoll1 = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?unread=true&limit=1', workerAgent.data.api_key,
    );
    assert.equal(cursorPoll1.status, 200);
    assert.equal(cursorPoll1.data.data.length, 1);
    const cursorItem = cursorPoll1.data.data[0];

    // Ack this one
    await apiWithKey(
      baseUrl, 'POST', `/v1/agent/inbox/${cursorItem.id}/ack`, workerAgent.data.api_key,
    );

    // Poll again — remaining 2 should still be visible
    const cursorPoll2 = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox?unread=true', workerAgent.data.api_key,
    );
    assert.equal(cursorPoll2.status, 200);
    const remainingUnread = cursorPoll2.data.data.filter(
      (i: any) => tasks.some((t) => t.id === i.task_id),
    );
    assert.equal(remainingUnread.length, 2,
      'After acking 1 of 3, 2 should remain unread');

    // ─── Test 5: Unauthorized agent poll/ack is denied ───────────────────────
    console.log('Test 5: Unauthorized agent poll/ack is denied');

    // Create a different project + agent
    const otherUser = await register(baseUrl, 'reliability-other');
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', otherUser.token, {
      name: 'Other Project',
      description: 'Unauthorized access test',
    });
    assert.equal(otherProject.status, 201);
    const otherAgent = await api(
      baseUrl, 'POST', `/v1/projects/${otherProject.data.id}/agents`, otherUser.token,
      { name: 'Other Agent' },
    );
    assert.equal(otherAgent.status, 201);

    // Other agent should see empty inbox (not the worker's items)
    const otherPoll = await apiWithKey(
      baseUrl, 'GET', '/v1/agent/inbox', otherAgent.data.api_key,
    );
    assert.equal(otherPoll.status, 200);
    assert.equal(otherPoll.data.data.length, 0, 'Other agent should see empty inbox');

    // Other agent cannot ack worker's item
    const anyWorkerItem = remainingUnread[0];
    if (anyWorkerItem) {
      const wrongAck = await apiWithKey(
        baseUrl, 'POST', `/v1/agent/inbox/${anyWorkerItem.id}/ack`, otherAgent.data.api_key,
      );
      assert.equal(wrongAck.status, 404, 'Unauthorized ack should return 404');
    }

    // No auth at all
    const noAuthPoll = await fetch(`${baseUrl}/v1/agent/inbox`);
    assert.equal(noAuthPoll.status, 401, 'Unauthenticated poll should return 401');

    // ─── Test 6: Notification metrics still compute correctly ─────────────────
    console.log('Test 6: Notification metrics compute correctly');

    // First ack all remaining worker items to create known state
    for (const item of remainingUnread) {
      await apiWithKey(
        baseUrl, 'POST', `/v1/agent/inbox/${item.id}/ack`, workerAgent.data.api_key,
      );
    }

    // Owner should be able to get metrics
    const metrics = await api(
      baseUrl, 'GET',
      `/v1/projects/${projectId}/notification-metrics`,
      owner.token,
    );
    assert.equal(metrics.status, 200);
    assert.ok(metrics.data.summary, 'Metrics should have summary');
    assert.ok(metrics.data.summary.pending_inbox_total !== undefined,
      'Metrics should include pending_inbox_total');

    // Ack latency should be computable (we acked items)
    assert.ok(typeof metrics.data.summary.ack_latency_p50_seconds === 'number' || metrics.data.summary.ack_latency_p50_seconds === null,
      'Metrics should include ack_latency_p50_seconds');

    console.log('All inbox reliability tests passed');
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
    password: 'ReliabilityTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    metrics: { load: 0 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
