import { randomUUID } from 'crypto';
import { In } from 'typeorm';
import { AppDataSource } from '../data-source';
import {
  Agent,
  AgentStatus,
  AgentInboxItem,
  InboxItemStatus,
  Message,
  MessageVisibility,
  ProjectFile,
  ProjectMemory,
  Session,
  SessionParticipant,
} from '../entities';
import { AppendEventInput, EventRepository } from './event-repository.service';
import { eventStreamService } from './event-stream.service';
import { RuntimeAdapterService } from './runtime-adapter.service';
import {
  AgentInvokeTrigger,
  ProjectMemorySnapshot,
  RecentMessage,
  RuntimeEventAppend,
  RuntimeFetch,
} from './runtime-types';

type JsonObject = Record<string, unknown>;

const DEFAULT_DISPATCH_TTL = 1;
// Real LLM agents (kimi/mimocode/etc.) need 10-60s to spin up + reason. The old
// 5s timeout killed every invoke before the agent's brain produced output — the
// root cause of 'PM dispatches but agent never responds'. 180s gives real agents
// room while still bounded. (runtime-adapter default was already 30s.)
const DISPATCH_TIMEOUT_MS = 180_000;
const MAX_RECENT_MESSAGES = 20;
const MAX_PROJECT_MEMORIES = 20;
const MAX_MEMORY_CONTENT_CHARS = 4_000;

export interface CreateSessionMessageInput {
  projectId: string;
  sessionId: string;
  userId: string;
  content: string;
  contentType?: string;
  recipientParticipantIds?: string[];
  visibility?: MessageVisibility | 'session' | 'direct';
  dispatchTtl?: number;
  idempotencyKey?: string;
  parentMessageId?: string;
}

export interface SessionDispatchServiceOptions {
  eventRepository?: EventRepository;
  runtimeAdapter?: RuntimeAdapterService;
  fetchFn?: RuntimeFetch;
}

interface DispatchContext {
  projectId: string;
  session: Session;
  message: Message;
  senderType: 'user' | 'agent' | 'system';
  senderId?: string;
  senderParticipantId?: string;
  recipientParticipantIds: string[];
  visibility: 'session' | 'direct';
  dispatchTtl: number;
  triggerEventId: string;
}

interface AgentRuntimeConfig {
  endpointUrl?: string;
  invokeSecret?: string;
}

interface RuntimeDispatchSnapshot {
  participantAgentIds: string[];
}

export class SessionDispatchService {
  private readonly eventRepository: EventRepository;
  private readonly runtimeAdapter: RuntimeAdapterService;

  constructor(options: SessionDispatchServiceOptions = {}) {
    this.eventRepository = options.eventRepository ?? new EventRepository(AppDataSource);
    this.runtimeAdapter =
      options.runtimeAdapter ??
      new RuntimeAdapterService(
        {
          appendEvent: async (event: RuntimeEventAppend) => {
            await this.appendEventAndPublish(event);
          },
        },
        {
          fetchFn: options.fetchFn,
          timeoutMs: DISPATCH_TIMEOUT_MS,
        },
      );
  }

  async createUserMessage(input: CreateSessionMessageInput): Promise<Message> {
    const content = input.content.trim();
    const recipientParticipantIds = normalizeStringArray(input.recipientParticipantIds);
    const visibility = normalizeVisibilityValue(input.visibility);
    const dispatchTtl = normalizeDispatchTtl(input.dispatchTtl);
    const messageId = randomUUID();

    const result = await this.appendEventAndPublish({
      projectId: input.projectId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey ?? `message:${messageId}`,
      type: 'message.created',
      userId: input.userId,
      actorType: 'user',
      aggregateType: 'message',
      aggregateId: messageId,
      payload: {
        message_id: messageId,
        sender_type: 'user',
        sender_id: input.userId,
        user_id: input.userId,
        content,
        content_type: normalizeContentType(input.contentType),
        parent_message_id: input.parentMessageId,
        visibility,
        recipient_participant_ids: recipientParticipantIds,
        dispatch_ttl: dispatchTtl,
      },
    });

    const message = await AppDataSource.getRepository(Message).findOneByOrFail({
      eventId: result.event.id,
    });
    const session = await AppDataSource.getRepository(Session).findOneByOrFail({
      id: input.sessionId,
      projectId: input.projectId,
    });

    if (!result.duplicate) {
      await this.dispatchForMessage({
        projectId: input.projectId,
        session,
        message,
        senderType: 'user',
        senderId: input.userId,
        recipientParticipantIds,
        visibility,
        dispatchTtl,
        triggerEventId: result.event.id,
      });
    }

    return message;
  }

