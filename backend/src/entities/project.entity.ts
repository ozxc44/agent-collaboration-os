import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';
import { ProjectMember } from './project-member.entity';
import { Agent } from './agent.entity';
import { Session } from './session.entity';
import { ProjectFile } from './project-file.entity';
import { ProjectMemory } from './project-memory.entity';

export enum ProjectVisibility {
  PRIVATE = 'private',
  PUBLIC = 'public',
}

export enum ProjectStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'simple-enum',
    enum: ProjectVisibility,
    default: ProjectVisibility.PRIVATE,
  })
  visibility!: ProjectVisibility;

  @Column({
    type: 'simple-enum',
    enum: ProjectStatus,
    default: ProjectStatus.ACTIVE,
  })
  status!: ProjectStatus;

  @Column({ name: 'clone_source_project_id', type: 'uuid', nullable: true })
  cloneSourceProjectId?: string | null;

  @Column({ type: 'varchar', nullable: true })
  webhookUrl?: string;

  @Column({ type: 'varchar', nullable: true })
  webhookSecret?: string;

  @Column({ type: 'simple-json', nullable: true, default: '[]' })
  webhookEnabledEvents?: string[];

  @Column({ type: 'simple-json', nullable: true, default: '[]' })
  topics?: string[];

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @Column({ name: 'main_agent_id', type: 'uuid', nullable: true })
  mainAgentId?: string | null;

  @Column({ name: 'audit_retention_days', type: 'integer', nullable: true })
  auditRetentionDays?: number | null;

  @Column({ name: 'audit_legal_hold_enabled', type: 'boolean', default: false })
  auditLegalHoldEnabled!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  // Relations
  @ManyToOne(() => User, (user) => user.projects)
  @JoinColumn({ name: 'owner_id' })
  owner!: User;

  @OneToMany(() => ProjectMember, (member) => member.project)
  members!: ProjectMember[];

  @OneToMany(() => Agent, (agent) => agent.project)
  agents!: Agent[];

  @OneToMany(() => Session, (session) => session.project)
  sessions!: Session[];

  @OneToMany(() => ProjectFile, (file) => file.project)
  files!: ProjectFile[];

  @OneToMany(() => ProjectMemory, (memory) => memory.project)
  memories!: ProjectMemory[];
}
