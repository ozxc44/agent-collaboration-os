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
import { ProjectFile } from './project-file.entity';
import { ProjectFileRevision } from './project-file-revision.entity';
import { User } from './user.entity';
import { Agent } from './agent.entity';

export enum ProjectFileProposalStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Entity('project_file_proposals')
@Index(['projectId', 'status'])
@Index(['projectId', 'path'])
export class ProjectFileProposal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'file_id', type: 'uuid', nullable: true })
  fileId?: string | null;

  @Column({ type: 'varchar', length: 1024 })
  path!: string;

  @Column({ name: 'proposed_content', type: 'text' })
  proposedContent!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 64, default: 'text/markdown' })
  contentType!: string;

  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash!: string;

  @Column({ name: 'base_revision_id', type: 'uuid', nullable: true })
  baseRevisionId?: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  title?: string | null;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({
    type: 'simple-enum',
    enum: ProjectFileProposalStatus,
    default: ProjectFileProposalStatus.PENDING,
  })
  status!: ProjectFileProposalStatus;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @Column({ name: 'created_by_agent_id', type: 'uuid', nullable: true })
  createdByAgentId?: string | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy?: string | null;

  @Column({ name: 'reviewed_at', nullable: true })
  reviewedAt?: Date;

  @Column({ name: 'review_message', type: 'varchar', length: 1024, nullable: true })
  reviewMessage?: string | null;

  @Column({ name: 'merged_revision_id', type: 'uuid', nullable: true })
  mergedRevisionId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectFile, { nullable: true })
  @JoinColumn({ name: 'file_id' })
  file?: ProjectFile | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser?: User | null;

  @ManyToOne(() => Agent, { nullable: true })
  @JoinColumn({ name: 'created_by_agent_id' })
  createdByAgent?: Agent | null;
}
