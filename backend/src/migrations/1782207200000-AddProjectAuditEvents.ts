import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectAuditEvents1782207200000 implements MigrationInterface {
  name = 'AddProjectAuditEvents1782207200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "project_audit_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "actor_user_id" uuid NOT NULL,
        "target_user_id" uuid,
        "action" character varying NOT NULL,
        "previous_role" character varying,
        "new_role" character varying,
        "metadata_json" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_audit_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_audit_events_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_audit_events_actor" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_audit_events_target" FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_audit_events_project_created" ON "project_audit_events" ("project_id", "created_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "IDX_project_audit_events_project_action_created" ON "project_audit_events" ("project_id", "action", "created_at" DESC)',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "project_audit_events"');
  }
}
