import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Project } from './project.entity';
import { ProjectGate } from './project-gate.entity';
import { ProjectJoinRequest } from './project-join-request.entity';
import { User } from './user.entity';
import { Agent } from './agent.entity';

export enum ProjectGateAttemptStatus {
  STARTED = 'started',
  SUBMITTED = 'submitted',
  PREFILTER_RUNNING = 'prefilter_running',
  PREFILTER_FAILED = 'prefilter_failed',
  PREFILTER_PASSED = 'prefilter_passed',
  UNDER_OWNER_REVIEW = 'under_owner_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

@Entity('project_gate_attempts')
@Index(['projectId', 'status'])
@Index(['projectId', 'joinRequestId'])
@Index(['projectId', 'applicantAgentId'])
export class ProjectGateAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'gate_id', type: 'uuid' })
  gateId!: string;

  @Column({ name: 'join_request_id', type: 'uuid', nullable: true })
  joinRequestId?: string | null;

  @Column({ name: 'applicant_user_id', type: 'uuid', nullable: true })
  applicantUserId?: string | null;

  @Column({ name: 'applicant_agent_id', type: 'uuid', nullable: true })
  applicantAgentId?: string | null;

  @Column({
    type: 'simple-enum',
    enum: ProjectGateAttemptStatus,
    default: ProjectGateAttemptStatus.STARTED,
  })
  status!: ProjectGateAttemptStatus;

  @Column({ name: 'started_at' })
  startedAt!: Date;

  @Column({ name: 'deadline_at' })
  deadlineAt!: Date;

  @Column({ name: 'submitted_at', nullable: true })
  submittedAt?: Date;

  @Column({ name: 'reviewed_at', nullable: true })
  reviewedAt?: Date;

  @Column({ type: 'simple-json', nullable: true })
  submission?: Record<string, unknown> | null;

  @Column({ name: 'prefilter_result', type: 'simple-json', nullable: true })
  prefilterResult?: Record<string, unknown> | null;

  @Column({ name: 'review_notes', type: 'text', nullable: true })
  reviewNotes?: string | null;

  @Column({ name: 'reviewed_by_user_id', type: 'uuid', nullable: true })
  reviewedByUserId?: string | null;

  @Column({ name: 'reviewed_by_agent_id', type: 'uuid', nullable: true })
  reviewedByAgentId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectGate)
  @JoinColumn({ name: 'gate_id' })
  gate!: ProjectGate;

  @ManyToOne(() => ProjectJoinRequest, { nullable: true })
  @JoinColumn({ name: 'join_request_id' })
  joinRequest?: ProjectJoinRequest | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'applicant_user_id' })
  applicantUser?: User | null;

  @ManyToOne(() => Agent, { nullable: true })
  @JoinColumn({ name: 'applicant_agent_id' })
  applicantAgent?: Agent | null;
}
