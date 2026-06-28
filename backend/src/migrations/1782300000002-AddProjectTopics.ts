import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectTopics1782300000002 implements MigrationInterface {
  name = 'AddProjectTopics1782300000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "topics" text DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "topics"`,
    );
  }
}
