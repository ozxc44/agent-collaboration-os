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

export enum ProjectWorkSavedQueryScope {
  WORK = 'work',
}

export type WorkSavedQueryInput = {
  status?: string[];
  saved_view?: string;
  search?: string;
  agent?: string;
  has_artifacts?: boolean;
  has_links?: boolean;
  has_blockers?: boolean;
};

@Entity('project_work_saved_queries')
@Index(['projectId', 'updatedAt'])
@Index(['projectId', 'name'], { unique: true })
export class ProjectWorkSavedQuery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'varchar', length: 64 })
  scope!: ProjectWorkSavedQueryScope;

  @Column({ type: 'simple-json' })
  query!: WorkSavedQueryInput;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
