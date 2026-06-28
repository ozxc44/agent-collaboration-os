import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddBranchProtectionRules1782210800001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'project_branches',
      new TableColumn({
        name: 'protection_rules',
        type: 'text',
        isNullable: true,
      })
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('project_branches', 'protection_rules');
  }
}
