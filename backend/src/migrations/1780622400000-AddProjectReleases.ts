import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectReleases1780622400000 implements MigrationInterface {
  name = 'AddProjectReleases1780622400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "project_releases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "tag_name" character varying(255) NOT NULL,
        "target_commit_id" character varying(255),
        "body" text NOT NULL DEFAULT '',
        "draft" boolean NOT NULL DEFAULT true,
        "prerelease" boolean NOT NULL DEFAULT false,
        "created_by" uuid NOT NULL,
        "updated_by" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "published_at" TIMESTAMP,
        CONSTRAINT "PK_project_releases" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_releases_project_tag" UNIQUE ("project_id", "tag_name"),
        CONSTRAINT "FK_project_releases_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_releases_project_id" ON "project_releases" ("project_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_releases_project_updated" ON "project_releases" ("project_id", "updated_at" DESC)',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "project_releases"');
  }
}
