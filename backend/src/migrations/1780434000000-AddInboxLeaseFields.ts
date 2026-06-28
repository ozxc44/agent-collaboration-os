import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddInboxLeaseFields1780434000000 implements MigrationInterface {
  name = 'AddInboxLeaseFields1780434000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE agent_inbox_items
        ADD COLUMN IF NOT EXISTS lease_token VARCHAR(64),
        ADD COLUMN IF NOT EXISTS leased_by UUID,
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS delivery_attempts INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_delivered_at TIMESTAMP
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_inbox_lease_expires
        ON agent_inbox_items (status, lease_expires_at)
        WHERE status = 'unread' AND lease_token IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_inbox_lease_expires`);
    await queryRunner.query(`
      ALTER TABLE agent_inbox_items
        DROP COLUMN IF EXISTS lease_token,
        DROP COLUMN IF EXISTS leased_by,
        DROP COLUMN IF EXISTS lease_expires_at,
        DROP COLUMN IF EXISTS delivery_attempts,
        DROP COLUMN IF EXISTS last_delivered_at
    `);
  }
}
