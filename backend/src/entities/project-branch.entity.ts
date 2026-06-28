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
import { ProjectCommit } from './project-commit.entity';
import { ProjectRole } from './project-member.entity';

export type ProtectionRules = {
  block_direct_writes?: boolean;
  direct_write_bypass_roles?: ProjectRole[];
  direct_write_bypass_user_ids?: string[];
  required_approvals?: number;
  required_status_checks?: string[];
  protected_branch_patterns?: string[];
  merge_queue_enabled?: boolean;
};

@Entity('project_branches')
@Unique(['projectId', 'name'])
@Index(['projectId', 'updatedAt'])
export class ProjectBranch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ type: 'varchar', length: 128, default: 'main' })
  name!: string;

  @Column({ name: 'head_commit_id', type: 'uuid', nullable: true })
  headCommitId?: string | null;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ name: 'is_protected', type: 'boolean', default: false })
  isProtected!: boolean;

  @Column({ name: 'protection_rules', type: 'simple-json', nullable: true })
  protectionRules?: ProtectionRules | null;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @Column({ name: 'created_by_agent_id', type: 'uuid', nullable: true })
  createdByAgentId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => ProjectCommit, { nullable: true })
  @JoinColumn({ name: 'head_commit_id' })
  headCommit?: ProjectCommit | null;
}
