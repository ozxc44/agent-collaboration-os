import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFileProposals1780072000000 implements MigrationInterface {
  name = 'AddFileProposals1780072000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `DO $$ BEGIN
        CREATE TYPE "project_file_proposals_status_enum" AS ENUM('pending', 'approved', 'rejected');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      `CREATE TABLE IF NOT EXISTS "project_file_proposals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "file_id" uuid,
        "path" character varying(1024) NOT NULL,
        "proposed_content" text NOT NULL,
        "content_type" character varying(64) NOT NULL DEFAULT 'text/markdown',
        "content_hash" character varying(64) NOT NULL,
        "base_revision_id" uuid,
        "title" character varying(512),
        "description" text,
        "status" "project_file_proposals_status_enum" NOT NULL DEFAULT 'pending',
        "created_by_user_id" uuid,
        "created_by_agent_id" uuid,
        "reviewed_by" uuid,
        "reviewed_at" TIMESTAMP,
        "review_message" character varying(1024),
        "merged_revision_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_file_proposals" PRIMARY KEY ("id"),
        CONSTRAINT "FK_pfp_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_pfp_file" FOREIGN KEY ("file_id") REFERENCES "project_files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_pfp_created_by_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_pfp_created_by_agent" FOREIGN KEY ("created_by_agent_id") REFERENCES "agents"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_pfp_project_status" ON "project_file_proposals" ("project_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_pfp_project_path" ON "project_file_proposals" ("project_id", "path")',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'DROP TABLE IF EXISTS "project_file_proposals"',
      'DROP TYPE IF EXISTS "project_file_proposals_status_enum"',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }
}
