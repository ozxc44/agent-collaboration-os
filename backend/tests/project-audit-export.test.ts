import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-audit-export-test-secret';

/**
 * Batch 56D — Project Audit Search and Export Backend Tests
 *
 * Verifies that GET /v1/projects/:id/audit-events supports safe text search
 * and that GET /v1/projects/:id/audit-events/export returns redacted JSON/CSV
 * honoring action, q, limit, and offset.
 */
async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const owner = await register(baseUrl, 'audit-export-owner');
    const viewer = await register(baseUrl, 'audit-export-viewer');
    const target = await register(baseUrl, 'audit-export-target');
    const outsider = await register(baseUrl, 'audit-export-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Audit Export Test',
      description: 'Export audit backend coverage',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addViewer.status, 201);

    // Add target as member so we have member audit events.
    const addTarget = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: target.userId,
      role: 'member',
    });
    assert.equal(addTarget.status, 201);

    // Change settings to create a project_settings_updated event with safe metadata.
    const settingsPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      name: 'Project Audit Export Test Renamed',
      webhook_url: 'https://example.invalid/export-test',
      webhook_secret: 'export-test-webhook-secret-value',
    });
    assert.equal(settingsPatch.status, 200);

    // ─── Text search (q) over action and actor/target display names ────────
    const memberSearch = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events?q=member_added`,
      owner.token,
    );
    assert.equal(memberSearch.status, 200);
    assert.ok(
      memberSearch.data.data.every((event: any) => event.action === 'member_added'),
      'q=member_added should only return member_added events',
    );

    const actorSearch = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events?q=${encodeURIComponent('audit-export-owner')}`,
      owner.token,
    );
    assert.equal(actorSearch.status, 200);
    assert.ok(
      actorSearch.data.data.every((event: any) => event.actor_display_name === 'audit-export-owner'),
      'q over actor display name should filter to owner actor',
    );

    const targetSearch = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events?q=${encodeURIComponent('audit-export-target')}`,
      owner.token,
    );
    assert.equal(targetSearch.status, 200);
    assert.ok(
      targetSearch.data.data.some((event: any) => event.target_display_name === 'audit-export-target'),
      'q over target display name should find target events',
    );

    // ─── Text search over safe metadata values only ────────────────────────
    const metadataSearch = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events?q=${encodeURIComponent('export-test')}`,
      owner.token,
    );
    assert.equal(metadataSearch.status, 200);
    assert.ok(
      metadataSearch.data.data.some(
        (event: any) =>
          event.action === 'project_settings_updated' &&
          event.metadata.new_webhook_url === 'https://example.invalid/export-test',
      ),
      'q over safe metadata value should find settings event',
    );
    assert.ok(
      !metadataSearch.data.data.some((event: any) =>
        JSON.stringify(event.metadata).includes('export-test-webhook-secret-value'),
      ),
      'raw webhook secret must not be searchable or present in metadata',
    );

    // ─── JSON export returns redacted data with correct headers ────────────
    const jsonExport = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=json`,
      owner.token,
    );
    assert.equal(jsonExport.status, 200);
    assert.equal(jsonExport.contentType?.includes('application/json'), true);
    assert.ok(
      jsonExport.contentDisposition?.includes('audit-events.json'),
      'JSON export should suggest audit-events.json filename',
    );
    assert.ok(Array.isArray(jsonExport.data), 'JSON export should be an array');
    assert.ok(
      jsonExport.data.some((event: any) => event.action === 'project_settings_updated'),
      'JSON export should include settings event',
    );
    assert.ok(
      !JSON.stringify(jsonExport.data).includes('export-test-webhook-secret-value'),
      'JSON export must not include raw webhook secret',
    );

    // ─── CSV export returns escaped, redacted rows ─────────────────────────
    const csvExport = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=csv`,
      owner.token,
      undefined,
      true,
    );
    assert.equal(csvExport.status, 200);
    assert.equal(csvExport.contentType?.includes('text/csv'), true);
    assert.ok(csvExport.contentDisposition?.includes('audit-events.csv'));
    assert.ok(typeof csvExport.raw === 'string', 'CSV export should be a string');
    const csvLines = (csvExport.raw as string).split('\n').filter((line) => line.length > 0);
    assert.equal(csvLines.length >= 2, true, 'CSV should have header and at least one row');
    assert.equal(csvLines[0].startsWith('id,'), true, 'CSV header should start with id');
    assert.ok(
      !(csvExport.raw as string).includes('export-test-webhook-secret-value'),
      'CSV export must not include raw webhook secret',
    );

    // ─── Export honors action filter ───────────────────────────────────────
    const jsonExportFiltered = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=json&action=member_added`,
      owner.token,
    );
    assert.equal(jsonExportFiltered.status, 200);
    assert.ok(Array.isArray(jsonExportFiltered.data));
    assert.ok(
      jsonExportFiltered.data.every((event: any) => event.action === 'member_added'),
      'export action filter should restrict to member_added',
    );

    // ─── Export honors q, limit, and offset ────────────────────────────────
    const jsonExportSearch = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=json&q=project_settings_updated`,
      owner.token,
    );
    assert.equal(jsonExportSearch.status, 200);
    assert.ok(
      jsonExportSearch.data.every((event: any) => event.action === 'project_settings_updated'),
      'export q filter should restrict to matching events',
    );

    const jsonExportLimited = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=json&limit=1`,
      owner.token,
    );
    assert.equal(jsonExportLimited.status, 200);
    assert.equal(jsonExportLimited.data.length, 1, 'export limit should cap rows');

    const jsonExportOffset = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=json&offset=1`,
      owner.token,
    );
    assert.equal(jsonExportOffset.status, 200);
    assert.ok(
      jsonExportOffset.data.length < jsonExport.data.length,
      'export offset should skip rows',
    );

    // ─── Export rejects invalid/missing format ─────────────────────────────
    const missingFormat = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export`,
      owner.token,
    );
    assert.equal(missingFormat.status, 422, 'missing format should be rejected');

    const invalidFormat = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=xml`,
      owner.token,
    );
    assert.equal(invalidFormat.status, 422, 'invalid format should be rejected');

    // ─── Export is permission-gated ────────────────────────────────────────
    const viewerExport = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=json`,
      viewer.token,
    );
    assert.equal(viewerExport.status, 200, 'viewer should be able to export audit trail');

    const outsiderExport = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events/export?format=json`,
      outsider.token,
    );
    assert.equal(outsiderExport.status, 403, 'outsider should not be able to export audit trail');

    console.log('project-audit-export tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectAuditExportTest123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
  };
}

async function api(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  raw?: boolean,
): Promise<{ status: number; data: any; raw?: string; contentType?: string; contentDisposition?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  if (!raw) {
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
  }
  return {
    status: response.status,
    data: raw ? text : data,
    raw: text,
    contentType: response.headers.get('content-type') || undefined,
    contentDisposition: response.headers.get('content-disposition') || undefined,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
