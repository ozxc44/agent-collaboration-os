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
import { User } from './user.entity';
import { ProjectRole } from './project-member.entity';

export enum ProjectAuditAction {
  MEMBER_ADDED = 'member_added',
  MEMBER_ROLE_CHANGED = 'member_role_changed',
  MEMBER_REMOVED = 'member_removed',
  OWNER_TRANSFERRED = 'owner_transferred',
  PROJECT_SETTINGS_UPDATED = 'project_settings_updated',
  PROJECT_ARCHIVED = 'project_archived',
  PROJECT_UNARCHIVED = 'project_unarchived',
  WIKI_PAGE_CREATED = 'wiki_page_created',
  WIKI_PAGE_UPDATED = 'wiki_page_updated',
  RELEASE_CREATED = 'release_created',
  RELEASE_UPDATED = 'release_updated',
  PACKAGE_CREATED = 'package_created',
  PACKAGE_UPDATED = 'package_updated',
  SECURITY_ADVISORY_CREATED = 'security_advisory_created',
  SECURITY_ADVISORY_UPDATED = 'security_advisory_updated',
  SECURITY_MANIFEST_HYGIENE_SCAN_RUN = 'security_manifest_hygiene_scan_run',
  BRANCH_CREATED = 'branch_created',
  BRANCH_RENAMED = 'branch_renamed',
  BRANCH_DELETED = 'branch_deleted',
  BRANCH_DEFAULT_SET = 'branch_default_set',
  BRANCH_PROTECTION_CHANGED = 'branch_protection_changed',
  CHANGESET_REVIEWERS_REQUESTED = 'changeset_reviewers_requested',
  AUDIT_RETENTION_POLICY_UPDATED = 'audit_retention_policy_updated',
  AUDIT_RETENTION_PRUNED = 'audit_retention_pruned',
}

@Entity('project_audit_events')
@Index(['projectId', 'createdAt'])
@Index(['projectId', 'action', 'createdAt'])
export class ProjectAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'actor_user_id', type: 'uuid' })
  actorUserId!: string;

  @Column({ name: 'target_user_id', type: 'uuid', nullable: true })
  targetUserId?: string | null;

  @Column({
    type: 'simple-enum',
    enum: ProjectAuditAction,
  })
  action!: ProjectAuditAction;

  @Column({
    name: 'previous_role',
    type: 'simple-enum',
    enum: ProjectRole,
    nullable: true,
  })
  previousRole?: ProjectRole | null;

  @Column({
    name: 'new_role',
    type: 'simple-enum',
    enum: ProjectRole,
    nullable: true,
  })
  newRole?: ProjectRole | null;

  @Column({ name: 'metadata_json', type: 'simple-json', nullable: true })
  metadataJson?: Record<string, unknown> | null;

  @Column({ name: 'chain_prev_hash', type: 'varchar', length: 64, nullable: true })
  chainPrevHash?: string | null;

  @Column({ name: 'chain_hash', type: 'varchar', length: 64, nullable: true })
  chainHash?: string | null;

  @Column({ name: 'chain_hash_version', type: 'varchar', length: 16, nullable: true })
  chainHashVersion?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'actor_user_id' })
  actor!: User;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'target_user_id' })
  target?: User | null;
}
