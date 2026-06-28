import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Project } from './project.entity';
import { Session } from './session.entity';
import { Agent } from './agent.entity';
import { Event } from './event.entity';

export enum AgentRunStatus {
  QUEUED = 'queued',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('agent_runs')
@Unique(['sessionId', 'runId'])
@Index(['projectId', 'agentId', 'status'])
@Index(['sessionId', 'status'])
export class AgentRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId!: string;

  @Column({ name: 'run_id', type: 'varchar', length: 128 })
  runId!: string;

  @Column({
    type: 'simple-enum',
    enum: AgentRunStatus,
    default: AgentRunStatus.QUEUED,
  })
  status!: AgentRunStatus;

  @Column({ type: 'integer', default: 1 })
  attempt!: number;

  @Column({ name: 'delivery_id', type: 'varchar', length: 128, nullable: true })
  deliveryId?: string;

  @Column({ name: 'trigger_event_id', type: 'uuid', nullable: true })
  triggerEventId?: string;

  @Column({ name: 'queued_event_id', type: 'uuid', nullable: true })
  queuedEventId?: string;

  @Column({ name: 'started_event_id', type: 'uuid', nullable: true })
  startedEventId?: string;

  @Column({ name: 'terminal_event_id', type: 'uuid', nullable: true })
  terminalEventId?: string;

  @Column({ name: 'queued_at', nullable: true })
  queuedAt?: Date;

  @Column({ name: 'started_at', nullable: true })
  startedAt?: Date;

  @Column({ name: 'completed_at', nullable: true })
  completedAt?: Date;

  @Column({ name: 'failed_at', nullable: true })
  failedAt?: Date;

  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs?: number;

  @Column({ name: 'error_json', type: 'simple-json', nullable: true })
  errorJson?: Record<string, unknown>;

  @Column({ name: 'metrics_json', type: 'simple-json', nullable: true })
  metricsJson?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => Session)
  @JoinColumn({ name: 'session_id' })
  session!: Session;

  @ManyToOne(() => Agent)
  @JoinColumn({ name: 'agent_id' })
  agent!: Agent;

  @ManyToOne(() => Event, { nullable: true })
  @JoinColumn({ name: 'queued_event_id' })
  queuedEvent?: Event;
}
