import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  VersionColumn,
} from 'typeorm';
import { Project } from './project.entity';
import { SessionParticipant } from './session-participant.entity';
import { Message } from './message.entity';
import { Event } from './event.entity';

export enum SessionStatus {
  ACTIVE = 'active',
  CLOSED = 'closed',
  ARCHIVED = 'archived',
}

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title?: string;

  @Column({
    type: 'simple-enum',
    enum: SessionStatus,
    default: SessionStatus.ACTIVE,
  })
  status!: SessionStatus;

  @Column({ name: 'last_seq', type: 'integer', default: 0 })
  lastSeq!: number;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @VersionColumn()
  version!: number;

  // Relations
  @ManyToOne(() => Project, (project) => project.sessions)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @OneToMany(() => SessionParticipant, (participant) => participant.session)
  participants!: SessionParticipant[];

  @OneToMany(() => Message, (message) => message.session)
  messages!: Message[];

  @OneToMany(() => Event, (event) => event.session)
  events!: Event[];
}
