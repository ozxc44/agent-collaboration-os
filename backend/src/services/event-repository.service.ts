import crypto from 'crypto';
import { DataSource, EntityManager, MoreThan, QueryRunner } from 'typeorm';
import { AppDataSource } from '../data-source';
import {
  AgentRun,
  AgentRunStatus,
  Event,
  EventIdempotencyKey,
  EventIdempotencyStatus,
  HealthMetric,
  Message,
  MessageRole,
  MessageVisibility,
} from '../entities';

type JsonObject = Record<string, unknown>;

export interface AppendEventInput {
  projectId: string;
  sessionId: string;
  idempotencyKey: string;
  type: string;
  payload: JsonObject;
  metadata?: JsonObject;
  agentId?: string;
  userId?: string;
  actorType?: string;
  aggregateType?: string;
  aggregateId?: string;
  traceId?: string;
  correlationId?: string;
  schemaVersion?: number;
}

export interface AppendEventResult {
  event: Event;
  duplicate: boolean;
}

export class EventRepositoryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export class EventIdempotencyConflictError extends EventRepositoryError {
  constructor(message: string) {
    super(message, 'idempotency_conflict');
  }
}

export class EventTerminalStateConflictError extends EventRepositoryError {
  constructor(message: string) {
    super(message, 'terminal_state_conflict');
  }
}

export class EventValidationError extends EventRepositoryError {
  constructor(message: string) {
    super(message, 'event_validation_error');
  }
}

interface ReservedIdempotency {
  record?: EventIdempotencyKey;
  existingEvent?: Event;
}

interface SeqAllocation {
  seq: number;
  projectId: string;
}

export class EventRepository {
  constructor(private readonly dataSource: DataSource = AppDataSource) {}

  async appendEvent(input: AppendEventInput, queryRunner?: QueryRunner): Promise<AppendEventResult> {
    this.validateAppendInput(input);

    const ownsQueryRunner = !queryRunner;
    const runner = queryRunner ?? this.dataSource.createQueryRunner();
    const startsTransaction = !runner.isTransactionActive;

    if (ownsQueryRunner) {
      await runner.connect();
    }

    if (startsTransaction) {
      await this.startReadCommittedTransaction(runner);
    }

    try {
      const result = await this.appendEventInTransaction(input, runner);

      if (startsTransaction) {
        await runner.commitTransaction();
      }

      return result;
    } catch (err) {
      if (startsTransaction && runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      throw err;
    } finally {
      if (ownsQueryRunner) {
        await runner.release();
      }
    }
  }

  async listEventsAfterSeq(
    sessionId: string,
    afterSeq: number,
    limit = 100,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<Event[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));

    return manager.find(Event, {
      where: {
        sessionId,
        seq: MoreThan(afterSeq),
      },
      order: { seq: 'ASC' },
      take: boundedLimit,
    });
  }

  private async appendEventInTransaction(
    input: AppendEventInput,
    queryRunner: QueryRunner,
  ): Promise<AppendEventResult> {
    const manager = queryRunner.manager;
    const requestHash = hashAppendRequest(input);
    const reservation = await this.reserveIdempotencyKey(queryRunner, input, requestHash);

    if (reservation.existingEvent) {
      return {
        event: reservation.existingEvent,
        duplicate: true,
      };
    }

    if (!reservation.record) {
      throw new EventRepositoryError('Idempotency reservation failed', 'idempotency_reservation_failed');
    }

    const allocation = await this.allocateSessionSeq(queryRunner, input.sessionId);

    if (allocation.projectId !== input.projectId) {
      throw new EventValidationError('Session does not belong to the provided project');
    }

    const event = manager.create(Event, {
      projectId: input.projectId,
      sessionId: input.sessionId,
      seq: allocation.seq,
      agentId: input.agentId,
      userId: input.userId,
      actorType: input.actorType,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payloadJson: input.payload,
      metadataJson: input.metadata,
      schemaVersion: input.schemaVersion ?? 1,
      traceId: input.traceId,
      correlationId: input.correlationId,
    });

    const savedEvent = await manager.save(Event, event);
    await this.materializeEvent(manager, savedEvent);

    await manager.update(
      EventIdempotencyKey,
      { id: reservation.record.id },
      {
        status: EventIdempotencyStatus.COMMITTED,
        eventId: savedEvent.id,
        committedAt: new Date(),
      },
    );

    return {
      event: savedEvent,
      duplicate: false,
    };
  }

