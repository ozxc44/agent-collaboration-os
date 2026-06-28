import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectSpaceV21779984000000 implements MigrationInterface {
  name = 'AddProjectSpaceV21779984000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"',
      `DO $$ BEGIN
        CREATE TYPE "projects_visibility_enum" AS ENUM('private', 'public');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      `DO $$ BEGIN
        CREATE TYPE "project_memories_visibility_enum" AS ENUM('project', 'agent');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      `DO $$ BEGIN
        CREATE TYPE "project_join_requests_status_enum" AS ENUM('pending', 'approved', 'rejected', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      `DO $$ BEGIN
        CREATE TYPE "project_join_requests_requested_role_enum" AS ENUM('owner', 'admin', 'member', 'viewer');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$`,
      'ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "visibility" "projects_visibility_enum" NOT NULL DEFAULT \'private\'',
      'ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "clone_source_project_id" uuid',
      'CREATE TABLE IF NOT EXISTS "project_files" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "path" character varying(1024) NOT NULL, "content" text NOT NULL, "content_type" character varying(64) NOT NULL DEFAULT \'text/markdown\', "content_hash" character varying(64) NOT NULL, "size_bytes" integer NOT NULL DEFAULT \'0\', "current_revision_id" uuid, "created_by" uuid NOT NULL, "updated_by" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_dcfa6ac7a44360dff554bac5b61" UNIQUE ("project_id", "path"), CONSTRAINT "PK_ba9b1f07ba163e0e21f72f4e02b" PRIMARY KEY ("id"), CONSTRAINT "FK_16a580442d8d941e71fd5dbd687" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION)',
      'CREATE TABLE IF NOT EXISTS "project_file_revisions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "file_id" uuid NOT NULL, "path" character varying(1024) NOT NULL, "revision_number" integer NOT NULL, "content" text NOT NULL, "content_type" character varying(64) NOT NULL DEFAULT \'text/markdown\', "content_hash" character varying(64) NOT NULL, "message" character varying(512), "created_by" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5ab8ecf59f5395a666010388ac4" UNIQUE ("file_id", "revision_number"), CONSTRAINT "PK_fb3891424f7a8134eaa642e3058" PRIMARY KEY ("id"), CONSTRAINT "FK_9e43b580b27be4ef9f1b48edf1d" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_0e71ba10f5a387cabfa29407962" FOREIGN KEY ("file_id") REFERENCES "project_files"("id") ON DELETE NO ACTION ON UPDATE NO ACTION)',
      'CREATE TABLE IF NOT EXISTS "project_memories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "agent_id" uuid, "author_user_id" uuid, "content" text NOT NULL, "tags" text, "metadata" text, "visibility" "project_memories_visibility_enum" NOT NULL DEFAULT \'project\', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_975da8368052fb804f01c21342f" PRIMARY KEY ("id"), CONSTRAINT "FK_ff13e765058cf4640781c62c61a" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_57b562578332a991f2fbd4c4d77" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_1a68c2a20da9b12f77f4cbad2f9" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION)',
      'CREATE TABLE IF NOT EXISTS "project_join_requests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "user_id" uuid NOT NULL, "status" "project_join_requests_status_enum" NOT NULL DEFAULT \'pending\', "requested_role" "project_join_requests_requested_role_enum" NOT NULL DEFAULT \'member\', "note" character varying(1000), "reviewed_by" uuid, "reviewed_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5f3df8a334448fb33e37fdf4a4b" PRIMARY KEY ("id"), CONSTRAINT "FK_0fc605420f838d706007a23a260" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION, CONSTRAINT "FK_035cd9938faf8f274510e052eed" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION)',
      'CREATE INDEX IF NOT EXISTS "IDX_e76222a5726b57d9dcafde9e4b" ON "project_files" ("project_id", "updated_at")',
      'CREATE INDEX IF NOT EXISTS "IDX_d64217255462fe02b2017a588e" ON "project_file_revisions" ("project_id", "path")',
      'CREATE INDEX IF NOT EXISTS "IDX_166a518204cafd788f2331f750" ON "project_memories" ("project_id", "updated_at")',
      'CREATE INDEX IF NOT EXISTS "IDX_7c6f8dc2dc006e72f820e6b555" ON "project_memories" ("project_id", "agent_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_08ff56fa8658a30a6ba6bce28f" ON "project_join_requests" ("project_id", "user_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_dd159eb4adab8a67c03ddbb4d5" ON "project_join_requests" ("project_id", "status")',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      'DROP TABLE IF EXISTS "project_join_requests"',
      'DROP TABLE IF EXISTS "project_memories"',
      'DROP TABLE IF EXISTS "project_file_revisions"',
      'DROP TABLE IF EXISTS "project_files"',
      'ALTER TABLE "projects" DROP COLUMN IF EXISTS "clone_source_project_id"',
      'ALTER TABLE "projects" DROP COLUMN IF EXISTS "visibility"',
      'DROP TYPE IF EXISTS "project_join_requests_requested_role_enum"',
      'DROP TYPE IF EXISTS "project_join_requests_status_enum"',
      'DROP TYPE IF EXISTS "project_memories_visibility_enum"',
      'DROP TYPE IF EXISTS "projects_visibility_enum"',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }
}
