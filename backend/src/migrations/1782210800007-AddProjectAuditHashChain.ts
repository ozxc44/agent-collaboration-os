import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectAuditHashChain1782210800007 implements MigrationInterface {
  name = 'AddProjectAuditHashChain1782210800007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_audit_events" ADD "chain_prev_hash" varchar(64)`);
    await queryRunner.query(`ALTER TABLE "project_audit_events" ADD "chain_hash" varchar(64)`);
    await queryRunner.query(`ALTER TABLE "project_audit_events" ADD "chain_hash_version" varchar(16)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_audit_events" DROP COLUMN "chain_hash_version"`);
    await queryRunner.query(`ALTER TABLE "project_audit_events" DROP COLUMN "chain_hash"`);
    await queryRunner.query(`ALTER TABLE "project_audit_events" DROP COLUMN "chain_prev_hash"`);
  }
}
