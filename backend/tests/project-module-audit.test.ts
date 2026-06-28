import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-module-audit-test-secret';

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
    const bodySentinel = 'MODULE_AUDIT_BODY_SENTINEL_SECRET';
    const metadataSentinel = 'MODULE_AUDIT_METADATA_SENTINEL_SECRET';
    const owner = await register(baseUrl, 'module-audit-owner');
    const viewer = await register(baseUrl, 'module-audit-viewer');
    const outsider = await register(baseUrl, 'module-audit-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Module Audit Test',
      description: 'Audit modules',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const inviteViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(inviteViewer.status, 201);

    const wikiCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/wiki`, owner.token, {
      title: 'Audit Wiki',
      slug: 'audit-wiki',
      content: `wiki body ${bodySentinel}`,
    });
    assert.equal(wikiCreate.status, 201);
    const wikiUpdate = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/wiki/audit-wiki`, owner.token, {
      title: 'Audit Wiki Updated',
      content: `updated wiki body ${bodySentinel}`,
    });
    assert.equal(wikiUpdate.status, 200);

    const releaseCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, owner.token, {
      title: 'Audit Release',
      tag_name: 'v1.0.0',
      body: `release body ${bodySentinel}`,
      draft: true,
    });
    assert.equal(releaseCreate.status, 201);
    const releaseUpdate = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/releases/${releaseCreate.data.id}`, owner.token, {
      title: 'Audit Release Updated',
      body: `release updated ${bodySentinel}`,
      draft: false,
    });
    assert.equal(releaseUpdate.status, 200);

    const packageCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, owner.token, {
      name: 'audit-package',
      version: '1.0.0',
      package_type: 'npm',
      description: `package description ${bodySentinel}`,
      metadata: { token: metadataSentinel, safe: 'value' },
    });
    assert.equal(packageCreate.status, 201);
    const packageUpdate = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/packages/${packageCreate.data.id}`, owner.token, {
      description: `package update ${bodySentinel}`,
      metadata: { secret: metadataSentinel, changed: true },
    });
    assert.equal(packageUpdate.status, 200);

    const securityCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, {
      title: 'Audit Security',
      slug: 'audit-security',
      severity: 'high',
      status: 'draft',
      affected_package: 'audit-package',
      cve_id: 'CVE-2099-0001',
      body: `security exploit notes ${bodySentinel}`,
      references: ['https://example.invalid/security-audit'],
    });
    assert.equal(securityCreate.status, 201);
    const securityUpdate = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/security-advisories/${securityCreate.data.id}`, owner.token, {
      severity: 'critical',
      status: 'published',
      body: `security updated ${bodySentinel}`,
      references: ['https://example.invalid/security-audit-updated'],
    });
    assert.equal(securityUpdate.status, 200);

    const audit = await listAudit(baseUrl, projectId, owner.token);
    assert.equal(audit.status, 200);
    const actions = new Set(audit.data.data.map((event: any) => event.action));
    for (const action of [
      'wiki_page_created',
      'wiki_page_updated',
      'release_created',
      'release_updated',
      'package_created',
      'package_updated',
      'security_advisory_created',
      'security_advisory_updated',
    ]) {
      assert.ok(actions.has(action), `expected audit action ${action}`);
    }

    const metadataText = JSON.stringify(audit.data.data.map((event: any) => event.metadata));
    assert.equal(metadataText.includes(bodySentinel), false, 'module audit metadata must not include body/description text');
    assert.equal(metadataText.includes(metadataSentinel), false, 'module audit metadata must not include package metadata secrets');

    const packageUpdateEvent = findAction(audit.data.data, 'package_updated');
    assert.ok(packageUpdateEvent.metadata.changed_fields.includes('description'));
    assert.ok(packageUpdateEvent.metadata.changed_fields.includes('metadata'));

    const securityUpdateEvent = findAction(audit.data.data, 'security_advisory_updated');
    assert.ok(securityUpdateEvent.metadata.changed_fields.includes('body'));
    assert.ok(securityUpdateEvent.metadata.changed_fields.includes('references'));
    assert.equal(securityUpdateEvent.metadata.new_severity, 'critical');
    assert.equal(securityUpdateEvent.metadata.new_status, 'published');

    const filtered = await api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events?action=wiki_page_created`, owner.token);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.data.data.length >= 1);
    assert.ok(filtered.data.data.every((event: any) => event.action === 'wiki_page_created'));

    const beforeRejectedTotal = audit.data.total;
    const forbiddenWiki = await api(baseUrl, 'POST', `/v1/projects/${projectId}/wiki`, viewer.token, {
      title: 'Forbidden Wiki',
      content: 'nope',
    });
    assert.equal(forbiddenWiki.status, 403);
    const invalidRelease = await api(baseUrl, 'POST', `/v1/projects/${projectId}/releases`, owner.token, {
      title: 'Invalid Release',
      tag_name: '',
    });
    assert.equal(invalidRelease.status, 422);
    const afterRejected = await listAudit(baseUrl, projectId, owner.token);
    assert.equal(afterRejected.data.total, beforeRejectedTotal, 'rejected module mutations must not create audit rows');

    const viewerAudit = await listAudit(baseUrl, projectId, viewer.token);
    assert.equal(viewerAudit.status, 200, 'viewer should be able to read project audit');
    const outsiderAudit = await listAudit(baseUrl, projectId, outsider.token);
    assert.equal(outsiderAudit.status, 403, 'outsider should not read project audit');

    console.log('project-module-audit tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

function findAction(events: any[], action: string): any {
  const event = events.find((candidate) => candidate.action === action);
  assert.ok(event, `missing ${action}`);
  return event;
}

function listAudit(baseUrl: string, projectId: string, token: string): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events?limit=100`, token);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectModuleAuditTest123!',
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
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
