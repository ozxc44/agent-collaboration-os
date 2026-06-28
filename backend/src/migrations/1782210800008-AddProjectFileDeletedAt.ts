import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectFileDeletedAt1782210800008 implements MigrationInterface {
  name = 'AddProjectFileDeletedAt1782210800008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "project_files" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "project_files" DROP COLUMN IF EXISTS "deleted_at"');
  }
}
