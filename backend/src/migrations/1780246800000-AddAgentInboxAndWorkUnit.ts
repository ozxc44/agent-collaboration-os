import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentInboxAndWorkUnit1780246800000 implements MigrationInterface {
  name = 'AddAgentInboxAndWorkUnit1780246800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "agent_inbox_items" (
        "id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "recipient_agent_id" uuid NOT NULL,
        "orchestration_id" uuid,
        "task_id" uuid,
        "event_type" character varying(100) NOT NULL,
        "title" character varying(500) NOT NULL,
        "body" text,
        "payload" text,
        "status" character varying NOT NULL DEFAULT 'unread',
        "read_at" TIMESTAMP,
        "acked_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_inbox_items" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_agent_inbox_items_status" CHECK ("status" IN ('unread', 'read', 'acked')),
        CONSTRAINT "FK_agent_inbox_items_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_agent_inbox_items_recipient_agent" FOREIGN KEY ("recipient_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
      `CREATE TABLE IF NOT EXISTS "agent_work_units" (
        "id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "agent_id" uuid NOT NULL,
        "orchestration_id" uuid,
        "task_id" uuid,
        "source_event" character varying(100) NOT NULL,
        "status" character varying NOT NULL DEFAULT 'in_progress',
        "review_decision" character varying(50),
        "metrics" text,
        "normalized_work_units" double precision,
        "started_at" TIMESTAMP,
        "completed_at" TIMESTAMP,
        "reviewed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_agent_work_units" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_agent_work_units_status" CHECK ("status" IN ('in_progress', 'completed', 'blocked', 'failed', 'reviewed_approved', 'reviewed_changes_requested')),
        CONSTRAINT "FK_agent_work_units_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_agent_work_units_agent" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_agent_inbox_items_recipient_status_created" ON "agent_inbox_items" ("recipient_agent_id", "status", "created_at")',
      'CREATE INDEX IF NOT EXISTS "IDX_agent_inbox_items_recipient_created" ON "agent_inbox_items" ("recipient_agent_id", "created_at")',
      'CREATE INDEX IF NOT EXISTS "IDX_agent_work_units_project_agent" ON "agent_work_units" ("project_id", "agent_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_agent_work_units_orch_task" ON "agent_work_units" ("orchestration_id", "task_id")',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'DROP TABLE IF EXISTS "agent_work_units"',
      'DROP TABLE IF EXISTS "agent_inbox_items"',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }
}
