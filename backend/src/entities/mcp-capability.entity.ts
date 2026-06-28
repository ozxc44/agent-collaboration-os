import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('mcp_capabilities')
export class McpCapability {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'varchar' })
  projectId!: string;

  @Column({ name: 'agent_id', type: 'varchar' })
  agentId!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ name: 'schema_json', type: 'text', nullable: true })
  schemaJson?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
