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
import { Project } from './project.entity';
import { Agent } from './agent.entity';
import { ProjectGateTemplate } from './project-gate-template.entity';

@Entity('project_gates')
@Unique(['projectId', 'templateId'])
@Index(['projectId', 'enabled'])
export class ProjectGate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'boolean', default: true })
  required!: boolean;

  @Column({ name: 'owner_agent_id', type: 'uuid', nullable: true })
  ownerAgentId?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  config?: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectGateTemplate)
  @JoinColumn({ name: 'template_id' })
  template!: ProjectGateTemplate;

  @ManyToOne(() => Agent, { nullable: true })
  @JoinColumn({ name: 'owner_agent_id' })
  ownerAgent?: Agent | null;
}
