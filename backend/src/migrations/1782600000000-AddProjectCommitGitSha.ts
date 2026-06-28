import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProjectCommitGitSha1782600000000 implements MigrationInterface {
  name = 'AddProjectCommitGitSha1782600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite uses ADD COLUMN; Postgres too. TypeORM IF NOT EXISTS guards re-runs.
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      await queryRunner.query(`ALTER TABLE "project_commits" ADD COLUMN "git_sha" varchar(40)`);
    } else {
      await queryRunner.query(`ALTER TABLE "project_commits" ADD COLUMN IF NOT EXISTS "git_sha" varchar(40)`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const dbType = queryRunner.connection.options.type;
    if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
      // SQLite cannot DROP COLUMN easily before 3.35; recreate-without is overkill here.
      // Best-effort: leave the column on downgrade.
      return;
    }
    await queryRunner.query(`ALTER TABLE "project_commits" DROP COLUMN IF EXISTS "git_sha"`);
  }
}
