import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'git-threeway-test-secret';
process.env.PROJECT_GIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-3way-'));

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

async function main(): Promise<void> {
  const { ensureProjectRepo, gitAddFile, gitCommit, gitMergeBase } =
    await import('../src/services/project-git.service');

  // A throwaway project id; git service keys only on it as a dir name.
  const projectId = '3way-test';
  await ensureProjectRepo(projectId);

  console.log('── 1. base commit (common ancestor) ──');
  await gitAddFile(projectId, 'README.md', '# base\nshared line\n');
  const baseSha = await gitCommit(projectId, 'base');
  check('base sha is 40-hex', /^[0-9a-f]{40}$/.test(baseSha), true);

  console.log('── 2. ours: add a feature file on main ──');
  await gitAddFile(projectId, 'FEATURE_A.md', '# feature A\n');
  const oursSha = await gitCommit(projectId, 'feature A on main');

  console.log('── 3. theirs: divergent commit on top ──');
  await gitAddFile(projectId, 'FEATURE_B.md', '# feature B\n');
  const theirsSha = await gitCommit(projectId, 'feature B');

  console.log('── 4. merge base of ours/theirs = ours (linear: theirs descends from ours) ──');
  const mb = await gitMergeBase(projectId, oursSha, theirsSha);
  check('merge base found', !!mb, true);
  // In a linear history where theirs descends from ours, the merge base is ours
  // (the most recent common ancestor). A true divergence would share an older base.
  check('merge base === oursSha (linear ancestor)', mb, oursSha);

  console.log('── 5. merge base of a commit with itself = itself ──');
  const selfMb = await gitMergeBase(projectId, oursSha, oursSha);
  check('self merge base === self', selfMb, oursSha);

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
  if (failed > 0) process.exit(1);
  try { fs.rmSync(process.env.PROJECT_GIT_DIR!, { recursive: true, force: true }); } catch {}
}

main().catch((e) => { console.error(e); process.exit(1); });
