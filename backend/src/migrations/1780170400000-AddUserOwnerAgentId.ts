import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserOwnerAgentId1780170400000 implements MigrationInterface {
  name = 'AddUserOwnerAgentId1780170400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "owner_agent_id" uuid NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "owner_agent_id"`
    );
  }
}
