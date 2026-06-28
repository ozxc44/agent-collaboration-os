import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaskClaimedAt1780605000000 implements MigrationInterface {
  name = 'AddTaskClaimedAt1780605000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driver = queryRunner.connection.driver.options.type;
    if (driver === 'postgres') {
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD "claimed_at" TIMESTAMP`);
    } else {
      // SQLite
      await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" ADD "claimed_at" datetime`);
    }

    // Backfill claimed_at for tasks that were already claimed/running/completed/reviewed.
    // A worker engaging a task past 'pending' has implicitly claimed it; prefer dispatched_at
    // (claim normally follows dispatch) and fall back to created_at.
    if (driver === 'postgres') {
      await queryRunner.query(
        `UPDATE "project_orchestration_tasks" SET "claimed_at" = COALESCE("dispatched_at", "created_at") WHERE "status" != 'pending' AND "claimed_at" IS NULL`,
      );
    } else {
      await queryRunner.query(
        `UPDATE "project_orchestration_tasks" SET "claimed_at" = COALESCE("dispatched_at", "created_at") WHERE "status" != 'pending' AND "claimed_at" IS NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_orchestration_tasks" DROP COLUMN "claimed_at"`);
  }
}
