import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectSecurityAdvisories1782203600000 implements MigrationInterface {
  name = 'AddProjectSecurityAdvisories1782203600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "project_security_advisories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "slug" character varying(255) NOT NULL,
        "severity" character varying(32) NOT NULL DEFAULT 'medium',
        "status" character varying(32) NOT NULL DEFAULT 'draft',
        "affected_package" character varying(255),
        "affected_version" character varying(255),
        "fixed_version" character varying(255),
        "cve_id" character varying(64),
        "body" text NOT NULL DEFAULT '',
        "references" text,
        "created_by" uuid NOT NULL,
        "updated_by" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "published_at" TIMESTAMP,
        CONSTRAINT "PK_project_security_advisories" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_security_advisories_project_slug" UNIQUE ("project_id", "slug"),
        CONSTRAINT "FK_project_security_advisories_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_security_advisories_project_id" ON "project_security_advisories" ("project_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_security_advisories_project_updated" ON "project_security_advisories" ("project_id", "updated_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "IDX_project_security_advisories_project_severity" ON "project_security_advisories" ("project_id", "severity")',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "project_security_advisories"');
  }
}