  async dispatchForMessage(context: DispatchContext): Promise<void> {
    if (context.dispatchTtl <= 0) {
      return;
    }

    const participantRepo = AppDataSource.getRepository(SessionParticipant);
    const participants = await participantRepo.find({
      where: { sessionId: context.session.id },
      relations: ['agent'],
    });
    const byParticipantId = new Map(participants.map((participant) => [participant.id, participant]));
    const isBroadcast = context.recipientParticipantIds.length === 0;

    let targets: SessionParticipant[] = [];
    if (isBroadcast) {
      if (context.senderType !== 'user') {
        return;
      }
      targets = participants;
    } else {
      targets = context.recipientParticipantIds
        .map((participantId) => byParticipantId.get(participantId))
        .filter((participant): participant is SessionParticipant => Boolean(participant));
    }

    targets = targets.filter((participant) => participant.id !== context.senderParticipantId);
    targets = targets.filter((participant) => participant.agent?.status !== AgentStatus.INACTIVE);

    const snapshot: RuntimeDispatchSnapshot = {
      participantAgentIds: await this.loadParticipantAgentIds(context.session.id),
    };

    for (const participant of targets) {
      await this.invokeParticipantAgent(participant, context, snapshot);
    }
  }

  private async invokeParticipantAgent(
    participant: SessionParticipant,
    context: DispatchContext,
    snapshot: RuntimeDispatchSnapshot,
  ): Promise<void> {
    const agent = participant.agent;
    if (!agent) return;

    const runtimeConfig = getAgentRuntimeConfig(agent.configJson);
    if (!runtimeConfig.endpointUrl) {
      await this.appendSkippedRun(agent, context, 'missing_endpoint_url');
      return;
    }

    if (!runtimeConfig.invokeSecret) {
      await this.appendSkippedRun(agent, context, 'missing_invoke_secret');
      return;
    }

    const trigger: AgentInvokeTrigger = {
      kind: context.senderType === 'agent' ? 'agent_message' : 'user_message',
      type: 'message.created',
      message_id: context.message.id,
      sender_participant_id: context.senderParticipantId,
      sender_type: context.senderType,
      sender_id: context.senderId,
      recipient_participant_ids: context.recipientParticipantIds,
      visibility: context.visibility,
      dispatch_ttl: context.dispatchTtl,
    };

    await this.runtimeAdapter.invokeAgent({
      projectId: context.projectId,
      sessionId: context.session.id,
      agentId: agent.id,
      endpointUrl: runtimeConfig.endpointUrl,
      invokeSecret: runtimeConfig.invokeSecret,
      trigger,
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        endpoint_url: runtimeConfig.endpointUrl,
        system_prompt: getConfigString(agent.configJson, 'system_prompt'),
        config: sanitizeAgentConfig(agent.configJson),
        scopes: getConfigStringArray(agent.configJson, 'scopes'),
      },
      session: {
        id: context.session.id,
        project_id: context.projectId,
        title: context.session.title,
        status: context.session.status,
        participant_agent_ids: snapshot.participantAgentIds,
      },
      recentMessages: await this.loadRecentMessages(context.session.id, participant.id, agent.id),
      projectMemories: await this.loadProjectMemories(context.projectId, agent.id),
      projectRules: await this.loadProjectRules(context.projectId),
      runtime: {
        timeout_ms: DISPATCH_TIMEOUT_MS,
        max_recent_messages: MAX_RECENT_MESSAGES,
        max_attempts: 1,
        supports_async: false,
        supports_streaming: false,
      },
      timeoutMs: DISPATCH_TIMEOUT_MS,
      correlationId: context.triggerEventId,
    }).then((result) => {
      // Surface invoke failures to the agent as a durable inbox reminder so it
      // can self-diagnose. Without this, a timeout/transport error is only logged
      // as a session event the agent never sees — the agent keeps getting invoked
      // and failing silently. This is the "platform reminds the agent something
      // is wrong with its handler" channel.
      if (result && !result.ok && result.failureType) {
        notifyAgentOfInvokeFailure(agent, context, result).catch(() => {});
      }
    });
  }

  private async appendSkippedRun(
    agent: Agent,
    context: DispatchContext,
    code: 'missing_endpoint_url' | 'missing_invoke_secret',
  ): Promise<void> {
    const runId = `run_${randomUUID().replace(/-/g, '')}`;
    await this.appendEventAndPublish({
      projectId: context.projectId,
      sessionId: context.session.id,
      agentId: agent.id,
      actorType: 'system',
      type: 'agent.run.failed',
      idempotencyKey: `${runId}:failed`,
      payload: {
        run_id: runId,
        agent_id: agent.id,
        trigger_message_id: context.message.id,
        trigger_event_id: context.triggerEventId,
        status: 'failed',
        failure_type: 'invalid_response',
        error: {
          code,
          message: code === 'missing_endpoint_url'
            ? 'Agent config is missing endpoint_url'
            : 'Agent config is missing invoke_secret',
          retryable: false,
        },
        failed_at: new Date().toISOString(),
      },
    });
  }

  private async appendEventAndPublish(event: AppendEventInput) {
    const result = await this.eventRepository.appendEvent(event);
    if (!result.duplicate) {
      eventStreamService.publishPersisted(result.event);
    }

    if (!result.duplicate && result.event.type === 'message.created' && result.event.actorType === 'agent') {
      await this.dispatchForPersistedAgentMessage(result.event).catch((err) => {
        console.error('[session-dispatch] Agent message dispatch error:', err);
      });
    }

    return result;
  }

  private async dispatchForPersistedAgentMessage(event: { id: string; projectId: string; sessionId: string; payloadJson: JsonObject }): Promise<void> {
    const dispatchTtl = normalizeDispatchTtl(event.payloadJson.dispatch_ttl, 0);
    if (dispatchTtl <= 0) {
      return;
    }

    const messageId = getPayloadString(event.payloadJson, 'message_id');
    const senderAgentId = getPayloadString(event.payloadJson, 'agent_id') ?? getPayloadString(event.payloadJson, 'sender_id');
    if (!messageId || !senderAgentId) {
      return;
    }

    const [session, message, senderParticipant] = await Promise.all([
      AppDataSource.getRepository(Session).findOneBy({ id: event.sessionId, projectId: event.projectId }),
      AppDataSource.getRepository(Message).findOneBy({ id: messageId }),
      AppDataSource.getRepository(SessionParticipant).findOneBy({
        sessionId: event.sessionId,
        agentId: senderAgentId,
      }),
    ]);

    if (!session || !message) {
      return;
    }

    await this.dispatchForMessage({
      projectId: event.projectId,
      session,
      message,
      senderType: 'agent',
      senderId: senderAgentId,
      senderParticipantId: senderParticipant?.id,
      recipientParticipantIds: normalizeStringArray(event.payloadJson.recipient_participant_ids),
      visibility: normalizeVisibilityValue(event.payloadJson.visibility),
      dispatchTtl,
      triggerEventId: event.id,
    });
  }

  private async loadRecentMessages(
    sessionId: string,
    targetParticipantId: string,
    targetAgentId: string,
  ): Promise<RecentMessage[]> {
    const messages = await AppDataSource.getRepository(Message).find({
      where: { sessionId },
      order: { seq: 'DESC', createdAt: 'DESC' },
      take: MAX_RECENT_MESSAGES * 5,
    });

    return messages
      .filter((message) => isMessageVisibleToParticipant(message, targetParticipantId, targetAgentId))
      .slice(0, MAX_RECENT_MESSAGES)
      .reverse()
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        content_type: message.contentType,
        sender_type: message.senderType,
        sender_id: message.agentId ?? message.userId ?? undefined,
        agent_id: message.agentId ?? null,
        user_id: message.userId ?? null,
        created_at: message.createdAt.toISOString(),
        metadata: {
          seq: message.seq,
          visibility: message.visibility,
          recipient_participant_ids: message.recipientParticipantIds ?? [],
        },
      }));
  }

  private async loadParticipantAgentIds(sessionId: string): Promise<string[]> {
    const participants = await AppDataSource.getRepository(SessionParticipant).find({
      where: { sessionId },
      select: ['agentId'],
    });
    return participants.map((participant) => participant.agentId);
  }

  private async loadProjectMemories(projectId: string, agentId: string): Promise<ProjectMemorySnapshot[]> {
    const memories = await AppDataSource.getRepository(ProjectMemory)
      .createQueryBuilder('memory')
      .where('memory.projectId = :projectId', { projectId })
      .andWhere('(memory.agentId IS NULL OR memory.agentId = :agentId)', { agentId })
      .orderBy('memory.updatedAt', 'DESC')
      .take(MAX_PROJECT_MEMORIES)
      .getMany();

    return memories.reverse().map((memory) => ({
      id: memory.id,
      agent_id: memory.agentId ?? null,
      content: memory.content.slice(0, MAX_MEMORY_CONTENT_CHARS),
      tags: memory.tags ?? [],
      visibility: memory.visibility,
      updated_at: memory.updatedAt.toISOString(),
    }));
  }

  /**
   * Load the project rules file (AGENTS.md) maintained by the project-level main
   * agent. Its content is injected into EVERY agent's dispatch context so all
   * workers follow the same conventions (naming, commit format, deliverable
   * paths, escalation rules). Mirrors loadProjectMemories' project-wide sharing.
   * Returns null when no AGENTS.md exists yet.
   */
  private async loadProjectRules(projectId: string): Promise<{ path: string; content: string; updated_at: string } | null> {
    // Load AGENTS.md (project rules) — primary.
    const rulesFile = await AppDataSource.getRepository(ProjectFile)
      .createQueryBuilder('f')
      .where('f.project_id = :projectId', { projectId })
      .andWhere('LOWER(f.path) = :name', { name: 'agents.md' })
      .andWhere('f.deleted_at IS NULL')
      .orderBy('f.updated_at', 'DESC')
      .getOne();

    // Also load .agent/code-map.md (auto-generated code understanding).
    const codeMapFile = await AppDataSource.getRepository(ProjectFile)
      .createQueryBuilder('f')
      .where('f.project_id = :projectId', { projectId })
      .andWhere('LOWER(f.path) = :name', { name: '.agent/code-map.md' })
      .andWhere('f.deleted_at IS NULL')
      .orderBy('f.updated_at', 'DESC')
      .getOne();

    // Also load .agent/executor.md (project-level execution workflow).
    const executorFile = await AppDataSource.getRepository(ProjectFile)
      .createQueryBuilder('f')
      .where('f.project_id = :projectId', { projectId })
      .andWhere('LOWER(f.path) = :name', { name: '.agent/executor.md' })
      .andWhere('f.deleted_at IS NULL')
      .orderBy('f.updated_at', 'DESC')
      .getOne();

    if (!rulesFile && !codeMapFile && !executorFile) return null;

    // Merge: AGENTS.md → executor.md → code-map.md.
    const parts: string[] = [];
    let updatedAt = new Date(0);
    let path = 'agents.md';
    if (rulesFile) {
      parts.push(rulesFile.content.slice(0, 20000));
      if (rulesFile.updatedAt > updatedAt) updatedAt = rulesFile.updatedAt;
    }
    if (executorFile) {
      parts.push('\n\n---\n\n## Execution Workflow\n\n' + executorFile.content.slice(0, 10000));
      if (executorFile.updatedAt > updatedAt) { updatedAt = executorFile.updatedAt; }
    }
    if (codeMapFile) {
      parts.push('\n\n---\n\n## Code Map (auto-generated)\n\n' + codeMapFile.content.slice(0, 15000));
      if (codeMapFile.updatedAt > updatedAt) { updatedAt = codeMapFile.updatedAt; path = 'agents.md + executor.md + code-map.md'; }
    }
    return {
      path,
      content: parts.join('\n\n'),
      updated_at: updatedAt.toISOString(),
    };
  }
}

