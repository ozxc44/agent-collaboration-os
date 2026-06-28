import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectChangesetComments1782300000001 implements MigrationInterface {
  name = 'AddProjectChangesetComments1782300000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "project_changeset_comments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "changeset_id" uuid NOT NULL,
        "parent_comment_id" uuid,
        "author_type" character varying(16) NOT NULL,
        "author_id" uuid NOT NULL,
        "content" text NOT NULL,
        "file_path" character varying(1024),
        "side" character varying(16),
        "line" integer,
        "base_revision_id" uuid,
        "head_revision_id" uuid,
        "status" character varying(16) NOT NULL DEFAULT 'active',
        "resolved_by" uuid,
        "resolved_at" TIMESTAMP,
        "deleted_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_changeset_comments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_changeset_comments_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changeset_comments_changeset" FOREIGN KEY ("changeset_id") REFERENCES "project_changesets"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_changeset_comments_parent" FOREIGN KEY ("parent_comment_id") REFERENCES "project_changeset_comments"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_changeset_comments_project_changeset" ON "project_changeset_comments" ("project_id", "changeset_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_changeset_comments_changeset_status" ON "project_changeset_comments" ("changeset_id", "status")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_changeset_comments_changeset_file_path" ON "project_changeset_comments" ("changeset_id", "file_path")',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "project_changeset_comments"');
  }
}
