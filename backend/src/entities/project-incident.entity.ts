import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ProjectIncidentSeverity {
  CRITICAL = 'critical',
  WARNING = 'warning',
  INFO = 'info',
}

export enum ProjectIncidentStatus {
  ACTIVE = 'active',
  RESOLVED = 'resolved',
  ACKNOWLEDGED = 'acknowledged',
}

/**
 * ProjectIncident — project-level incident entity.
 * Tracks health incidents scoped to a project (e.g., agent failures, integration issues).
 * Table: project_incidents
 */
@Entity('project_incidents')
@Index(['projectId', 'status', 'createdAt'])
export class ProjectIncident {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({
    type: 'simple-enum',
    enum: ProjectIncidentSeverity,
  })
  severity!: ProjectIncidentSeverity;

  @Column({
    type: 'simple-enum',
    enum: ProjectIncidentStatus,
    default: ProjectIncidentStatus.ACTIVE,
  })
  status!: ProjectIncidentStatus;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  @Column({ name: 'description_json', type: 'simple-json', nullable: true })
  descriptionJson?: Record<string, unknown>;

  @Column({ name: 'resolved_at', nullable: true })
  resolvedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
