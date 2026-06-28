import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

/**
 * ProjectPackage — project package metadata entity.
 * Stores package metadata scoped to a project with normalized name/version.
 * Table: project_packages
 */
@Entity('project_packages')
@Unique(['projectId', 'name', 'version'])
export class ProjectPackage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'package_type', type: 'simple-enum', enum: ['generic', 'container', 'npm', 'python'], default: 'generic' })
  packageType!: string;

  @Column({ type: 'varchar', length: 255 })
  version!: string;

  @Column({ type: 'text', default: '' })
  description!: string;

  @Column({ name: 'repository_url', type: 'varchar', length: 2048, nullable: true })
  repositoryUrl!: string | null;

  @Column({ type: 'text', nullable: true })
  metadata!: string | null;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
