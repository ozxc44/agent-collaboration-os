/**
 * Negative regression test for live-load-proof.
 *
 * Proves the live load proof exits non-zero and writes pass:false when
 * inbox guarantees would fail. Uses the LOAD_PROOF_FAIL_INBOX_GUARANTEES=1
 * test hook to deterministically force the failure condition.
 *
 * Approach: starts a local backend, runs the live-load-proof as a child process
 * with the failure hook, and verifies the exit code and artifact contents.
 *
 * Usage:
 *   npm run build && node dist/tests/live-load-proof-negative.test.js
 *
 * Exit codes:
 *   0  negative test passed (probe correctly failed)
 *   1  negative test failed (probe should have failed but didn't, or errored)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = 'live-load-proof-negative-test-secret';
process.env.INBOX_LEASE_ENABLED = 'true';

const E_FAIL = 1;

function log(...args: unknown[]) {
  console.log('[live-load-proof-negative]', ...args);
}

async function main(): Promise<void> {
  // Start a local backend on a random port.
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  log(`local backend started on ${baseUrl}`);

  // Verify the server is actually responding before spawning child.
  const healthCheck = await fetch(`${baseUrl}/v1/health`);
  assert.equal(healthCheck.status, 200, `health check failed: ${healthCheck.status}`);
  log('health check OK');

  const artifactDir = path.resolve(process.cwd(), `load-proof-artifacts-negative-${Date.now()}`);

  try {
    // Run the live load proof with the inbox-guarantee failure hook.
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn('node', ['dist/tests/live-load-proof.test.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          LOAD_PROOF_FAIL_INBOX_GUARANTEES: '1',
          LOAD_PROOF_WORKERS: '1',
          LOAD_PROOF_TASKS_PER_WORKER: '1',
          LOAD_PROOF_ITERATIONS: '1',
          LOAD_PROOF_ARTIFACT_DIR: artifactDir,
          LOAD_PROOF_EMAIL: `llp-neg-${Date.now()}@test.invalid`,
          LOAD_PROOF_PASSWORD: 'test-password-123',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      child.on('close', (code) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });

    log('child stdout:', result.stdout.slice(0, 3000));
    log('child stderr:', result.stderr.slice(0, 3000));
    log('child exit code:', result.exitCode);

    // The probe must exit non-zero (E_PROOF_FAIL = 1).
    assert.equal(result.exitCode, E_FAIL, `expected exit code ${E_FAIL} (PROOF_FAIL) but got ${result.exitCode}`);
    log('✅ probe correctly exited non-zero');

    // Read the artifact and verify pass: false.
    let artifactFiles: string[];
    try {
      artifactFiles = (await fsPromises.readdir(artifactDir)).filter((f) => f.endsWith('.json'));
    } catch {
      // If artifact dir doesn't exist, check the default location as fallback.
      const defaultDir = path.resolve(process.cwd(), 'load-proof-artifacts');
      const allFiles = await fsPromises.readdir(defaultDir);
      const newest = allFiles
        .filter((f) => f.startsWith('live-load-proof-'))
        .sort()
        .pop();
      if (newest) {
        log('(artifact found in default dir)');
        artifactFiles = [newest];
      } else {
        assert.fail('no artifact files found in either custom or default artifact directory');
        return;
      }
    }

    assert.ok(artifactFiles.length > 0, 'expected at least one artifact file');

    const artifactPath =
      artifactDir && fs.existsSync(artifactDir)
        ? path.join(artifactDir, artifactFiles[artifactFiles.length - 1])
        : path.resolve(process.cwd(), 'load-proof-artifacts', artifactFiles[artifactFiles.length - 1]);
    const artifact = JSON.parse(await fsPromises.readFile(artifactPath, 'utf-8'));

    assert.equal(artifact.pass, false, `expected artifact.pass=false but got ${artifact.pass}`);
    log('✅ artifact has pass: false');

    assert.equal(
      artifact.inbox_guarantees.every_task_ready_for_review,
      false,
      'expected every_task_ready_for_review=false',
    );
    assert.equal(
      artifact.inbox_guarantees.every_dispatched_item_leased,
      false,
      'expected every_dispatched_item_leased=false',
    );
    log('✅ inbox guarantees correctly false in artifact');

    log('negative test PASSED — live load proof correctly fails on bad inbox guarantees');
  } finally {
    server.close();
    await fsPromises.rm(artifactDir, { recursive: true, force: true }).catch(() => {});
    await AppDataSource.destroy().catch(() => {});
  }
}

main().catch((error) => {
  console.error('[live-load-proof-negative][ERROR]', error);
  process.exit(E_FAIL);
});
