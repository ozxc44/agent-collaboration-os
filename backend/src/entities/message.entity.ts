import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Session } from './session.entity';

export enum MessageRole {
  USER = 'user',
  AGENT = 'agent',
  SYSTEM = 'system',
}

export enum MessageVisibility {
  SESSION = 'session',
  DIRECT = 'direct',
}

@Entity('messages')
@Index(['sessionId', 'createdAt'])
@Index(['eventId'], { unique: true })
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId?: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ name: 'event_id', type: 'uuid', nullable: true })
  eventId?: string;

  @Column({ type: 'integer', nullable: true })
  seq?: number;

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId?: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId?: string;

  @Column({ name: 'sender_type', type: 'varchar', length: 32, nullable: true })
  senderType?: string;

  @Column({ name: 'source_message_id', type: 'varchar', length: 128, nullable: true })
  sourceMessageId?: string;

  @Column({
    type: 'simple-enum',
    enum: MessageRole,
  })
  role!: MessageRole;

  @Column({ type: 'text' })
  content!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 64, default: 'text' })
  contentType!: string;

  @Column({ name: 'parent_message_id', type: 'varchar', length: 128, nullable: true })
  parentMessageId?: string;

  @Column({
    type: 'simple-enum',
    enum: MessageVisibility,
    default: MessageVisibility.SESSION,
  })
  visibility!: MessageVisibility;

  @Column({ name: 'recipient_participant_ids', type: 'simple-json', nullable: true })
  recipientParticipantIds?: string[];

  @Column({ type: 'simple-json', nullable: true })
  details?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  // Relations
  @ManyToOne(() => Session, (session) => session.messages)
  @JoinColumn({ name: 'session_id' })
  session!: Session;
}
