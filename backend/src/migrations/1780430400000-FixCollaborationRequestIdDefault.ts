import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixCollaborationRequestIdDefault1780430400000 implements MigrationInterface {
  name = 'FixCollaborationRequestIdDefault1780430400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collaboration_requests" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collaboration_requests" ALTER COLUMN "id" DROP DEFAULT`);
  }
}
