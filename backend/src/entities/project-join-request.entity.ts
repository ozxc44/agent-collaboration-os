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
import { User } from './user.entity';
import { ProjectRole } from './project-member.entity';

export enum ProjectJoinRequestStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
}

@Entity('project_join_requests')
@Index(['projectId', 'status'])
@Index(['projectId', 'userId'])
export class ProjectJoinRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({
    type: 'simple-enum',
    enum: ProjectJoinRequestStatus,
    default: ProjectJoinRequestStatus.PENDING,
  })
  status!: ProjectJoinRequestStatus;

  @Column({
    name: 'requested_role',
    type: 'simple-enum',
    enum: ProjectRole,
    default: ProjectRole.MEMBER,
  })
  requestedRole!: ProjectRole;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  note?: string | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy?: string | null;

  @Column({ name: 'reviewed_at', nullable: true })
  reviewedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project, (project) => project.id)
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @ManyToOne(() => User, (user) => user.id)
  @JoinColumn({ name: 'user_id' })
  user!: User;
}
