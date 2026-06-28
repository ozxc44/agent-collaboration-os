import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentIdentityLifecycle1780586400000 implements MigrationInterface {
  name = 'AddAgentIdentityLifecycle1780586400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add owner_user_id for user-to-many-agents ownership
    await queryRunner.query(`
      ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS owner_user_id UUID NULL
    `);

    // Add identity_code for stable visible identity (unique, backfilled from prefix/id)
    await queryRunner.query(`
      ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS identity_code VARCHAR(32) NULL
    `);

    // Add lifecycle_status separate from heartbeat presence
    await queryRunner.query(`
      ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'active'
    `);

    // Add superseded_by_agent_id for retire/supersede
    await queryRunner.query(`
      ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS superseded_by_agent_id UUID NULL
    `);

    // Add retired_at timestamp
    await queryRunner.query(`
      ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS retired_at TIMESTAMP NULL
    `);

    // Backfill owner_user_id from created_by (creator is initial owner)
    await queryRunner.query(`
      UPDATE agents SET owner_user_id = created_by
      WHERE owner_user_id IS NULL
    `);

    // Backfill identity_code from api_key_prefix, fall back to short id
    await queryRunner.query(`
      UPDATE agents SET identity_code = api_key_prefix
      WHERE api_key_prefix IS NOT NULL
        AND api_key_prefix != ''
        AND identity_code IS NULL
    `);
    // For rows without prefix, use first 8 chars of id with 'agn_' prefix
    await queryRunner.query(`
      UPDATE agents SET identity_code = 'agn_' || LEFT(id::text, 8)
      WHERE identity_code IS NULL
    `);

    // Add unique index on identity_code
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_identity_code
        ON agents (identity_code)
        WHERE identity_code IS NOT NULL
    `);

    // Add index on owner_user_id
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_agents_owner_user_id
        ON agents (owner_user_id)
        WHERE owner_user_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_agents_identity_code`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_agents_owner_user_id`);
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS retired_at`);
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS superseded_by_agent_id`);
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS lifecycle_status`);
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS identity_code`);
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS owner_user_id`);
  }
}
