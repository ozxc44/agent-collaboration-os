import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Project } from './project.entity';
import { ProjectBranch } from './project-branch.entity';
import { ProjectOrchestration } from './project-orchestration.entity';
import { ProjectOrchestrationTask } from './project-orchestration-task.entity';
import { ProjectChangeset } from './project-changeset.entity';

export type ProjectCommitSnapshot = Record<string, {
  file_id: string;
  revision_id: string | null;
  content_hash: string;
}>;

export enum ProjectCommitVerificationStatus {
  VERIFIED = 'verified',
  UNVERIFIED = 'unverified',
  UNAVAILABLE = 'unavailable',
}

@Entity('project_commits')
@Index(['projectId', 'createdAt'])
@Index(['projectId', 'branchId'])
export class ProjectCommit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'branch_id', type: 'uuid' })
  branchId!: string;

  @Column({ name: 'parent_commit_id', type: 'uuid', nullable: true })
  parentCommitId?: string | null;

  @Column({ type: 'varchar', length: 512 })
  message!: string;

  @Column({ type: 'simple-json' })
  snapshot!: ProjectCommitSnapshot;

  @Column({ name: 'changed_files', type: 'simple-json' })
  changedFiles!: Array<Record<string, unknown>>;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @Column({ name: 'created_by_agent_id', type: 'uuid', nullable: true })
  createdByAgentId?: string | null;

  @Column({ name: 'orchestration_id', type: 'uuid', nullable: true })
  orchestrationId?: string | null;

  @Column({ name: 'task_id', type: 'uuid', nullable: true })
  taskId?: string | null;

  @Column({ name: 'changeset_id', type: 'uuid', nullable: true })
  changesetId?: string | null;

  /**
   * Real git commit SHA (40-hex) from the isomorphic-git backend. Populated on
   * merge when the git backend writes the same content as a real git commit.
   * Null for commits created before the git backend existed, or on rollback.
   * Distinct from `verificationStatus` (which is about review provenance, not
   * git signing) and from the DB `id` (uuid primary key, not a git oid).
   */
  @Column({ name: 'git_sha', type: 'varchar', length: 40, nullable: true })
  gitSha?: string | null;

  @Column({
    name: 'verification_status',
    type: 'simple-enum',
    enum: ProjectCommitVerificationStatus,
    default: ProjectCommitVerificationStatus.UNAVAILABLE,
  })
  verificationStatus!: ProjectCommitVerificationStatus;

  @Column({ name: 'verification_source', type: 'varchar', length: 64, default: 'local_unavailable' })
  verificationSource!: string;

  @Column({ name: 'verification_reason', type: 'varchar', length: 255, nullable: true })
  verificationReason?: string | null;

  @Column({ name: 'verification_actor_type', type: 'varchar', length: 16, nullable: true })
  verificationActorType?: 'user' | 'agent' | null;

  @Column({ name: 'verification_actor_id', type: 'uuid', nullable: true })
  verificationActorId?: string | null;

  @Column({ name: 'verified_at', nullable: true })
  verifiedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectBranch)
  @JoinColumn({ name: 'branch_id' })
  branch!: ProjectBranch;

  @ManyToOne(() => ProjectCommit, { nullable: true })
  @JoinColumn({ name: 'parent_commit_id' })
  parentCommit?: ProjectCommit | null;

  @ManyToOne(() => ProjectOrchestration, { nullable: true })
  @JoinColumn({ name: 'orchestration_id' })
  orchestration?: ProjectOrchestration | null;

  @ManyToOne(() => ProjectOrchestrationTask, { nullable: true })
  @JoinColumn({ name: 'task_id' })
  task?: ProjectOrchestrationTask | null;

  @ManyToOne(() => ProjectChangeset, { nullable: true })
  @JoinColumn({ name: 'changeset_id' })
  changeset?: ProjectChangeset | null;
}