export function serializeMessage(message: Message): JsonObject {
  return {
    id: message.id,
    seq: message.seq,
    session_id: message.sessionId,
    project_id: message.projectId ?? null,
    role: message.role,
    sender_type: message.senderType ?? message.role,
    sender_id: message.agentId ?? message.userId ?? null,
    agent_id: message.agentId ?? null,
    user_id: message.userId ?? null,
    content: message.content,
    content_type: message.contentType,
    visibility: message.visibility,
    recipient_participant_ids: message.recipientParticipantIds ?? [],
    parent_message_id: message.parentMessageId ?? null,
    created_at: message.createdAt,
  };
}

export function serializeParticipant(participant: SessionParticipant): JsonObject {
  return {
    id: participant.id,
    session_id: participant.sessionId,
    participant_type: 'agent',
    ref_id: participant.agentId,
    agent_id: participant.agentId,
    role: 'agent',
    status: 'active',
    joined_at: participant.joinedAt,
  };
}

export function serializeSession(session: Session, participants: SessionParticipant[]): JsonObject {
  return {
    id: session.id,
    project_id: session.projectId,
    title: session.title,
    status: session.status,
    participants: participants.map(serializeParticipant),
    agent_ids: participants.map((participant) => participant.agentId),
    participant_agent_ids: participants.map((participant) => participant.agentId),
    last_seq: session.lastSeq,
    created_by: session.createdBy,
    version: session.version,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  };
}

