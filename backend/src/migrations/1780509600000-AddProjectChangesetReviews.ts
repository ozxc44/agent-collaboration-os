import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectChangesetReviews1780509600000 implements MigrationInterface {
  name = 'AddProjectChangesetReviews1780509600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "project_changesets"
      ADD COLUMN IF NOT EXISTS "reviews" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "project_changesets"
      DROP COLUMN IF EXISTS "reviews"
    `);
  }
}
