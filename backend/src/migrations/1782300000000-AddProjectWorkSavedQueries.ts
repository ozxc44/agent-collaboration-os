import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectWorkSavedQueries1782300000000 implements MigrationInterface {
  name = 'AddProjectWorkSavedQueries1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "project_work_saved_queries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "name" character varying(128) NOT NULL,
        "description" text,
        "scope" character varying(64) NOT NULL DEFAULT 'work',
        "query" text NOT NULL,
        "created_by" uuid NOT NULL,
        "updated_by" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_work_saved_queries" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_work_saved_queries_project_name" UNIQUE ("project_id", "name"),
        CONSTRAINT "FK_project_work_saved_queries_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_work_saved_queries_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_project_work_saved_queries_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_work_saved_queries_project_updated" ON "project_work_saved_queries" ("project_id", "updated_at" DESC)',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "project_work_saved_queries"');
  }
}
