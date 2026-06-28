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
import { ProjectFile } from './project-file.entity';
import { Project } from './project.entity';

@Entity('project_file_revisions')
@Unique(['fileId', 'revisionNumber'])
@Index(['projectId', 'path'])
export class ProjectFileRevision {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'file_id', type: 'uuid' })
  fileId!: string;

  @Column({ type: 'varchar', length: 1024 })
  path!: string;

  @Column({ name: 'revision_number', type: 'integer' })
  revisionNumber!: number;

  @Column({ type: 'text' })
  content!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 64, default: 'text/markdown' })
  contentType!: string;

  @Column({ name: 'content_hash', type: 'varchar', length: 64 })
  contentHash!: string;

  @Column({ name: 'message', type: 'varchar', length: 512, nullable: true })
  message?: string | null;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Project, (project) => project.id)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectFile, (file) => file.revisions)
  @JoinColumn({ name: 'file_id' })
  file!: ProjectFile;
}
