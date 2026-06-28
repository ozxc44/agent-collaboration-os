import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUsernameToUsers1780611600000 implements MigrationInterface {
  name = 'AddUsernameToUsers1780611600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const driver = queryRunner.connection.driver.options.type;

    if (driver === 'postgres') {
      await queryRunner.query(
        `ALTER TABLE "users" ADD COLUMN "username" character varying(64)`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "IDX_users_username" ON "users" ("username") WHERE "username" IS NOT NULL`,
      );
    } else {
      // SQLite: a plain UNIQUE INDEX permits multiple NULLs, matching the sparse semantics.
      await queryRunner.query(
        `ALTER TABLE "users" ADD COLUMN "username" varchar(64)`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "IDX_users_username" ON "users" ("username")`,
      );
    }

    // Backfill usernames from display_name (falling back to email prefix).
    // Collisions are resolved by appending an incrementing suffix.
    const users = await queryRunner.query(
      `SELECT "id", "email", "display_name" FROM "users"`,
    );
    const taken = new Set<string>();

    for (const user of users) {
      const rawBase = user.display_name || user.email.split('@')[0];
      const base = this.slugify(rawBase);
      if (!base) {
        continue;
      }

      let candidate = base.slice(0, 64);
      let suffix = 2;
      while (taken.has(candidate)) {
        const suffixStr = `-${suffix}`;
        candidate = `${base.slice(0, 64 - suffixStr.length)}${suffixStr}`;
        suffix++;
      }
      taken.add(candidate);

      if (driver === 'postgres') {
        await queryRunner.query(
          `UPDATE "users" SET "username" = $1 WHERE "id" = $2`,
          [candidate, user.id],
        );
      } else {
        await queryRunner.query(
          `UPDATE "users" SET "username" = ? WHERE "id" = ?`,
          [candidate, user.id],
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_username"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "username"`);
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }
}
