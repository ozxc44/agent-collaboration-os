import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Health alert types detected by the HealthMonitorService.
 */
export type AlertType = 'loop' | 'retry_storm' | 'token_spike' | 'latency_drift';

/**
 * Severity levels for health-monitor incidents.
 */
export type AlertSeverity = 'warning' | 'critical';

/**
 * Lifecycle status of a health-monitor incident.
 */
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

/**
 * Incident — agent health-monitoring incident entity.
 *
 * Created automatically by HealthMonitorService when anomalous agent behavior is
 * detected (loop, retry storm, token spike, or latency drift).
 * Table: incidents
 */
@Entity('incidents')
@Index(['agentId', 'status', 'createdAt'])
@Index(['type', 'status'])
export class Incident {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'agent_id', type: 'varchar', length: 64 })
  agentId!: string;

  @Column({ type: 'varchar', length: 32 })
  type!: AlertType;

  @Column({ type: 'varchar', length: 16 })
  severity!: AlertSeverity;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status!: IncidentStatus;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'simple-json', default: '{}' })
  details!: Record<string, unknown>;

  @Column({ name: 'resolved_at', nullable: true })
  resolvedAt?: Date;

  @Column({ name: 'resolved_by', type: 'varchar', length: 64, nullable: true })
  resolvedBy?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
