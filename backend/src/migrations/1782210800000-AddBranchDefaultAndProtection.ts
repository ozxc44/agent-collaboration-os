import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBranchDefaultAndProtection1782210800000 implements MigrationInterface {
  name = 'AddBranchDefaultAndProtection1782210800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `ALTER TABLE "project_branches" ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false`,
      `ALTER TABLE "project_branches" ADD COLUMN IF NOT EXISTS "is_protected" boolean NOT NULL DEFAULT false`,
      `UPDATE "project_branches" SET "is_default" = true WHERE "name" = 'main'`,
      `CREATE INDEX IF NOT EXISTS "IDX_project_branches_project_default" ON "project_branches" ("project_id", "is_default")`,
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `DROP INDEX IF EXISTS "IDX_project_branches_project_default"`,
      `ALTER TABLE "project_branches" DROP COLUMN IF EXISTS "is_protected"`,
      `ALTER TABLE "project_branches" DROP COLUMN IF EXISTS "is_default"`,
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }
}