export async function loadParticipants(sessionId: string): Promise<SessionParticipant[]> {
  return AppDataSource.getRepository(SessionParticipant).find({
    where: { sessionId },
    order: { joinedAt: 'ASC' },
  });
}

export async function findSessionById(sessionId: string, projectId?: string): Promise<Session | null> {
  return AppDataSource.getRepository(Session).findOne({
    where: projectId ? { id: sessionId, projectId } : { id: sessionId },
  });
}

export async function listSessionMessages(sessionId: string): Promise<Message[]> {
  return AppDataSource.getRepository(Message).find({
    where: { sessionId },
    order: { seq: 'ASC', createdAt: 'ASC' },
  });
}

export async function findAgentsForSession(projectId: string, agentIds: string[]): Promise<Agent[]> {
  if (agentIds.length === 0) return [];
  return AppDataSource.getRepository(Agent).find({
    where: {
      id: In(agentIds),
      projectId,
    },
  });
}

function getAgentRuntimeConfig(config: Record<string, unknown> | undefined): AgentRuntimeConfig {
  return {
    endpointUrl: getConfigString(config, 'endpoint_url'),
    invokeSecret: getConfigString(config, 'invoke_secret'),
  };
}

function getConfigString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getConfigStringArray(config: Record<string, unknown> | undefined, key: string): string[] {
  const value = config?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sanitizeAgentConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const sanitized = { ...(config ?? {}) };
  delete sanitized.invoke_secret;
  return sanitized;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeContentType(value: unknown): string {
  return value === 'markdown' || value === 'json' || value === 'text' ? value : 'text';
}

function normalizeVisibilityValue(value: unknown): MessageVisibility {
  return value === MessageVisibility.DIRECT || value === 'direct'
    ? MessageVisibility.DIRECT
    : MessageVisibility.SESSION;
}

function isMessageVisibleToParticipant(
  message: Message,
  targetParticipantId: string,
  targetAgentId: string,
): boolean {
  if (message.visibility !== MessageVisibility.DIRECT) {
    return true;
  }

  if (message.agentId === targetAgentId) {
    return true;
  }

  return (message.recipientParticipantIds ?? []).includes(targetParticipantId);
}

function normalizeDispatchTtl(value: unknown, defaultValue = DEFAULT_DISPATCH_TTL): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return Math.min(value, 8);
  }
  return defaultValue;
}

