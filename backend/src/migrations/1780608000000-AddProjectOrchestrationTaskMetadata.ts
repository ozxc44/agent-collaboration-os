import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectOrchestrationTaskMetadata1780608000000 implements MigrationInterface {
  name = 'AddProjectOrchestrationTaskMetadata1780608000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_orchestration_tasks" ADD COLUMN IF NOT EXISTS "metadata" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_orchestration_tasks" DROP COLUMN IF EXISTS "metadata"`,
    );
  }
}
