import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.NODE_ENV = 'test';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const {
    Agent,
    AgentRun,
    AgentRunStatus,
    Event,
    HealthMetric,
    Message,
    Project,
    Session,
    SessionStatus,
    User,
  } = await import('../src/entities');
  const {
    EventRepository,
    EventTerminalStateConflictError,
  } = await import('../src/services/event-repository.service');

  await AppDataSource.initialize();

  try {
    const manager = AppDataSource.manager;
    const repo = new EventRepository(AppDataSource);
    const fixture = await createFixture(manager, {
      Agent,
      Project,
      Session,
      SessionStatus,
      User,
    });

    const messageId = randomUUID();
    const messageInput = {
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      idempotencyKey: 'message-created-1',
      type: 'message.created',
      userId: fixture.user.id,
      actorType: 'user',
      payload: {
        message_id: messageId,
        sender_type: 'user',
        sender_id: fixture.user.id,
        content: 'hello event log',
        content_type: 'text',
      },
    };

    const first = await repo.appendEvent(messageInput);
    assert.equal(first.duplicate, false);
    assert.equal(first.event.seq, 1);

    let persistedSession = await manager.findOneByOrFail(Session, { id: fixture.session.id });
    assert.equal(persistedSession.lastSeq, 1);
    assert.equal(await manager.count(Message, { where: { sessionId: fixture.session.id } }), 1);

    const duplicate = await repo.appendEvent(messageInput);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.event.id, first.event.id);
    assert.equal(await manager.count(Event, { where: { sessionId: fixture.session.id } }), 1);
    assert.equal(await manager.count(Message, { where: { sessionId: fixture.session.id } }), 1);
    persistedSession = await manager.findOneByOrFail(Session, { id: fixture.session.id });
    assert.equal(persistedSession.lastSeq, 1);

    const queuedRunId = `run-${randomUUID()}`;
    const queuedPayload = {
      run_id: queuedRunId,
      agent_id: fixture.agent.id,
      attempt: 1,
      delivery_id: `deliv-${randomUUID()}`,
    };

    await repo.appendEvent({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      idempotencyKey: 'run-queued-1',
      type: 'agent.run.queued',
      agentId: fixture.agent.id,
      actorType: 'system',
      payload: queuedPayload,
    });
    await repo.appendEvent({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      idempotencyKey: 'run-queued-2',
      type: 'agent.run.queued',
      agentId: fixture.agent.id,
      actorType: 'system',
      payload: queuedPayload,
    });

    const queuedRuns = await manager.find(AgentRun, {
      where: {
        sessionId: fixture.session.id,
        runId: queuedRunId,
      },
    });
    assert.equal(queuedRuns.length, 1);
    assert.equal(queuedRuns[0].status, AgentRunStatus.QUEUED);

    const completedRunId = `run-${randomUUID()}`;
    await repo.appendEvent({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      idempotencyKey: 'run-started-1',
      type: 'agent.run.started',
      agentId: fixture.agent.id,
      actorType: 'system',
      payload: {
        run_id: completedRunId,
        agent_id: fixture.agent.id,
      },
    });
    await repo.appendEvent({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      idempotencyKey: 'run-completed-1',
      type: 'agent.run.completed',
      agentId: fixture.agent.id,
      actorType: 'system',
      payload: {
        run_id: completedRunId,
        agent_id: fixture.agent.id,
        duration_ms: 42,
      },
    });

    let beforeConflict = await manager.findOneByOrFail(Session, { id: fixture.session.id });
    await assert.rejects(
      () =>
        repo.appendEvent({
          projectId: fixture.project.id,
          sessionId: fixture.session.id,
          idempotencyKey: 'run-failed-after-completed',
          type: 'agent.run.failed',
          agentId: fixture.agent.id,
          actorType: 'system',
          payload: {
            run_id: completedRunId,
            agent_id: fixture.agent.id,
            error: { code: 'late_failure' },
          },
        }),
      (err: unknown) => err instanceof EventTerminalStateConflictError,
    );
    let afterConflict = await manager.findOneByOrFail(Session, { id: fixture.session.id });
    assert.equal(afterConflict.lastSeq, beforeConflict.lastSeq);
    assert.equal(
      await manager.count(Event, {
        where: {
          sessionId: fixture.session.id,
          idempotencyKey: 'run-failed-after-completed',
        },
      }),
      0,
    );

    const failedRunId = `run-${randomUUID()}`;
    await repo.appendEvent({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      idempotencyKey: 'run-failed-1',
      type: 'agent.run.failed',
      agentId: fixture.agent.id,
      actorType: 'system',
      payload: {
        run_id: failedRunId,
        agent_id: fixture.agent.id,
        error: { code: 'agent_error' },
      },
    });
    const failedRun = await manager.findOneByOrFail(AgentRun, {
      sessionId: fixture.session.id,
      runId: failedRunId,
    });
    assert.equal(failedRun.status, AgentRunStatus.FAILED);

    beforeConflict = await manager.findOneByOrFail(Session, { id: fixture.session.id });
    await assert.rejects(
      () =>
        repo.appendEvent({
          projectId: fixture.project.id,
          sessionId: fixture.session.id,
          idempotencyKey: 'run-completed-after-failed',
          type: 'agent.run.completed',
          agentId: fixture.agent.id,
          actorType: 'system',
          payload: {
            run_id: failedRunId,
            agent_id: fixture.agent.id,
            duration_ms: 13,
          },
        }),
      (err: unknown) => err instanceof EventTerminalStateConflictError,
    );
    afterConflict = await manager.findOneByOrFail(Session, { id: fixture.session.id });
    assert.equal(afterConflict.lastSeq, beforeConflict.lastSeq);

    const health = await repo.appendEvent({
      projectId: fixture.project.id,
      sessionId: fixture.session.id,
      idempotencyKey: 'health-metric-1',
      type: 'health.metric',
      agentId: fixture.agent.id,
      actorType: 'agent',
      payload: {
        name: 'run_duration_ms',
        value: 42,
        unit: 'ms',
        agent_id: fixture.agent.id,
        run_id: completedRunId,
      },
    });
    assert.equal(await manager.count(HealthMetric, { where: { eventId: health.event.id } }), 1);

    const replayed = await repo.listEventsAfterSeq(fixture.session.id, 1, 20);
    assert.ok(replayed.length > 0);
    assert.ok(replayed.every((event) => event.seq > 1));
    assert.deepEqual(
      replayed.map((event) => event.seq),
      replayed.map((event) => event.seq).sort((a, b) => a - b),
    );
    assert.equal(replayed[0].seq, 2);
    assert.equal(replayed.at(-1)?.id, health.event.id);

    console.log('event-persistence tests passed');
  } finally {
    await AppDataSource.destroy();
  }
}

async function createFixture(
  manager: any,
  entities: any,
): Promise<{
  user: any;
  project: any;
  agent: any;
  session: any;
}> {
  const user = await manager.save(
    entities.User,
    manager.create(entities.User, {
      email: `event-persistence-${Date.now()}-${randomUUID()}@example.com`,
      passwordHash: 'hashed-password',
      displayName: 'Event Persistence Test',
    }),
  );

  const project = await manager.save(
    entities.Project,
    manager.create(entities.Project, {
      name: 'event-persistence',
      ownerId: user.id,
    }),
  );

  const agent = await manager.save(
    entities.Agent,
    manager.create(entities.Agent, {
      projectId: project.id,
      name: 'event-test-agent',
      createdBy: user.id,
    }),
  );

  const session = await manager.save(
    entities.Session,
    manager.create(entities.Session, {
      projectId: project.id,
      title: 'Event Persistence',
      status: entities.SessionStatus.ACTIVE,
      createdBy: user.id,
    }),
  );

  return {
    user,
    project,
    agent,
    session,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
