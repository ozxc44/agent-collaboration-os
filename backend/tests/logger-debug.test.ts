import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDebugLogConfig, log, readRecentLogEntries, requestLog } from '../src/services/logger';

const savedEnv = { ...process.env };

function restoreEnv(): void {
  process.env = { ...savedEnv };
}

function withTempLogFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'zz-agent-debug-log-'));
  return { dir, file: join(dir, 'debug.jsonl') };
}

function testFileLoggingAndRedaction(): void {
  const { dir, file } = withTempLogFile();
  try {
    process.env.DEBUG_LOG_FILE = file;
    process.env.LOG_LEVEL = 'debug';
    process.env.DEBUG_LOG_MAX_BYTES = '0';

    log.info('agent request received', {
      agent_id: 'agent-1',
      project_id: 'project-1',
      authorization: 'Bearer secret-token',
      nested: {
        password: 'secret-password',
        safe: 'visible',
      },
    });
    log.debug('debug detail', { request_id: 'req-1', api_key: 'zzk_secret_key' });

    const raw = readFileSync(file, 'utf8');
    assert.match(raw, /agent request received/);
    assert.match(raw, /debug detail/);
    assert.match(raw, /"authorization":"\[REDACTED\]"/);
    assert.match(raw, /"password":"\[REDACTED\]"/);
    assert.match(raw, /"api_key":"\[REDACTED\]"/);
    assert.doesNotMatch(raw, /secret-token/);
    assert.doesNotMatch(raw, /secret-password/);
    assert.doesNotMatch(raw, /zzk_secret_key/);

    const result = readRecentLogEntries({ lines: 10, agentId: 'agent-1' });
    assert.equal(result.file, file);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].project_id, 'project-1');
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
}

function testLogConfigDefaults(): void {
  restoreEnv();
  delete process.env.DEBUG_LOG_FILE;
  delete process.env.LOG_FILE;
  delete process.env.DEBUG_LOG_ENABLED;
  delete process.env.FILE_LOGGING;
  delete process.env.DEBUG_LOG_API_ENABLED;
  process.env.NODE_ENV = 'production';

  const config = getDebugLogConfig();
  assert.equal(config.fileEnabled, false);
  assert.equal(config.filePath, null);
  assert.equal(config.apiEnabled, false);
  assert.equal(config.level, 'info');
}

function testLogFilteringByLevelAndSince(): void {
  const { dir, file } = withTempLogFile();
  try {
    process.env.DEBUG_LOG_FILE = file;
    process.env.LOG_LEVEL = 'debug';
    process.env.DEBUG_LOG_MAX_BYTES = '0';

    log.info('before', { request_id: 'req-before' });
    const since = new Date(Date.now() - 1000).toISOString();
    log.warn('after warning', { request_id: 'req-after' });

    const warnings = readRecentLogEntries({ lines: 5, level: 'warn', since });
    assert.equal(warnings.entries.length, 1);
    assert.equal(warnings.entries[0].request_id, 'req-after');
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
}

function testRequestLogDoesNotPersistQueryValues(): void {
  const { dir, file } = withTempLogFile();
  try {
    process.env.DEBUG_LOG_FILE = file;
    process.env.LOG_LEVEL = 'debug';
    process.env.DEBUG_LOG_MAX_BYTES = '0';

    requestLog(
      {
        method: 'GET',
        path: '/v1/projects',
        originalUrl: '/v1/projects?token=secret-query-token&filter=open',
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'logger-test' : undefined),
        params: {},
        query: { token: 'secret-query-token', filter: 'open' },
      } as any,
      200,
      12,
    );

    const raw = readFileSync(file, 'utf8');
    assert.match(raw, /"original_url":"\/v1\/projects"/);
    assert.match(raw, /"query_keys":\["filter","token"\]/);
    assert.doesNotMatch(raw, /secret-query-token/);
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
}

testLogConfigDefaults();
testFileLoggingAndRedaction();
testLogFilteringByLevelAndSince();
testRequestLogDoesNotPersistQueryValues();

console.log('logger-debug tests passed');
