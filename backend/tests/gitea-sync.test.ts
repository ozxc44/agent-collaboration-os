import assert from 'node:assert/strict';
import { GiteaSyncService, type HttpClient } from '../src/services/gitea-sync.service';

function makeMockHttpClient(responses?: Array<{ status: number; body: string }>): {
  client: HttpClient;
  calls: Array<{ url: string; method: string; body?: string }>;
} {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let idx = 0;
  const client: HttpClient = (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    const response = responses?.[idx];
    idx++;
    if (response) {
      return Promise.resolve({ status: response.status, ok: response.status >= 200 && response.status < 300, body: response.body });
    }
    return Promise.resolve({ status: 200, ok: true, body: '{}' });
  };
  return { client, calls };
}

const sampleCommit = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  parentCommitId: 'ffffffff-gggg-hhhh-iiii-jjjjjjjjjjjj',
  message: 'Merge changeset: Update README to v2',
  createdByUserId: 'user-1111',
  createdByAgentId: null,
  changedFiles: [
    { op: 'upsert', path: 'README.md', file_id: 'f1', revision_id: 'r1', content_hash: 'abc123' },
  ],
  snapshot: {
    'README.md': { file_id: 'f1', revision_id: 'r1', content_hash: 'abc123' },
    'notes.md': { file_id: 'f2', revision_id: 'r2', content_hash: 'def456' },
  },
  orchestrationId: 'orch-0001',
  taskId: null,
  changesetId: 'cs-0001',
  createdAt: new Date('2026-06-01T10:00:00Z'),
};

async function main() {
  let passed = 0;

  // Test 1: Disabled by default
  {
    const svc = new GiteaSyncService({ enabled: false });
    const result = await svc.syncCommit('proj-1', 'Test Project', sampleCommit);
    assert.equal(result.action, 'skipped');
    assert.equal(result.detail.includes('disabled'), true);
    passed++;
  }

  // Test 2: Dry-run mode
  {
    const svc = new GiteaSyncService({
      enabled: true,
      serverUrl: 'https://gitea.example.com',
      dryRun: true,
    });
    const result = await svc.syncCommit('proj-1', 'Test Project', sampleCommit);
    assert.equal(result.action, 'dry_run');
    assert.equal(result.projectId, 'proj-1');
    assert.equal(result.commitId, sampleCommit.id);
    assert.equal(result.giteaRepo, 'agent-proj-1');
    assert.equal(result.detail.includes('Would sync'), true);
    passed++;
  }

  // Test 3: Dry-run mode with UUID project ID (sanitized repo name)
  {
    const svc = new GiteaSyncService({
      enabled: true,
      serverUrl: 'https://gitea.example.com',
      dryRun: true,
    });
    const uuidProject = '550e8400-e29b-41d4-a716-446655440000';
    const result = await svc.syncCommit(uuidProject, 'UUID Project', sampleCommit);
    assert.equal(result.action, 'dry_run');
    assert.equal(result.giteaRepo, 'agent-550e8400-e29b-41d4-a716-446655440000');
    passed++;
  }

  // Test 4: Enabled without token still works (token is optional for read-only operations)
  {
    const svc = new GiteaSyncService({
      enabled: true,
      serverUrl: 'https://gitea.example.com',
      dryRun: true,
    });
    assert.equal(svc.isEnabled(), true);
    assert.equal(svc.isDryRun(), true);
    passed++;
  }

  // Test 5: Mock HTTP client — repo exists, content-push path (empty snapshot → no file writes)
  {
    const emptySnapshotCommit = { ...sampleCommit, snapshot: {} };
    const { client, calls } = makeMockHttpClient([
      { status: 200, body: '{}' },           // repo exists
    ]);
    const svc = new GiteaSyncService({
      enabled: true,
      serverUrl: 'https://gitea.example.com',
      dryRun: false,
      token: 'mock-token',
    }, client);
    const result = await svc.syncCommit('proj-mock', 'Mock Project', emptySnapshotCommit);
    assert.equal(result.action, 'synced');
    assert.equal(result.giteaRepo, 'agent-proj-mock');
    assert.equal(result.detail.includes('Pushed 0 files'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url.includes('/repos/'), true);
    passed++;
  }

  // Test 6: Mock HTTP client — auto-create repo on 404
  {
    const emptySnapshotCommit = { ...sampleCommit, snapshot: {} };
    const { client, calls } = makeMockHttpClient([
      { status: 404, body: '{"message":"Not Found"}' }, // repo not found
      { status: 201, body: '{"name":"agent-proj-new"}' }, // repo created
    ]);
    const svc = new GiteaSyncService({
      enabled: true,
      serverUrl: 'https://gitea.example.com',
      dryRun: false,
      token: 'mock-token',
    }, client);
    const result = await svc.syncCommit('proj-new', 'New Project', emptySnapshotCommit);
    assert.equal(result.action, 'synced');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url.includes('/user/repos'), true);
    passed++;
  }

  // Test 7: Mock HTTP client — error handling
  {
    const { client } = makeMockHttpClient([
      { status: 500, body: 'Internal Server Error' },
    ]);
    const svc = new GiteaSyncService({
      enabled: true,
      serverUrl: 'https://gitea.example.com',
      dryRun: false,
      token: 'mock-token',
    }, client);
    const result = await svc.syncCommit('proj-err', 'Error Project', sampleCommit);
    assert.equal(result.action, 'error');
    assert.equal(result.error, 'Internal Server Error');
    passed++;
  }

  // Test 8: Commit with agent author
  {
    const agentCommit = { ...sampleCommit, createdByUserId: null, createdByAgentId: 'agent-007' };
    const svc = new GiteaSyncService({
      enabled: true,
      serverUrl: 'https://gitea.example.com',
      dryRun: true,
    });
    const result = await svc.syncCommit('proj-agent', 'Agent Project', agentCommit);
    assert.equal(result.action, 'dry_run');
    assert.equal(result.detail.includes('agent-007'), false); // detail doesn't include author in dry-run
    passed++;
  }

  // Test 9: Dry-run with org prefix
  {
    const svc = new GiteaSyncService({
      enabled: true,
      serverUrl: 'https://gitea.example.com',
      org: 'my-org',
      dryRun: true,
    });
    const result = await svc.syncCommit('proj-org', 'Org Project', sampleCommit);
    assert.equal(result.action, 'dry_run');
    assert.equal(result.detail.includes('my-org'), true);
    passed++;
  }

  // Test 10: getConfig returns config values
  {
    const svc = new GiteaSyncService({ enabled: true, serverUrl: 'https://test.local', repoPrefix: 'custom-' });
    const cfg = svc.getConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.serverUrl, 'https://test.local');
    assert.equal(cfg.repoPrefix, 'custom-');
    passed++;
  }

  console.log(`gitea-sync tests passed: ${passed}/10`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
