import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCollaborationRequests1780419600000 implements MigrationInterface {
  name = 'AddCollaborationRequests1780419600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "collaboration_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "request_type" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending_owner',
        "project_id" uuid,
        "requested_by_user_id" uuid,
        "target_user_id" uuid,
        "target_agent_id" uuid,
        "requested_role" character varying,
        "note" character varying(1000),
        "reviewed_by" uuid,
        "reviewed_at" TIMESTAMP,
        "legacy_join_request_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_collaboration_requests" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_collaboration_requests_type" CHECK ("request_type" IN ('project_join', 'project_invite', 'owner_agent_bind')),
        CONSTRAINT "CHK_collaboration_requests_status" CHECK ("status" IN ('pending_agent', 'pending_owner', 'approved', 'rejected', 'cancelled', 'expired'))
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_collab_requests_project_status" ON "collaboration_requests" ("project_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_collab_requests_target_user_status" ON "collaboration_requests" ("target_user_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_collab_requests_target_agent_status" ON "collaboration_requests" ("target_agent_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_collab_requests_type_status" ON "collaboration_requests" ("request_type", "status")',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "collaboration_requests"');
  }
}
