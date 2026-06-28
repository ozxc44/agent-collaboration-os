import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectChangesetMergeQueue1782210800006 implements MigrationInterface {
  name = 'AddProjectChangesetMergeQueue1782210800006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" ADD "merge_queue_position" integer`);
    await queryRunner.query(`ALTER TABLE "project_changesets" ADD "queued_at" TIMESTAMP`);
    await queryRunner.query(`ALTER TABLE "project_changesets" ADD "queued_by_user_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_changesets" ADD "queued_by_agent_id" uuid`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" DROP COLUMN "queued_by_agent_id"`);
    await queryRunner.query(`ALTER TABLE "project_changesets" DROP COLUMN "queued_by_user_id"`);
    await queryRunner.query(`ALTER TABLE "project_changesets" DROP COLUMN "queued_at"`);
    await queryRunner.query(`ALTER TABLE "project_changesets" DROP COLUMN "merge_queue_position"`);
  }
}
