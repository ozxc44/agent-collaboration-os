import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum WorkUnitStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  BLOCKED = 'blocked',
  FAILED = 'failed',
  REVIEWED_APPROVED = 'reviewed_approved',
  REVIEWED_CHANGES_REQUESTED = 'reviewed_changes_requested',
}

@Entity('agent_work_units')
@Index(['projectId', 'agentId'])
@Index(['orchestrationId', 'taskId'])
export class AgentWorkUnit {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId!: string;

  @Column({ name: 'orchestration_id', type: 'uuid', nullable: true })
  orchestrationId?: string | null;

  @Column({ name: 'task_id', type: 'uuid', nullable: true })
  taskId?: string | null;

  @Column({ name: 'source_event', type: 'varchar', length: 100 })
  sourceEvent!: string;

  @Column({
    type: 'simple-enum',
    enum: WorkUnitStatus,
    default: WorkUnitStatus.IN_PROGRESS,
  })
  status!: WorkUnitStatus;

  @Column({ name: 'review_decision', type: 'varchar', length: 50, nullable: true })
  reviewDecision?: string | null;

  @Column('simple-json', { nullable: true })
  metrics?: Record<string, unknown> | null;

  @Column('float', { name: 'normalized_work_units', nullable: true })
  normalizedWorkUnits?: number | null;

  @Column({ name: 'source_type', type: 'varchar', length: 100, nullable: true })
  sourceType?: string | null;

  @Column('float', { name: 'provisional_work_units', nullable: true })
  provisionalWorkUnits?: number | null;

  @Column('float', { name: 'final_work_units', nullable: true })
  finalWorkUnits?: number | null;

  @Column('float', { name: 'review_score', nullable: true })
  reviewScore?: number | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, nullable: true, unique: true })
  idempotencyKey?: string | null;

  @Column({ name: 'reward_rule_version', type: 'varchar', length: 50, nullable: true })
  rewardRuleVersion?: string | null;

  @Column('simple-json', { name: 'calculation_snapshot_json', nullable: true })
  calculationSnapshotJson?: Record<string, unknown> | null;

  @Column({ name: 'adjusted_by_user_id', type: 'uuid', nullable: true })
  adjustedByUserId?: string | null;

  @Column({ name: 'adjustment_reason', type: 'varchar', length: 500, nullable: true })
  adjustmentReason?: string | null;

  @Column('float', { name: 'adjustment_value', nullable: true })
  adjustmentValue?: number | null;

  @Column({ name: 'locked_at', nullable: true })
  lockedAt?: Date;

  @Column({ name: 'started_at', nullable: true })
  startedAt?: Date;

  @Column({ name: 'completed_at', nullable: true })
  completedAt?: Date;

  @Column({ name: 'reviewed_at', nullable: true })
  reviewedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
