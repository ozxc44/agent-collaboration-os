import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Session } from './session.entity';

@Entity('events')
@Unique(['sessionId', 'seq'])
@Index(['sessionId', 'seq'])
@Index(['sessionId', 'idempotencyKey'])
@Index(['projectId', 'type', 'createdAt'])
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ type: 'integer' })
  seq!: number;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId?: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId?: string;

  @Column({ name: 'actor_type', type: 'varchar', length: 32, nullable: true })
  actorType?: string;

  @Column({ type: 'varchar', length: 64 })
  type!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 160, nullable: true })
  idempotencyKey?: string;

  @Column({ name: 'aggregate_type', type: 'varchar', length: 64, nullable: true })
  aggregateType?: string;

  @Column({ name: 'aggregate_id', type: 'varchar', length: 128, nullable: true })
  aggregateId?: string;

  @Column({ name: 'payload_json', type: 'simple-json', default: '{}' })
  payloadJson!: Record<string, unknown>;

  @Column({ name: 'metadata_json', type: 'simple-json', nullable: true })
  metadataJson?: Record<string, unknown>;

  @Column({ name: 'schema_version', type: 'integer', default: 1 })
  schemaVersion!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'trace_id', type: 'varchar', length: 64, nullable: true })
  traceId?: string;

  @Column({ name: 'correlation_id', type: 'varchar', length: 128, nullable: true })
  correlationId?: string;

  // Relations
  @ManyToOne(() => Session, (session) => session.events)
  @JoinColumn({ name: 'session_id' })
  session!: Session;
}