  private async startReadCommittedTransaction(queryRunner: QueryRunner): Promise<void> {
    if (this.dataSource.options.type === 'postgres') {
      await queryRunner.startTransaction('READ COMMITTED');
      return;
    }

    await queryRunner.startTransaction();
  }

  private async reserveIdempotencyKey(
    queryRunner: QueryRunner,
    input: AppendEventInput,
    requestHash: string,
  ): Promise<ReservedIdempotency> {
    const manager = queryRunner.manager;
    const reservationId = crypto.randomUUID();

    if (this.dataSource.options.type === 'postgres') {
      const rows = await queryRunner.query(
        `INSERT INTO event_idempotency_keys (
           id,
           project_id,
           session_id,
           idempotency_key,
           request_hash,
           status,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (session_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          reservationId,
          input.projectId,
          input.sessionId,
          input.idempotencyKey,
          requestHash,
          EventIdempotencyStatus.RESERVED,
        ],
      );

      if (firstRawRow(rows)) {
        return {
          record: manager.create(EventIdempotencyKey, {
            id: reservationId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            key: input.idempotencyKey,
            requestHash,
            status: EventIdempotencyStatus.RESERVED,
          }),
        };
      }
    } else {
      await queryRunner.query(
        `INSERT OR IGNORE INTO event_idempotency_keys (
           id,
           project_id,
           session_id,
           idempotency_key,
           request_hash,
           status,
           created_at,
           updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          reservationId,
          input.projectId,
          input.sessionId,
          input.idempotencyKey,
          requestHash,
          EventIdempotencyStatus.RESERVED,
        ],
      );

      const inserted = await manager.findOne(EventIdempotencyKey, {
        where: { id: reservationId },
      });

      if (inserted) {
        return { record: inserted };
      }
    }

    const existing = await manager.findOne(EventIdempotencyKey, {
      where: {
        sessionId: input.sessionId,
        key: input.idempotencyKey,
      },
    });

    if (!existing) {
      throw new EventRepositoryError('Idempotency reservation disappeared', 'missing_idempotency_key');
    }

    return this.resolveExistingIdempotency(manager, existing, input, requestHash);
  }

  private async resolveExistingIdempotency(
    manager: EntityManager,
    existing: EventIdempotencyKey,
    input: AppendEventInput,
    requestHash: string,
  ): Promise<ReservedIdempotency> {
    if (existing.projectId !== input.projectId) {
      throw new EventIdempotencyConflictError('Idempotency key is already used by another project');
    }

    if (existing.requestHash !== requestHash) {
      throw new EventIdempotencyConflictError(
        'Idempotency key was reused with a different event request',
      );
    }

    if (existing.status !== EventIdempotencyStatus.COMMITTED || !existing.eventId) {
      throw new EventIdempotencyConflictError('Idempotency key is already reserved');
    }

    const event = await manager.findOne(Event, {
      where: { id: existing.eventId },
    });

    if (!event) {
      throw new EventRepositoryError(
        'Committed idempotency key points to a missing event',
        'missing_idempotent_event',
      );
    }

    return { existingEvent: event };
  }

