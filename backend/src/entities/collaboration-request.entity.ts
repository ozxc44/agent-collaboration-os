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
import { User } from './user.entity';
import { ProjectRole } from './project-member.entity';

export enum CollaborationRequestType {
  PROJECT_JOIN = 'project_join',
  PROJECT_INVITE = 'project_invite',
  OWNER_AGENT_BIND = 'owner_agent_bind',
}

export enum CollaborationRequestStatus {
  PENDING_AGENT = 'pending_agent',
  PENDING_OWNER = 'pending_owner',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
}

@Entity('collaboration_requests')
@Index(['projectId', 'status'])
@Index(['targetUserId', 'status'])
@Index(['targetAgentId', 'status'])
@Index(['requestType', 'status'])
export class CollaborationRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'request_type', type: 'simple-enum', enum: CollaborationRequestType })
  requestType!: CollaborationRequestType;

  @Column({ name: 'status', type: 'simple-enum', enum: CollaborationRequestStatus, default: CollaborationRequestStatus.PENDING_OWNER })
  status!: CollaborationRequestStatus;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId?: string | null;

  @Column({ name: 'requested_by_user_id', type: 'uuid', nullable: true })
  requestedByUserId?: string | null;

  @Column({ name: 'target_user_id', type: 'uuid', nullable: true })
  targetUserId?: string | null;

  @Column({ name: 'target_agent_id', type: 'uuid', nullable: true })
  targetAgentId?: string | null;

  @Column({ name: 'requested_role', type: 'simple-enum', enum: ProjectRole, nullable: true })
  requestedRole?: ProjectRole | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note?: string | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy?: string | null;

  @Column({ name: 'reviewed_at', nullable: true })
  reviewedAt?: Date;

  @Column({ name: 'legacy_join_request_id', type: 'uuid', nullable: true })
  legacyJoinRequestId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project, { nullable: true })
  @JoinColumn({ name: 'project_id' })
  project?: Project;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'requested_by_user_id' })
  requestedByUser?: User;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'target_user_id' })
  targetUser?: User;
}
