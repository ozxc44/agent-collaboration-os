import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectChangesetRequestedReviewers1782210800003 implements MigrationInterface {
  name = 'AddProjectChangesetRequestedReviewers1782210800003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" ADD "requested_reviewers" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_changesets" DROP COLUMN "requested_reviewers"`);
  }
}
