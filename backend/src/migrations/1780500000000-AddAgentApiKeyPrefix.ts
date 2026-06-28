import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentApiKeyPrefix1780500000000 implements MigrationInterface {
  name = 'AddAgentApiKeyPrefix1780500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add dedicated, indexable api_key_prefix column
    await queryRunner.query(`
      ALTER TABLE agents
        ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(8)
    `);

    // Backfill existing rows from config_json.api_key_prefix where present.
    // Uses a safe json extraction — rows with invalid json_text are skipped.
    await queryRunner.query(`
      UPDATE agents
      SET api_key_prefix = TRIM(BOTH '"' FROM (config_json::json->>'api_key_prefix')::text)
      WHERE config_json IS NOT NULL
        AND config_json::json->>'api_key_prefix' IS NOT NULL
        AND config_json::json->>'api_key_prefix' != ''
        AND config_json::json->>'api_key_prefix' != 'null'
    `);

    // Add index for fast prefix lookups during agent API key auth
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_agents_api_key_prefix
        ON agents (api_key_prefix)
        WHERE api_key_prefix IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_agents_api_key_prefix`);
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS api_key_prefix`);
  }
}
