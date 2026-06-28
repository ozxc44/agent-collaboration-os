import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum ProjectGateTemplateKind {
  PROGRAMMING = 'programming',
  RESEARCH = 'research',
  WRITING = 'writing',
  TOOL_USE = 'tool_use',
  CUSTOM = 'custom',
}

@Entity('project_gate_templates')
@Unique(['key'])
@Index(['kind', 'isPreset'])
export class ProjectGateTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  key!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({
    type: 'simple-enum',
    enum: ProjectGateTemplateKind,
    default: ProjectGateTemplateKind.CUSTOM,
  })
  kind!: ProjectGateTemplateKind;

  @Column({ type: 'simple-json' })
  definition!: Record<string, unknown>;

  @Column({ name: 'is_preset', type: 'boolean', default: false })
  isPreset!: boolean;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser?: User | null;
}
