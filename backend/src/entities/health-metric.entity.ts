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
import { Project } from './project.entity';
import { Session } from './session.entity';
import { Agent } from './agent.entity';
import { Event } from './event.entity';

@Entity('health_metrics')
@Unique(['eventId'])
@Index(['projectId', 'agentId', 'recordedAt'])
@Index(['sessionId', 'recordedAt'])
export class HealthMetric {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId?: string;

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId?: string;

  @Column({ name: 'run_id', type: 'varchar', length: 128, nullable: true })
  runId?: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'real' })
  value!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  unit?: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  status?: string;

  @Column({ name: 'tags_json', type: 'simple-json', nullable: true })
  tagsJson?: Record<string, unknown>;

  @Column({ name: 'details_json', type: 'simple-json', nullable: true })
  detailsJson?: Record<string, unknown>;

  @Column({ name: 'recorded_at' })
  recordedAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => Session, { nullable: true })
  @JoinColumn({ name: 'session_id' })
  session?: Session;

  @ManyToOne(() => Agent, { nullable: true })
  @JoinColumn({ name: 'agent_id' })
  agent?: Agent;

  @ManyToOne(() => Event)
  @JoinColumn({ name: 'event_id' })
  event!: Event;
}
