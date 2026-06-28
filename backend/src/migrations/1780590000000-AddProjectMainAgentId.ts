import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectMainAgentId1780590000000 implements MigrationInterface {
  name = 'AddProjectMainAgentId1780590000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS main_agent_id UUID NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_projects_main_agent_id
        ON projects (main_agent_id)
        WHERE main_agent_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_projects_main_agent_id`);
    await queryRunner.query(`ALTER TABLE projects DROP COLUMN IF EXISTS main_agent_id`);
  }
}