function getPayloadString(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Throttle: don't spam the agent with the same failure reminder more than once
// per few minutes. Keyed by agent + failure type.
const recentFailureReminders = new Map<string, number>();
const FAILURE_REMINDER_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * When an agent invoke fails, push a durable inbox reminder to the agent so it
 * can self-diagnose. This is how the platform "tells the agent something is
 * wrong with its handler" — the agent's daemon reads its inbox and surfaces the
 * failure with concrete remediation. Without this, invoke failures are silent
 * (only logged as session events the agent never sees).
 */
async function notifyAgentOfInvokeFailure(
  agent: Agent,
  context: DispatchContext,
  result: { failureType?: string; failureCode?: string; failureMessage?: string; durationMs?: number },
): Promise<void> {
  if (!agent.id) return;
  const failureType = result.failureType ?? 'unknown';
  const dedupeKey = `${agent.id}:${failureType}`;
  const now = Date.now();
  const last = recentFailureReminders.get(dedupeKey) ?? 0;
  if (now - last < FAILURE_REMINDER_COOLDOWN_MS) return; // throttled
  recentFailureReminders.set(dedupeKey, now);

  // Concrete, per-failure-type remediation guidance.
  const hints: Record<string, string> = {
    timeout: (
      'Your invoke handler took longer than the platform timeout. Make your handler\n' +
      'return a reply FAST (under ~120s). If your backend is slow to start, keep it\n' +
      'warm, or return an interim "processing" reply and do the work asynchronously.'
    ),
    transport_error: (
      'The platform could not reach your invoke endpoint (connection refused / network).\n' +
      'Check that your invoke server is running and the registered endpoint_url is\n' +
      'reachable from the platform host. Restart: python3 invoke_server.py --port <port> ...'
    ),
    agent_error: (
      'Your invoke endpoint returned an error response. Check your handler script:\n' +
      '  - run it manually with a sample invoke JSON on stdin and read stderr\n' +
      '  - verify the backend command it calls exists and works (e.g. `mimo run "test"`)\n' +
      '  - the handler must print ONLY the reply content (no JSON wrapping)'
    ),
    invalid_response: (
      'Your invoke endpoint returned a malformed response. The handler must print the\n' +
      'reply text (or {"content":"..."} JSON) on stdout. Do NOT print the full\n' +
      '{"status":"completed",...} envelope — the invoke server already wraps it.'
    ),
  };
  const hint = hints[failureType] ?? `Inspect your invoke handler (failure: ${failureType}).`;
  const dur = result.durationMs ? ` (${result.durationMs}ms)` : '';

  const repo = AppDataSource.getRepository(AgentInboxItem);
  await repo.save(repo.create({
    id: randomUUID(),
    projectId: context.projectId,
    recipientAgentId: agent.id,
    orchestrationId: null,
    taskId: null,
    eventType: 'invoke_failed',
    title: `⚠ Invoke failed: ${failureType}${dur}`,
    body: [
      `Agent: ${agent.name}`,
      `Failure: ${result.failureMessage ?? failureType}`,
      '',
      '## How to fix',
      hint,
      '',
      '## Diagnose locally',
      'Send a test invoke to your own endpoint and watch stderr:',
      '  curl -X POST http://localhost:<port>/zz/v1/invoke -H "Content-Type: application/json" \\',
      '    -d \'{"agent_id":"<your-id>","trigger":{"type":"message.created"},"recent_messages":[{"sender_type":"user","content":"ping"}]}\'',
    ].join('\n'),
    status: InboxItemStatus.UNREAD,
  }));
}
