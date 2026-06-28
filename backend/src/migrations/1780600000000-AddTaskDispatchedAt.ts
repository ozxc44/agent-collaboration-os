import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskDispatchedAt1780600000000 implements MigrationInterface {
  name = 'AddTaskDispatchedAt1780600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driver = queryRunner.connection.driver.options.type;
    if (driver === 'postgres') {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD "dispatched_at" TIMESTAMP`);
    } else {
      // SQLite
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD "dispatched_at" datetime`);
    }

    // Backfill dispatched_at from created_at for existing tasks that were dispatched
    if (driver === 'postgres') {
      await queryRunner.query(
        `UPDATE "project_orchestration_tasks" SET "dispatched_at" = "created_at" WHERE "status" != 'pending' AND "dispatched_at" IS NULL`,
      );
    } else {
      await queryRunner.query(
        `UPDATE "project_orchestration_tasks" SET "dispatched_at" = "created_at" WHERE "status" != 'pending' AND "dispatched_at" IS NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN "dispatched_at"`);
  }
}
