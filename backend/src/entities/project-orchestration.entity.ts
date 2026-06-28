import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { Project } from './project.entity';
import { Agent } from './agent.entity';
import { Session } from './session.entity';
import { ProjectOrchestrationTask } from './project-orchestration-task.entity';

export enum ProjectOrchestrationStatus {
  PLANNING = 'planning',
  RUNNING = 'running',
  READY_FOR_ACCEPTANCE = 'ready_for_acceptance',
  COMPLETED = 'completed',
  BLOCKED = 'blocked',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('project_orchestrations')
@Index(['projectId', 'status'])
@Index(['projectId', 'createdAt'])
export class ProjectOrchestration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'text' })
  objective!: string;

  @Column({
    type: 'simple-enum',
    enum: ProjectOrchestrationStatus,
    default: ProjectOrchestrationStatus.PLANNING,
  })
  status!: ProjectOrchestrationStatus;

  @Column({ name: 'base_path', type: 'varchar', length: 1024 })
  basePath!: string;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId?: string | null;

  @Column({ name: 'main_agent_id', type: 'uuid', nullable: true })
  mainAgentId?: string | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @Column({ name: 'created_by_agent_id', type: 'uuid', nullable: true })
  createdByAgentId?: string | null;

  @Column({ name: 'acceptance_criteria', type: 'simple-json', nullable: true })
  acceptanceCriteria?: string[] | null;

  @Column({ type: 'simple-json', nullable: true })
  metadata?: Record<string, unknown> | null;

  @Column({ name: 'completed_at', nullable: true })
  completedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => Session, { nullable: true })
  @JoinColumn({ name: 'session_id' })
  session?: Session | null;

  @ManyToOne(() => Agent, { nullable: true })
  @JoinColumn({ name: 'main_agent_id' })
  mainAgent?: Agent | null;

  @OneToMany(() => ProjectOrchestrationTask, (task) => task.orchestration)
  tasks!: ProjectOrchestrationTask[];
}
