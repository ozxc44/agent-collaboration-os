import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWorkUnitP05Fields1780333200000 implements MigrationInterface {
  name = 'AddWorkUnitP05Fields1780333200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "source_type" character varying(100)',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "provisional_work_units" double precision',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "final_work_units" double precision',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "review_score" double precision',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "idempotency_key" character varying(255)',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }

    // Add unique index on idempotency_key (nullable, sparse)
    await queryRunner.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_agent_work_units_idempotency_key" ON "agent_work_units" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'DROP INDEX IF EXISTS "UQ_agent_work_units_idempotency_key"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "idempotency_key"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "review_score"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "final_work_units"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "provisional_work_units"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "source_type"',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }
}
