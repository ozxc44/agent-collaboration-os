import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectWebhookDeliveries1782303600000 implements MigrationInterface {
  name = 'AddProjectWebhookDeliveries1782303600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const queries = [
      `CREATE TABLE IF NOT EXISTS "project_webhook_deliveries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "event_id" character varying(255) NOT NULL,
        "event_type" character varying(255) NOT NULL,
        "attempt" integer NOT NULL,
        "status" character varying NOT NULL,
        "http_status_code" integer,
        "message" text,
        "masked_url" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_webhook_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_webhook_deliveries_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
      'CREATE INDEX IF NOT EXISTS "IDX_project_webhook_deliveries_project_created" ON "project_webhook_deliveries" ("project_id", "created_at" DESC)',
      'CREATE INDEX IF NOT EXISTS "IDX_project_webhook_deliveries_project_event_created" ON "project_webhook_deliveries" ("project_id", "event_id", "created_at" DESC)',
    ];

    for (const query of queries) {
      await queryRunner.query(query);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "project_webhook_deliveries"');
  }
}