  private async allocateSessionSeq(queryRunner: QueryRunner, sessionId: string): Promise<SeqAllocation> {
    if (this.dataSource.options.type === 'postgres') {
      const rows = await queryRunner.query(
        `UPDATE sessions
           SET last_seq = last_seq + 1,
               version = version + 1
         WHERE id = $1
         RETURNING last_seq AS "lastSeq", project_id AS "projectId"`,
        [sessionId],
      );
      const row = firstRawRow(rows);
      if (!row) {
        throw new EventValidationError('Session not found');
      }

      const lastSeq = readRawColumn(row, 'lastSeq', 'lastseq', 'last_seq');
      const projectId = readRawColumn(row, 'projectId', 'projectid', 'project_id');
      if (lastSeq === undefined || projectId === undefined) {
        throw new EventRepositoryError('Unable to read session sequence allocation', 'invalid_seq_allocation');
      }

      return {
        seq: Number(lastSeq),
        projectId: String(projectId),
      };
    }

    await queryRunner.query(
      `UPDATE sessions
          SET last_seq = last_seq + 1,
              version = version + 1
        WHERE id = ?`,
      [sessionId],
    );

    const rows = await queryRunner.query(
      `SELECT last_seq AS "lastSeq", project_id AS "projectId"
         FROM sessions
        WHERE id = ?`,
      [sessionId],
    );
    const row = firstRawRow(rows);
    if (!row) {
      throw new EventValidationError('Session not found');
    }

    const lastSeq = readRawColumn(row, 'lastSeq', 'lastseq', 'last_seq');
    const projectId = readRawColumn(row, 'projectId', 'projectid', 'project_id');
    if (lastSeq === undefined || projectId === undefined) {
      throw new EventRepositoryError('Unable to read session sequence allocation', 'invalid_seq_allocation');
    }

    return {
      seq: Number(lastSeq),
      projectId: String(projectId),
    };
  }

  private async materializeEvent(manager: EntityManager, event: Event): Promise<void> {
    switch (event.type) {
      case 'message.created':
        await this.materializeMessageCreated(manager, event);
        return;
      case 'agent.run.queued':
        await this.materializeRunQueued(manager, event);
        return;
      case 'agent.run.started':
        await this.materializeRunStarted(manager, event);
        return;
      case 'agent.run.completed':
        await this.materializeRunTerminal(manager, event, AgentRunStatus.COMPLETED);
        return;
      case 'agent.run.failed':
        await this.materializeRunTerminal(manager, event, AgentRunStatus.FAILED);
        return;
      case 'health.metric':
        await this.materializeHealthMetric(manager, event);
        return;
      default:
        return;
    }
  }

  private async materializeMessageCreated(manager: EntityManager, event: Event): Promise<void> {
    const payload = event.payloadJson;
    const content = getString(payload, 'content');

    if (content === undefined) {
      throw new EventValidationError('message.created requires payload.content');
    }

    const senderType = getString(payload, 'sender_type') ?? event.actorType;
    const sourceMessageId = getString(payload, 'message_id') ?? getString(payload, 'id');
    const senderId = getString(payload, 'sender_id');
    const role = normalizeMessageRole(getString(payload, 'role'), senderType, event);
    const agentId = getString(payload, 'agent_id') ?? (senderType === 'agent' ? senderId : undefined) ?? event.agentId;
    const userId = getString(payload, 'user_id') ?? (senderType === 'user' ? senderId : undefined) ?? event.userId;

    const message = manager.create(Message, {
      id: sourceMessageId && isUuid(sourceMessageId) ? sourceMessageId : undefined,
      projectId: event.projectId,
      sessionId: event.sessionId,
      eventId: event.id,
      seq: event.seq,
      agentId,
      userId,
      senderType,
      sourceMessageId,
      role,
      content,
      contentType: getString(payload, 'content_type') ?? 'text',
      parentMessageId: getString(payload, 'parent_message_id'),
      visibility: normalizeMessageVisibility(getString(payload, 'visibility')),
      recipientParticipantIds: getStringArray(payload, 'recipient_participant_ids'),
      details: getObject(payload, 'details'),
      createdAt: event.createdAt,
    });

    await manager.save(Message, message);
  }

  private async materializeRunQueued(manager: EntityManager, event: Event): Promise<void> {
    const payload = event.payloadJson;
    const runId = requirePayloadString(payload, 'run_id', 'agent.run.queued');
    const agentId = getString(payload, 'agent_id') ?? event.agentId;

    if (!agentId) {
      throw new EventValidationError('agent.run.queued requires agent_id');
    }

    const existing = await this.findRun(manager, event.sessionId, runId);
    if (existing) {
      return;
    }

    const run = manager.create(AgentRun, {
      projectId: event.projectId,
      sessionId: event.sessionId,
      agentId,
      runId,
      status: AgentRunStatus.QUEUED,
      attempt: getNumber(payload, 'attempt') ?? 1,
      deliveryId: getString(payload, 'delivery_id'),
      triggerEventId: getString(payload, 'trigger_event_id'),
      queuedEventId: event.id,
      queuedAt: event.createdAt,
      metricsJson: getObject(payload, 'metrics'),
    });

    await manager.save(AgentRun, run);
  }

