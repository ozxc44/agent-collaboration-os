import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRewardPreviewFields1780423200000 implements MigrationInterface {
  name = 'AddRewardPreviewFields1780423200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "reward_rule_version" character varying(50)',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "calculation_snapshot_json" json',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "adjusted_by_user_id" uuid',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "adjustment_reason" character varying(500)',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "adjustment_value" double precision',
      'ALTER TABLE "agent_work_units" ADD COLUMN IF NOT EXISTS "locked_at" timestamp',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "locked_at"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "adjustment_value"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "adjustment_reason"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "adjusted_by_user_id"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "calculation_snapshot_json"',
      'ALTER TABLE "agent_work_units" DROP COLUMN IF EXISTS "reward_rule_version"',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }
}
