import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectCommitVerified1782210800005 implements MigrationInterface {
  name = 'AddProjectCommitVerified1782210800005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_commits" ADD "verification_status" character varying(32) NOT NULL DEFAULT 'unavailable'`);
    await queryRunner.query(`ALTER TABLE "project_commits" ADD "verification_source" character varying(64) NOT NULL DEFAULT 'local_unavailable'`);
    await queryRunner.query(`ALTER TABLE "project_commits" ADD "verification_reason" character varying(255)`);
    await queryRunner.query(`ALTER TABLE "project_commits" ADD "verification_actor_type" character varying(16)`);
    await queryRunner.query(`ALTER TABLE "project_commits" ADD "verification_actor_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_commits" ADD "verified_at" TIMESTAMP`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_commits" DROP COLUMN "verified_at"`);
    await queryRunner.query(`ALTER TABLE "project_commits" DROP COLUMN "verification_actor_id"`);
    await queryRunner.query(`ALTER TABLE "project_commits" DROP COLUMN "verification_actor_type"`);
    await queryRunner.query(`ALTER TABLE "project_commits" DROP COLUMN "verification_reason"`);
    await queryRunner.query(`ALTER TABLE "project_commits" DROP COLUMN "verification_source"`);
    await queryRunner.query(`ALTER TABLE "project_commits" DROP COLUMN "verification_status"`);
  }
}
