import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNotificationMetricsIndexes1780426800000 implements MigrationInterface {
  name = 'AddNotificationMetricsIndexes1780426800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_agent_inbox_items_project_status_created" ON "agent_inbox_items" ("project_id", "status", "created_at")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_agent_inbox_items_project_status_acked" ON "agent_inbox_items" ("project_id", "status", "acked_at")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_tasks_project_completed_reviewed_status" ON "project_orchestration_tasks" ("project_id", "completed_at", "reviewed_at", "status")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_agent_inbox_items_project_status_created"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_agent_inbox_items_project_status_acked"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_tasks_project_completed_reviewed_status"');
  }
}
