import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RuntimeFetch } from '../src/services/runtime-types';

process.env.NODE_ENV = 'test';

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const {
    Agent,
    AgentRun,
    AgentRunStatus,
    Event,
    Message,
    MessageRole,
    MessageVisibility,
    Project,
    ProjectMemory,
    ProjectMemoryVisibility,
    Session,
    SessionParticipant,
    SessionStatus,
    User,
  } = await import('../src/entities');
  const { EventRepository } = await import('../src/services/event-repository.service');
  const { eventStreamService } = await import('../src/services/event-stream.service');
  const { SessionDispatchService } = await import('../src/services/session-dispatch.service');
  await AppDataSource.initialize();

  try {
    const manager = AppDataSource.manager;
    const user = await manager.save(
      User,
      manager.create(User, {
        email: `session-dispatch-${Date.now()}-${randomUUID()}@example.com`,
        passwordHash: 'hashed-password',
        displayName: 'Session Dispatch Test',
      }),
    );
    const project = await manager.save(
      Project,
      manager.create(Project, {
        name: 'session-dispatch',
        ownerId: user.id,
      }),
    );
    const agent = await manager.save(
      Agent,
      manager.create(Agent, {
        projectId: project.id,
        name: 'runtime-target',
        configJson: {
          endpoint_url: 'https://agent.example.test/zz/v1/invoke',
          invoke_secret: 'runtime-secret',
        },
        createdBy: user.id,
      }),
    );
    const session = await manager.save(
      Session,
      manager.create(Session, {
        projectId: project.id,
        title: 'Session Dispatch',
        status: SessionStatus.ACTIVE,
        createdBy: user.id,
      }),
    );
    const participant = await manager.save(
      SessionParticipant,
      manager.create(SessionParticipant, {
        sessionId: session.id,
        agentId: agent.id,
      }),
    );
    await manager.save(
      ProjectMemory,
      manager.create(ProjectMemory, {
        projectId: project.id,
        content: 'Shared project memory',
        tags: ['shared'],
        visibility: ProjectMemoryVisibility.PROJECT,
        authorUserId: user.id,
      }),
    );
    await manager.save(
      ProjectMemory,
      manager.create(ProjectMemory, {
        projectId: project.id,
        agentId: agent.id,
        content: 'Target agent memory',
        tags: ['target'],
        visibility: ProjectMemoryVisibility.AGENT,
        authorUserId: user.id,
      }),
    );
    const otherAgent = await manager.save(
      Agent,
      manager.create(Agent, {
        projectId: project.id,
        name: 'other-agent',
        configJson: {
          endpoint_url: 'https://agent.example.test/zz/v1/invoke',
          invoke_secret: 'runtime-secret',
        },
        createdBy: user.id,
      }),
    );
    const otherParticipant = await manager.save(
      SessionParticipant,
      manager.create(SessionParticipant, {
        sessionId: session.id,
        agentId: otherAgent.id,
      }),
    );
    await manager.save(
      Message,
      manager.create(Message, {
        projectId: project.id,
        sessionId: session.id,
        seq: 1,
        agentId: otherAgent.id,
        senderType: 'agent',
        role: MessageRole.AGENT,
        content: 'Private message for other participant only',
        contentType: 'text',
        visibility: MessageVisibility.DIRECT,
        recipientParticipantIds: [otherParticipant.id],
      }),
    );
    await manager.save(
      Message,
      manager.create(Message, {
        projectId: project.id,
        sessionId: session.id,
        seq: 2,
        userId: user.id,
        senderType: 'user',
        role: MessageRole.USER,
        content: 'Visible session context',
        contentType: 'text',
        visibility: MessageVisibility.SESSION,
      }),
    );
    await manager.save(
      ProjectMemory,
      manager.create(ProjectMemory, {
        projectId: project.id,
        agentId: otherAgent.id,
        content: 'Other agent private memory',
        tags: ['other'],
        visibility: ProjectMemoryVisibility.AGENT,
        authorUserId: user.id,
      }),
    );

    const fetchBodies: unknown[] = [];
    const fetchFn: RuntimeFetch = async (_url, init) => {
      fetchBodies.push(JSON.parse(init.body));
      return {
        status: 200,
        async text() {
          return JSON.stringify({ status: 'no_reply' });
        },
      };
    };
    const service = new SessionDispatchService({
      eventRepository: new EventRepository(AppDataSource),
      fetchFn,
    });

    const message = await service.createUserMessage({
      projectId: project.id,
      sessionId: session.id,
      userId: user.id,
      content: 'Please inspect this targeted task',
      contentType: 'markdown',
      recipientParticipantIds: [participant.id],
      visibility: 'direct',
      dispatchTtl: 1,
      idempotencyKey: 'session-dispatch-message-1',
    });

    const events = await manager.find(Event, {
      where: { sessionId: session.id },
      order: { seq: 'ASC' },
    });
    assert.deepEqual(
      events.map((event) => event.type),
      ['message.created', 'agent.run.queued', 'agent.run.started', 'agent.run.completed'],
    );
    assert.deepEqual(
      eventStreamService.getEvents(session.id).map((event) => event.type),
      events.map((event) => event.type),
    );
    assert.equal(events[0].payloadJson.content, 'Please inspect this targeted task');
    assert.deepEqual(events[0].payloadJson.recipient_participant_ids, [participant.id]);
    assert.equal(events[0].payloadJson.dispatch_ttl, 1);

    const persistedMessage = await manager.findOneByOrFail(Message, { id: message.id });
    assert.equal(persistedMessage.eventId, events[0].id);
    assert.equal(persistedMessage.contentType, 'markdown');
    assert.equal(persistedMessage.visibility, 'direct');
    assert.deepEqual(persistedMessage.recipientParticipantIds, [participant.id]);

    assert.equal(fetchBodies.length, 1);
    const request = fetchBodies[0] as any;
    assert.equal(request.protocol_version, 'runtime.v1');
    assert.equal(request.agent.id, agent.id);
    assert.equal(request.trigger.message_id, message.id);
    assert.deepEqual(request.trigger.recipient_participant_ids, [participant.id]);
    assert.ok(request.session.participant_agent_ids.includes(agent.id));
    assert.ok(request.session.participant_agent_ids.includes(otherAgent.id));
    assert.ok(
      request.recent_messages.some((recent: any) => recent.content === 'Visible session context'),
      'session-visible context should be sent to the target agent',
    );
    assert.ok(
      request.recent_messages.some((recent: any) => recent.content === 'Please inspect this targeted task'),
      'the target direct message should be sent to the target agent',
    );
    assert.ok(
      !request.recent_messages.some(
        (recent: any) => recent.content === 'Private message for other participant only',
      ),
      'direct messages for other participants must not be sent to the target agent',
    );
    assert.deepEqual(
      request.project_memories.map((memory: any) => memory.content),
      ['Shared project memory', 'Target agent memory'],
    );

    const run = await manager.findOneByOrFail(AgentRun, {
      sessionId: session.id,
      agentId: agent.id,
    });
    assert.equal(run.status, AgentRunStatus.COMPLETED);

    console.log('session-dispatch tests passed');
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
