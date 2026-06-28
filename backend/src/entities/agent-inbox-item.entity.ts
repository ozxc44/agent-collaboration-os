import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum InboxItemStatus {
  UNREAD = 'unread',
  READ = 'read',
  ACKED = 'acked',
}

@Entity('agent_inbox_items')
@Index(['recipientAgentId', 'status', 'createdAt'])
@Index(['recipientAgentId', 'createdAt'])
export class AgentInboxItem {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'recipient_agent_id', type: 'uuid' })
  recipientAgentId!: string;

  @Column({ name: 'orchestration_id', type: 'uuid', nullable: true })
  orchestrationId?: string | null;

  @Column({ name: 'task_id', type: 'uuid', nullable: true })
  taskId?: string | null;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType!: string;

  @Column({ type: 'varchar', length: 500 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  body?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  payload?: Record<string, unknown> | null;

  @Column({
    type: 'simple-enum',
    enum: InboxItemStatus,
    default: InboxItemStatus.UNREAD,
  })
  status!: InboxItemStatus;

  @Column({ name: 'read_at', nullable: true })
  readAt?: Date;

  @Column({ name: 'acked_at', nullable: true })
  ackedAt?: Date;

  @Column({ name: 'lease_token', type: 'varchar', length: 64, nullable: true })
  leaseToken?: string | null;

  @Column({ name: 'leased_by', type: 'uuid', nullable: true })
  leasedBy?: string | null;

  @Column({ name: 'lease_expires_at', nullable: true })
  leaseExpiresAt?: Date | null;

  @Column({ name: 'delivery_attempts', type: 'integer', default: 0 })
  deliveryAttempts!: number;

  @Column({ name: 'last_delivered_at', nullable: true })
  lastDeliveredAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
