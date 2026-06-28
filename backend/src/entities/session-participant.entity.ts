import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Session } from './session.entity';
import { Agent } from './agent.entity';

@Entity('session_participants')
@Unique(['sessionId', 'agentId'])
export class SessionParticipant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId!: string;

  @CreateDateColumn({ name: 'joined_at' })
  joinedAt!: Date;

  // Relations
  @ManyToOne(() => Session, (session) => session.participants)
  @JoinColumn({ name: 'session_id' })
  session!: Session;

  @ManyToOne(() => Agent)
  @JoinColumn({ name: 'agent_id' })
  agent!: Agent;
}
