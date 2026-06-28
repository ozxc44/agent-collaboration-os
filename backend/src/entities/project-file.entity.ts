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
  Unique,
} from 'typeorm';
import { Project } from './project.entity';
import { ProjectFileRevision } from './project-file-revision.entity';

@Entity('project_files')
@Unique(['projectId', 'path'])
@Index(['projectId', 'updatedAt'])
export class ProjectFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 1024 })
  path!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 64, default: 'text/markdown' })
  contentType!: string;

  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash!: string;

  @Column({ name: 'size_bytes', type: 'integer', default: 0 })
  sizeBytes!: number;

  @Column({ name: 'current_revision_id', type: 'uuid', nullable: true })
  currentRevisionId?: string | null;

  @Column({ name: 'deleted_at', nullable: true })
  deletedAt?: Date | null;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project, (project) => project.files)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @OneToMany(() => ProjectFileRevision, (revision) => revision.file)
  revisions!: ProjectFileRevision[];
}
