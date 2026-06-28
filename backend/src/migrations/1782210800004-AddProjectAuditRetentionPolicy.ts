import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectAuditRetentionPolicy1782210800004 implements MigrationInterface {
  name = 'AddProjectAuditRetentionPolicy1782210800004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD "audit_retention_days" integer`);
    await queryRunner.query(`ALTER TABLE "projects" ADD "audit_legal_hold_enabled" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "audit_legal_hold_enabled"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "audit_retention_days"`);
  }
}
