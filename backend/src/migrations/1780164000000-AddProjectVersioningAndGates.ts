import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectVersioningAndGates1780164000000 implements MigrationInterface {
  name = 'AddProjectVersioningAndGates1780164000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `DO $$ BEGIN
        CREATE TYPE "project_changesets_status_enum" AS ENUM('draft', 'submitted', 'ready_for_review', 'changes_requested', 'approved', 'merged', 'conflict', 'rejected', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      `DO $$ BEGIN
        CREATE TYPE "project_gate_templates_kind_enum" AS ENUM('programming', 'research', 'writing', 'tool_use', 'custom');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      `DO $$ BEGIN
        CREATE TYPE "project_gate_attempts_status_enum" AS ENUM('started', 'submitted', 'prefilter_running', 'prefilter_failed', 'prefilter_passed', 'under_owner_review', 'approved', 'rejected', 'expired');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      `CREATE TABLE IF NOT EXISTS "project_branches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "name" character varying(128) NOT NULL DEFAULT 'main',
        "head_commit_id" uuid,
        "created_by_user_id" uuid,
        "created_by_agent_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_branches" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_branches_project_name" UNIQUE ("project_id", "name"),
        CONSTRAINT "FK_project_branches_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_branches_created_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_branches_created_agent" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      `CREATE TABLE IF NOT EXISTS "project_commits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "branch_id" uuid NOT NULL,
        "parent_commit_id" uuid,
        "message" character varying(512) NOT NULL,
        "snapshot" text NOT NULL,
        "changed_files" text NOT NULL,
        "created_by_user_id" uuid,
        "created_by_agent_id" uuid,
        "orchestration_id" uuid,
        "task_id" uuid,
        "changeset_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_commits" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_commits_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_commits_branch" FOREIGN KEY ("branch_id") REFERENCES "project_branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_commits_parent" FOREIGN KEY ("parent_commit_id") REFERENCES "project_commits"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_commits_created_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_commits_created_agent" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_commits_orchestration" FOREIGN KEY ("orchestration_id") REFERENCES "project_orchestrations"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_commits_task" FOREIGN KEY ("task_id") REFERENCES "project_orchestration_tasks"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      `CREATE TABLE IF NOT EXISTS "project_changesets" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "branch_id" uuid NOT NULL,
        "base_commit_id" uuid,
        "title" character varying(255) NOT NULL,
        "description" text,
        "status" "project_changesets_status_enum" NOT NULL DEFAULT 'submitted',
        "file_ops" text NOT NULL,
        "conflicts" text,
        "result_path" character varying(1024),
        "evidence_path" character varying(1024),
        "created_by_user_id" uuid,
        "created_by_agent_id" uuid,
        "reviewed_by_user_id" uuid,
        "reviewed_by_agent_id" uuid,
        "review_notes" text,
        "merged_commit_id" uuid,
        "orchestration_id" uuid,
        "task_id" uuid,
        "reviewed_at" TIMESTAMP,
        "merged_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_changesets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_changesets_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changesets_branch" FOREIGN KEY ("branch_id") REFERENCES "project_branches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changesets_base_commit" FOREIGN KEY ("base_commit_id") REFERENCES "project_commits"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changesets_merged_commit" FOREIGN KEY ("merged_commit_id") REFERENCES "project_commits"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changesets_created_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changesets_created_agent" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changesets_orchestration" FOREIGN KEY ("orchestration_id") REFERENCES "project_orchestrations"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changesets_task" FOREIGN KEY ("task_id") REFERENCES "project_orchestration_tasks"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      `DO $$ BEGIN
        ALTER TABLE "project_branches" ADD CONSTRAINT "FK_project_branches_head_commit" FOREIGN KEY ("head_commit_id") REFERENCES "project_commits"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      `CREATE TABLE IF NOT EXISTS "project_gate_templates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "key" character varying(128) NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" text,
        "kind" "project_gate_templates_kind_enum" NOT NULL DEFAULT 'custom',
        "definition" text NOT NULL,
        "is_preset" boolean NOT NULL DEFAULT false,
        "created_by_user_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_gate_templates" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_gate_templates_key" UNIQUE ("key"),
        CONSTRAINT "FK_project_gate_templates_created_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      `CREATE TABLE IF NOT EXISTS "project_gates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "template_id" uuid NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "required" boolean NOT NULL DEFAULT true,
        "owner_agent_id" uuid,
        "config" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_gates" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_gates_project_template" UNIQUE ("project_id", "template_id"),
        CONSTRAINT "FK_project_gates_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_gates_template" FOREIGN KEY ("template_id") REFERENCES "project_gate_templates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_gates_owner_agent" FOREIGN KEY ("owner_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      `CREATE TABLE IF NOT EXISTS "project_gate_attempts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "gate_id" uuid NOT NULL,
        "join_request_id" uuid,
        "applicant_user_id" uuid,
        "applicant_agent_id" uuid,
        "status" "project_gate_attempts_status_enum" NOT NULL DEFAULT 'started',
        "started_at" TIMESTAMP NOT NULL,
        "deadline_at" TIMESTAMP NOT NULL,
        "submitted_at" TIMESTAMP,
        "reviewed_at" TIMESTAMP,
        "submission" text,
        "prefilter_result" text,
        "review_notes" text,
        "reviewed_by_user_id" uuid,
        "reviewed_by_agent_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_gate_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_gate_attempts_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_gate_attempts_gate" FOREIGN KEY ("gate_id") REFERENCES "project_gates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_gate_attempts_join_request" FOREIGN KEY ("join_request_id") REFERENCES "project_join_requests"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_gate_attempts_applicant_user" FOREIGN KEY ("applicant_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_gate_attempts_applicant_agent" FOREIGN KEY ("applicant_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_gate_attempts_reviewed_user" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_gate_attempts_reviewed_agent" FOREIGN KEY ("reviewed_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_branches_project_updated" ON "project_branches" ("project_id", "updated_at")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_commits_project_created" ON "project_commits" ("project_id", "created_at")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_commits_project_branch" ON "project_commits" ("project_id", "branch_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_changesets_project_status" ON "project_changesets" ("project_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_changesets_project_branch_status" ON "project_changesets" ("project_id", "branch_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_changesets_project_task" ON "project_changesets" ("project_id", "task_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_gate_templates_kind_preset" ON "project_gate_templates" ("kind", "is_preset")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_gates_project_enabled" ON "project_gates" ("project_id", "enabled")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_gate_attempts_project_status" ON "project_gate_attempts" ("project_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_gate_attempts_project_join" ON "project_gate_attempts" ("project_id", "join_request_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_gate_attempts_project_agent" ON "project_gate_attempts" ("project_id", "applicant_agent_id")',
      `INSERT INTO "project_gate_templates" ("key", "name", "description", "kind", "definition", "is_preset")
        VALUES
        ('preset.programming.basic', 'Basic Programming Gate', 'Timed deterministic programming admission test for agent project membership.', 'programming', '{"time_limit_minutes":30,"expected_artifacts":["result_md","evidence"],"allowed_commands":["npm test","npm run test:unit","npm run build","pytest","pytest -q"],"allowed_paths":["src/","tests/","backend/src/","backend/tests/","README.md","docs/"],"checks":["result_md_present","evidence_present","tests_passed","commands_allowed","paths_allowed","deadline_not_expired"]}', true),
        ('preset.research.basic', 'Basic Research Gate', 'Evidence-first research admission test with source and summary checks.', 'research', '{"time_limit_minutes":45,"expected_artifacts":["result_md","evidence.sources"],"checks":["result_md_present","sources_present","deadline_not_expired"]}', true),
        ('preset.tool-use.basic', 'Basic Tool Use Gate', 'Tool execution admission test requiring command evidence and structured output.', 'tool_use', '{"time_limit_minutes":30,"expected_artifacts":["result_md","evidence.commands"],"allowed_commands":["npm run build","npm run test:unit","pytest -q"],"checks":["result_md_present","commands_present","commands_allowed","deadline_not_expired"]}', true)
        ON CONFLICT ("key") DO NOTHING`,
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'ALTER TABLE IF EXISTS "project_branches" DROP CONSTRAINT IF EXISTS "FK_project_branches_head_commit"',
      'DROP TABLE IF EXISTS "project_gate_attempts"',
      'DROP TABLE IF EXISTS "project_gates"',
      'DROP TABLE IF EXISTS "project_gate_templates"',
      'DROP TABLE IF EXISTS "project_changesets"',
      'DROP TABLE IF EXISTS "project_commits"',
      'DROP TABLE IF EXISTS "project_branches"',
      'DROP TYPE IF EXISTS "project_gate_attempts_status_enum"',
      'DROP TYPE IF EXISTS "project_gate_templates_kind_enum"',
      'DROP TYPE IF EXISTS "project_changesets_status_enum"',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }
}