  private async materializeRunStarted(manager: EntityManager, event: Event): Promise<void> {
    const payload = event.payloadJson;
    const runId = requirePayloadString(payload, 'run_id', 'agent.run.started');
    const agentId = getString(payload, 'agent_id') ?? event.agentId;

    if (!agentId) {
      throw new EventValidationError('agent.run.started requires agent_id');
    }

    const existing = await this.findRun(manager, event.sessionId, runId);
    if (existing) {
      if (isTerminalRun(existing.status)) {
        throw new EventTerminalStateConflictError(
          `Cannot start run ${runId} after terminal status ${existing.status}`,
        );
      }

      existing.status = AgentRunStatus.RUNNING;
      existing.startedEventId = existing.startedEventId ?? event.id;
      existing.startedAt = existing.startedAt ?? event.createdAt;
      existing.attempt = getNumber(payload, 'attempt') ?? existing.attempt;
      existing.deliveryId = getString(payload, 'delivery_id') ?? existing.deliveryId;
      await manager.save(AgentRun, existing);
      return;
    }

    const run = manager.create(AgentRun, {
      projectId: event.projectId,
      sessionId: event.sessionId,
      agentId,
      runId,
      status: AgentRunStatus.RUNNING,
      attempt: getNumber(payload, 'attempt') ?? 1,
      deliveryId: getString(payload, 'delivery_id'),
      startedEventId: event.id,
      startedAt: event.createdAt,
    });

    await manager.save(AgentRun, run);
  }

  private async materializeRunTerminal(
    manager: EntityManager,
    event: Event,
    terminalStatus: AgentRunStatus.COMPLETED | AgentRunStatus.FAILED,
  ): Promise<void> {
    const payload = event.payloadJson;
    const runId = requirePayloadString(payload, 'run_id', event.type);
    const agentId = getString(payload, 'agent_id') ?? event.agentId;

    if (!agentId) {
      throw new EventValidationError(`${event.type} requires agent_id`);
    }

    const existing = await this.findRun(manager, event.sessionId, runId);
    const oppositeStatus =
      terminalStatus === AgentRunStatus.COMPLETED ? AgentRunStatus.FAILED : AgentRunStatus.COMPLETED;

    if (existing?.status === oppositeStatus) {
      throw new EventTerminalStateConflictError(
        `Cannot mark run ${runId} as ${terminalStatus} after ${oppositeStatus}`,
      );
    }

    if (existing?.status === terminalStatus) {
      return;
    }

    const durationMs = getNumber(payload, 'duration_ms');
    const errorJson = getObject(payload, 'error');
    const metricsJson = getObject(payload, 'metrics');

    if (existing) {
      existing.status = terminalStatus;
      existing.terminalEventId = event.id;
      existing.durationMs = durationMs ?? existing.durationMs;
      existing.metricsJson = metricsJson ?? existing.metricsJson;

      if (terminalStatus === AgentRunStatus.COMPLETED) {
        existing.completedAt = event.createdAt;
      } else {
        existing.failedAt = event.createdAt;
        existing.errorJson = errorJson;
      }

      await manager.save(AgentRun, existing);
      return;
    }

    const run = manager.create(AgentRun, {
      projectId: event.projectId,
      sessionId: event.sessionId,
      agentId,
      runId,
      status: terminalStatus,
      attempt: getNumber(payload, 'attempt') ?? 1,
      deliveryId: getString(payload, 'delivery_id'),
      terminalEventId: event.id,
      completedAt: terminalStatus === AgentRunStatus.COMPLETED ? event.createdAt : undefined,
      failedAt: terminalStatus === AgentRunStatus.FAILED ? event.createdAt : undefined,
      durationMs,
      errorJson: terminalStatus === AgentRunStatus.FAILED ? errorJson : undefined,
      metricsJson,
    });

    await manager.save(AgentRun, run);
  }

