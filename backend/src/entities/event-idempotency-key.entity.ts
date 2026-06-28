import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Session } from './session.entity';
import { Event } from './event.entity';

export enum EventIdempotencyStatus {
  RESERVED = 'reserved',
  COMMITTED = 'committed',
}

@Entity('event_idempotency_keys')
@Unique(['sessionId', 'key'])
@Index(['projectId', 'key'])
export class EventIdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 160 })
  key!: string;

  @Column({ name: 'request_hash', type: 'varchar', length: 64 })
  requestHash!: string;

  @Column({
    type: 'simple-enum',
    enum: EventIdempotencyStatus,
    default: EventIdempotencyStatus.RESERVED,
  })
  status!: EventIdempotencyStatus;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId?: string;

  @Column({ name: 'committed_at', nullable: true })
  committedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Session)
  @JoinColumn({ name: 'session_id' })
  session!: Session;

  @ManyToOne(() => Event, { nullable: true })
  @JoinColumn({ name: 'event_id' })
  event?: Event;
}
