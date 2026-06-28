import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

/**
 * ProjectRelease — project release entity.
 * Stores releases scoped to a project with normalized tag names.
 * Table: project_releases
 */
@Entity('project_releases')
@Unique(['projectId', 'tagName'])
export class ProjectRelease {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ name: 'tag_name', type: 'varchar', length: 255 })
  tagName!: string;

  @Column({ name: 'target_commit_id', type: 'varchar', length: 255, nullable: true })
  targetCommitId!: string | null;

  @Column({ type: 'text', default: '' })
  body!: string;

  @Column({ type: 'boolean', default: true })
  draft!: boolean;

  @Column({ type: 'boolean', default: false })
  prerelease!: boolean;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'published_at', type: 'datetime', nullable: true })
  publishedAt!: Date | null;
}