  private async materializeHealthMetric(manager: EntityManager, event: Event): Promise<void> {
    const payload = event.payloadJson;
    const name = getString(payload, 'name') ?? getString(payload, 'metric');
    const value = getNumber(payload, 'value');

    if (!name) {
      throw new EventValidationError('health.metric requires name or metric');
    }

    if (value === undefined) {
      throw new EventValidationError('health.metric requires numeric value');
    }

    const healthMetric = manager.create(HealthMetric, {
      projectId: event.projectId,
      sessionId: getString(payload, 'session_id') ?? event.sessionId,
      agentId: getString(payload, 'agent_id') ?? event.agentId,
      runId: getString(payload, 'run_id'),
      eventId: event.id,
      name,
      value,
      unit: getString(payload, 'unit'),
      status: getString(payload, 'status'),
      tagsJson: getObject(payload, 'tags'),
      detailsJson: getObject(payload, 'details'),
      recordedAt: getDate(payload, 'recorded_at') ?? event.createdAt,
    });

    await manager.save(HealthMetric, healthMetric);
  }

  private async findRun(
    manager: EntityManager,
    sessionId: string,
    runId: string,
  ): Promise<AgentRun | null> {
    return manager.findOne(AgentRun, {
      where: {
        sessionId,
        runId,
      },
    });
  }

  private validateAppendInput(input: AppendEventInput): void {
    if (!input.projectId) {
      throw new EventValidationError('projectId is required');
    }
    if (!input.sessionId) {
      throw new EventValidationError('sessionId is required');
    }
    if (!input.idempotencyKey) {
      throw new EventValidationError('idempotencyKey is required');
    }
    if (!input.type) {
      throw new EventValidationError('type is required');
    }
    if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new EventValidationError('payload must be an object');
    }
  }
}

export const eventRepository = new EventRepository();

function hashAppendRequest(input: AppendEventInput): string {
  const material = stableStringify({
    projectId: input.projectId,
    sessionId: input.sessionId,
    type: input.type,
    payload: input.payload,
    metadata: input.metadata ?? null,
    agentId: input.agentId ?? null,
    userId: input.userId ?? null,
    actorType: input.actorType ?? null,
    aggregateType: input.aggregateType ?? null,
    aggregateId: input.aggregateId ?? null,
    schemaVersion: input.schemaVersion ?? 1,
  });

  return crypto.createHash('sha256').update(material).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const record = value as JsonObject;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

function readRawColumn(row: unknown, ...keys: string[]): unknown {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function firstRawRow(result: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(result)) return undefined;
  const first = result[0];
  if (Array.isArray(first)) {
    const nestedFirst = first[0];
    return nestedFirst && typeof nestedFirst === 'object'
      ? (nestedFirst as Record<string, unknown>)
      : undefined;
  }
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined;
}

function requirePayloadString(payload: JsonObject, key: string, eventType: string): string {
  const value = getString(payload, key);
  if (!value) {
    throw new EventValidationError(`${eventType} requires ${key}`);
  }
  return value;
}

function getString(payload: JsonObject, key: string): string | undefined {
  const value = payload[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return undefined;
}

function getStringArray(payload: JsonObject, key: string): string[] | undefined {
  const value = payload[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
}

function getNumber(payload: JsonObject, key: string): number | undefined {
  const value = payload[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getObject(payload: JsonObject, key: string): JsonObject | undefined {
  const value = payload[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return undefined;
}

function getDate(payload: JsonObject, key: string): Date | undefined {
  const value = payload[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeMessageRole(
  role: string | undefined,
  senderType: string | undefined,
  event: Event,
): MessageRole {
  if (role === MessageRole.USER || role === MessageRole.AGENT || role === MessageRole.SYSTEM) {
    return role;
  }

  if (senderType === 'user' || event.userId) {
    return MessageRole.USER;
  }

  if (senderType === 'agent' || event.agentId) {
    return MessageRole.AGENT;
  }

  return MessageRole.SYSTEM;
}

function normalizeMessageVisibility(visibility: string | undefined): MessageVisibility {
  return visibility === MessageVisibility.DIRECT
    ? MessageVisibility.DIRECT
    : MessageVisibility.SESSION;
}

function isTerminalRun(status: AgentRunStatus): boolean {
  return status === AgentRunStatus.COMPLETED || status === AgentRunStatus.FAILED;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
