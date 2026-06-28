import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DEBUG_LOG_API_ENABLED = 'true';
process.env.DEBUG_LOG_API_TOKEN = 'debug-test-token';
process.env.LOG_LEVEL = 'debug';
process.env.DEBUG_LOG_MAX_BYTES = '0';

const logDir = mkdtempSync(join(tmpdir(), 'zz-agent-debug-api-'));
process.env.DEBUG_LOG_FILE = join(logDir, 'debug.jsonl');

async function main(): Promise<void> {
  const app = (await import('../src/app')).default;
  const { log } = await import('../src/services/logger');
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    log.info('ok request', {
      request_id: 'req-200',
      path: '/v1/debug-target',
      status: 200,
      duration_ms: 20,
      project_id: 'project-a',
    });
    log.warn('offline dispatch', {
      request_id: 'req-409',
      path: '/v1/debug-target',
      status: 409,
      duration_ms: 85,
      project_id: 'project-a',
      agent_id: 'agent-offline',
    });
    log.error('server exploded', {
      request_id: 'req-500',
      path: '/v1/other-target',
      status: 500,
      duration_ms: 1500,
      project_id: 'project-b',
    });

    const noToken = await api(baseUrl, '/v1/debug/logs?lines=10');
    assert.equal(noToken.status, 401);

    const status409 = await api(baseUrl, '/v1/debug/logs?status=409&lines=10', true);
    assert.equal(status409.status, 200);
    assert.deepEqual(status409.data.entries.map((entry: any) => entry.request_id), ['req-409']);

    const statusClass5xx = await api(baseUrl, '/v1/debug/logs?status_class=5xx&lines=10', true);
    assert.equal(statusClass5xx.status, 200);
    assert.deepEqual(statusClass5xx.data.entries.map((entry: any) => entry.request_id), ['req-500']);

    const slow = await api(baseUrl, '/v1/debug/logs?min_duration_ms=1000&lines=10', true);
    assert.equal(slow.status, 200);
    assert.deepEqual(slow.data.entries.map((entry: any) => entry.request_id), ['req-500']);

    const pathFilter = await api(baseUrl, '/v1/debug/logs?path=/v1/debug-target&lines=10', true);
    assert.equal(pathFilter.status, 200);
    assert.deepEqual(
      pathFilter.data.entries.map((entry: any) => entry.request_id),
      ['req-200', 'req-409'],
    );

    const ndjson = await api(baseUrl, '/v1/debug/logs?status=409&format=ndjson&lines=10', true);
    assert.equal(ndjson.status, 200);
    assert.match(ndjson.text, /"request_id":"req-409"/);
    assert.doesNotMatch(ndjson.text, /req-200/);

    console.log('debug-log-api tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(logDir, { recursive: true, force: true });
  }
}

async function api(
  baseUrl: string,
  path: string,
  token = false,
): Promise<{ status: number; text: string; data: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { 'X-Debug-Token': 'debug-test-token' } : undefined,
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, text, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
