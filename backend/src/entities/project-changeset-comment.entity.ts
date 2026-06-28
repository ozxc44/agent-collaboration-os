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
import { ProjectChangeset } from './project-changeset.entity';
import { User } from './user.entity';
import { Agent } from './agent.entity';

export enum ProjectChangesetCommentStatus {
  ACTIVE = 'active',
  RESOLVED = 'resolved',
}

export enum ProjectChangesetCommentAuthorType {
  USER = 'user',
  AGENT = 'agent',
}

export enum ProjectChangesetCommentSide {
  BASE = 'base',
  HEAD = 'head',
}

@Entity('project_changeset_comments')
@Index(['projectId', 'changesetId'])
@Index(['changesetId', 'status'])
@Index(['changesetId', 'filePath'])
export class ProjectChangesetComment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'changeset_id', type: 'uuid' })
  changesetId!: string;

  @Column({ name: 'parent_comment_id', type: 'uuid', nullable: true })
  parentCommentId?: string | null;

  @Column({ name: 'author_type', type: 'varchar', length: 16 })
  authorType!: ProjectChangesetCommentAuthorType;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ name: 'file_path', type: 'varchar', length: 1024, nullable: true })
  filePath?: string | null;

  @Column({ name: 'side', type: 'varchar', length: 16, nullable: true })
  side?: ProjectChangesetCommentSide | null;

  @Column({ name: 'line', type: 'integer', nullable: true })
  line?: number | null;

  @Column({ name: 'base_revision_id', type: 'uuid', nullable: true })
  baseRevisionId?: string | null;

  @Column({ name: 'head_revision_id', type: 'uuid', nullable: true })
  headRevisionId?: string | null;

  @Column({
    type: 'simple-enum',
    enum: ProjectChangesetCommentStatus,
    default: ProjectChangesetCommentStatus.ACTIVE,
  })
  status!: ProjectChangesetCommentStatus;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy?: string | null;

  @Column({ name: 'resolved_at', nullable: true })
  resolvedAt?: Date | null;

  @Column({ name: 'deleted_at', nullable: true })
  deletedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectChangeset)
  @JoinColumn({ name: 'changeset_id' })
  changeset!: ProjectChangeset;

  @ManyToOne(() => ProjectChangesetComment, { nullable: true })
  @JoinColumn({ name: 'parent_comment_id' })
  parentComment?: ProjectChangesetComment | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'author_id' })
  authorUser?: User | null;
}
