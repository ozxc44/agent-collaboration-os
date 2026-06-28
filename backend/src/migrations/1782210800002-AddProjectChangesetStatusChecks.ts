import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectChangesetStatusChecks1782210800002 implements MigrationInterface {
  name = 'AddProjectChangesetStatusChecks1782210800002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "project_changesets"
      ADD COLUMN IF NOT EXISTS "status_checks" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "project_changesets"
      DROP COLUMN IF EXISTS "status_checks"
    `);
  }
}
