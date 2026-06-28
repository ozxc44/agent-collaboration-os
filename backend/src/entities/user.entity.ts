import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Project } from './project.entity';
import { ProjectMember } from './project-member.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true, length: 255 })
  email!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 128 })
  displayName!: string;

  @Column({ name: 'username', type: 'varchar', length: 64, unique: true, nullable: true })
  username?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @Column({ name: 'owner_agent_id', type: 'uuid', nullable: true })
  ownerAgentId?: string | null;

  // Relations
  @OneToMany(() => Project, (project) => project.owner)
  projects!: Project[];

  @OneToMany(() => ProjectMember, (member) => member.user)
  memberships!: ProjectMember[];
}
