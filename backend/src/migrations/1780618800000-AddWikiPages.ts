import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWikiPages1780618800000 implements MigrationInterface {
  name = 'AddWikiPages1780618800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "wiki_pages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "slug" character varying(255) NOT NULL,
        "title" character varying(500) NOT NULL,
        "content" text NOT NULL,
        "revision" integer NOT NULL DEFAULT 1,
        "created_by" uuid NOT NULL,
        "updated_by" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_wiki_pages" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_wiki_pages_project_slug" UNIQUE ("project_id", "slug"),
        CONSTRAINT "FK_wiki_pages_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_wiki_pages_project_id" ON "wiki_pages" ("project_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_wiki_pages_project_updated" ON "wiki_pages" ("project_id", "updated_at" DESC)',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "wiki_pages"');
  }
}
