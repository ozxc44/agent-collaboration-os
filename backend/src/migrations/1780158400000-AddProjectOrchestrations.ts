import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectOrchestrations1780158400000 implements MigrationInterface {
  name = 'AddProjectOrchestrations1780158400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "project_orchestrations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "objective" text NOT NULL,
        "status" character varying NOT NULL DEFAULT 'planning',
        "base_path" character varying(1024) NOT NULL,
        "session_id" uuid,
        "main_agent_id" uuid,
        "created_by_user_id" uuid,
        "created_by_agent_id" uuid,
        "acceptance_criteria" text,
        "metadata" text,
        "completed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_orchestrations" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_project_orchestrations_status" CHECK ("status" IN ('planning', 'running', 'ready_for_acceptance', 'completed', 'blocked', 'failed', 'cancelled')),
        CONSTRAINT "FK_project_orchestrations_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_orchestrations_session" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_orchestrations_main_agent" FOREIGN KEY ("main_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_orchestrations_created_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_orchestrations_created_agent" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_orchestrations_project_status" ON "project_orchestrations" ("project_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_orchestrations_project_created" ON "project_orchestrations" ("project_id", "created_at")',
      `CREATE TABLE IF NOT EXISTS "project_orchestration_tasks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "orchestration_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "goal" text NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "assigned_agent_id" uuid,
        "worker_task_path" character varying(1024) NOT NULL,
        "worker_context_path" character varying(1024) NOT NULL,
        "result_path" character varying(1024),
        "evidence_path" character varying(1024),
        "acceptance_criteria" text,
        "depends_on" text,
        "review_notes" text,
        "requested_changes" text,
        "created_by_user_id" uuid,
        "created_by_agent_id" uuid,
        "completed_at" TIMESTAMP,
        "reviewed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_orchestration_tasks" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_project_orchestration_tasks_status" CHECK ("status" IN ('pending', 'dispatched', 'running', 'ready_for_review', 'approved', 'changes_requested', 'blocked', 'failed', 'cancelled')),
        CONSTRAINT "FK_project_orchestration_tasks_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_orchestration_tasks_orchestration" FOREIGN KEY ("orchestration_id") REFERENCES "project_orchestrations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_orchestration_tasks_assigned_agent" FOREIGN KEY ("assigned_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_orchestration_tasks_created_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_orchestration_tasks_created_agent" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_orchestration_tasks_project_status" ON "project_orchestration_tasks" ("project_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_orchestration_tasks_orch_status" ON "project_orchestration_tasks" ("orchestration_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_orchestration_tasks_agent_status" ON "project_orchestration_tasks" ("assigned_agent_id", "status")',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'DROP TABLE IF EXISTS "project_orchestration_tasks"',
      'DROP TABLE IF EXISTS "project_orchestrations"',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }
}
