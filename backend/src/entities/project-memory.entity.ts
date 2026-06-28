import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Project } from './project.entity';
import { Agent } from './agent.entity';
import { User } from './user.entity';

export enum ProjectMemoryVisibility {
  PROJECT = 'project',
  AGENT = 'agent',
}

@Entity('project_memories')
@Index(['projectId', 'agentId'])
@Index(['projectId', 'updatedAt'])
export class ProjectMemory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId?: string | null;

  @Column({ name: 'author_user_id', type: 'uuid', nullable: true })
  authorUserId?: string | null;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'simple-json', nullable: true })
  tags?: string[];

  @Column({ type: 'simple-json', nullable: true })
  metadata?: Record<string, unknown>;

  @Column({
    type: 'simple-enum',
    enum: ProjectMemoryVisibility,
    default: ProjectMemoryVisibility.PROJECT,
  })
  visibility!: ProjectMemoryVisibility;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project, (project) => project.memories)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => Agent, (agent) => agent.id, { nullable: true })
  @JoinColumn({ name: 'agent_id' })
  agent?: Agent | null;

  @ManyToOne(() => User, (user) => user.id, { nullable: true })
  @JoinColumn({ name: 'author_user_id' })
  author?: User | null;
}
