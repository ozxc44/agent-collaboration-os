import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectPackages1782200000000 implements MigrationInterface {
  name = 'AddProjectPackages1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "project_packages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "package_type" character varying(255) NOT NULL DEFAULT 'generic',
        "version" character varying(255) NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "repository_url" character varying(2048),
        "metadata" text,
        "created_by" uuid NOT NULL,
        "updated_by" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_packages" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_packages_project_name_version" UNIQUE ("project_id", "name", "version"),
        CONSTRAINT "FK_project_packages_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_packages_project_id" ON "project_packages" ("project_id")',
      'CREATE INDEX IF NOT EXISTS "IDX_project_packages_project_updated" ON "project_packages" ("project_id", "updated_at" DESC)',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "project_packages"');
  }
}
