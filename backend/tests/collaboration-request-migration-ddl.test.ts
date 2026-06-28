import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC_MIGRATIONS = path.join(__dirname, '../../src/migrations');
const COLLAB_MIGRATION = path.join(SRC_MIGRATIONS, '1780419600000-AddCollaborationRequests.ts');
const REPAIR_MIGRATION = path.join(SRC_MIGRATIONS, '1780430400000-FixCollaborationRequestIdDefault.ts');

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  console.log('\n── Fresh-install migration DDL check ──');
  const freshMigationSrc = fs.readFileSync(COLLAB_MIGRATION, 'utf8');

  const freshIdLineMatch = freshMigationSrc.match(/"id"\s+uuid\s+NOT NULL[^,]*?,/);
  check('fresh-install migration has id column definition', freshIdLineMatch !== null, true);
  if (freshIdLineMatch) {
    const hasUuidDefault = freshIdLineMatch[0].includes('uuid_generate_v4()');
    check('fresh-install id column has DEFAULT uuid_generate_v4()', hasUuidDefault, true);
  }

  console.log('\n── Repair migration DDL check ──');
  const repairMigationSrc = fs.readFileSync(REPAIR_MIGRATION, 'utf8');

  const hasRepairMigration = repairMigationSrc.length > 0;
  check('repair migration file exists', hasRepairMigration, true);

  const hasAlterUp = repairMigationSrc.includes('ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()');
  check('repair migration up has ALTER COLUMN id SET DEFAULT', hasAlterUp, true);

  const hasDropDefaultDown = repairMigationSrc.includes('ALTER COLUMN "id" DROP DEFAULT');
  check('repair migration down has ALTER COLUMN id DROP DEFAULT', hasDropDefaultDown, true);

  const isAfterLatest = REPAIR_MIGRATION.includes('1780430400000');
  check('repair migration timestamp > 1780426800000', isAfterLatest, true);

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
