import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

@Entity('project_security_advisories')
@Unique(['projectId', 'slug'])
export class ProjectSecurityAdvisory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ type: 'varchar', length: 255 })
  slug!: string;

  @Column({ type: 'varchar', length: 32, default: 'medium' })
  severity!: string;

  @Column({ type: 'varchar', length: 32, default: 'draft' })
  status!: string;

  @Column({ name: 'affected_package', type: 'varchar', length: 255, nullable: true })
  affectedPackage!: string | null;

  @Column({ name: 'affected_version', type: 'varchar', length: 255, nullable: true })
  affectedVersion!: string | null;

  @Column({ name: 'fixed_version', type: 'varchar', length: 255, nullable: true })
  fixedVersion!: string | null;

  @Column({ name: 'cve_id', type: 'varchar', length: 64, nullable: true })
  cveId!: string | null;

  @Column({ type: 'text', default: '' })
  body!: string;

  @Column({ type: 'text', nullable: true })
  references!: string | null;

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
