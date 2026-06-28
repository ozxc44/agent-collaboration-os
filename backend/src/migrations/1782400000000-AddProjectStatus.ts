import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectStatus1782400000000 implements MigrationInterface {
  name = 'AddProjectStatus1782400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "status" varchar DEFAULT 'active'`,
    );
    await queryRunner.query(
      `UPDATE "projects" SET "status" = 'active' WHERE "status" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "status"`,
    );
  }
}
