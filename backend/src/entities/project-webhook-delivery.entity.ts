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

export enum WebhookDeliveryStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
  RETRYING = 'retrying',
  DEAD_LETTER = 'dead_letter',
}

/**
 * Bounded delivery record for every project webhook delivery attempt.
 *
 * Security notes:
 * - The raw webhook URL is never stored; only a masked form is persisted.
 * - Webhook secret, raw request body, and raw response body are not stored.
 * - The message field is sanitized before persistence to avoid leaking secrets
 *   that may be echoed by fetch errors.
 */
@Entity('project_webhook_deliveries')
@Index(['projectId', 'createdAt'])
@Index(['projectId', 'eventId', 'createdAt'])
export class ProjectWebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'event_id', type: 'varchar', length: 255 })
  eventId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 255 })
  eventType!: string;

  @Column({ type: 'integer' })
  attempt!: number;

  @Column({
    type: 'simple-enum',
    enum: WebhookDeliveryStatus,
  })
  status!: WebhookDeliveryStatus;

  @Column({ name: 'http_status_code', type: 'integer', nullable: true })
  httpStatusCode?: number | null;

  @Column({ type: 'text', nullable: true })
  message?: string | null;

  @Column({ name: 'masked_url', type: 'varchar', nullable: true })
  maskedUrl?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
