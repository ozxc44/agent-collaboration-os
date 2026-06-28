import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-settings-audit-test-secret';

/**
 * Batch 50 — Project Settings Audit Trail Backend Tests
 *
 * Verifies that successful PATCH /v1/projects/:id settings updates create
 * project_settings_updated audit events with safe metadata, and that rejected
 * updates do not create audit events.
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
    const owner = await register(baseUrl, 'settings-audit-owner');
    const viewer = await register(baseUrl, 'settings-audit-viewer');
    const outsider = await register(baseUrl, 'settings-audit-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Settings Audit Test',
      description: 'Original description',
      visibility: 'private',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Invite a viewer so we can verify audit read isolation later.
    const inviteViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(inviteViewer.status, 201);

    // ─── Successful settings update creates a project_settings_updated event ─
    const settingsPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      name: 'Settings Audit Renamed',
      description: 'Settings audit updated description',
      visibility: 'public',
      webhook_url: 'https://example.invalid/settings-audit',
      webhook_secret: 'settings-audit-webhook-secret-value',
      webhook_enabled_events: ['task.completed', 'task.failed'],
    });
    assert.equal(settingsPatch.status, 200, 'settings PATCH should succeed');
    assert.equal(settingsPatch.data.name, 'Settings Audit Renamed');
    assert.equal(settingsPatch.data.has_webhook_secret, true);
    assert.equal('webhook_secret' in settingsPatch.data, false, 'PATCH response must not leak webhook_secret');

    const audit = await listAudit(baseUrl, projectId, owner.token);
    assert.equal(audit.status, 200);
    const settingsEvents = audit.data.data.filter((event: any) => event.action === 'project_settings_updated');
    assert.equal(settingsEvents.length, 1, 'exactly one settings audit event should be recorded');

    const event = settingsEvents[0];
    assert.equal(event.actor_user_id, owner.userId);
    assert.deepEqual(new Set(event.metadata.changed_fields), new Set([
      'name',
      'description',
      'visibility',
      'webhook_url',
      'webhook_enabled_events',
      'webhook_secret',
    ]));
    assert.equal(event.metadata.previous_name, 'Project Settings Audit Test');
    assert.equal(event.metadata.new_name, 'Settings Audit Renamed');
    assert.equal(event.metadata.previous_description, 'Original description');
    assert.equal(event.metadata.new_description, 'Settings audit updated description');
    assert.equal(event.metadata.previous_visibility, 'private');
    assert.equal(event.metadata.new_visibility, 'public');
    assert.equal(event.metadata.previous_webhook_url, null);
    assert.equal(event.metadata.new_webhook_url, 'https://example.invalid/settings-audit');
    assert.deepEqual(event.metadata.previous_webhook_enabled_events, []);
    assert.deepEqual(event.metadata.new_webhook_enabled_events, ['task.completed', 'task.failed']);
    assert.equal(event.metadata.had_webhook_secret, false);
    assert.equal(event.metadata.has_webhook_secret, true);
    assert.equal('previous_webhook_secret' in event.metadata, false, 'raw previous webhook_secret must not be in metadata');
    assert.equal('new_webhook_secret' in event.metadata, false, 'raw new webhook_secret must not be in metadata');
    assert.equal('webhook_secret' in event.metadata, false, 'raw webhook_secret must not be in metadata');

    // ─── Rotating an existing webhook secret is still audited without raw text ─
    const rotateSecretPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      webhook_secret: 'settings-audit-rotated-secret-value',
    });
    assert.equal(rotateSecretPatch.status, 200, 'rotating webhook_secret should succeed');
    assert.equal(rotateSecretPatch.data.has_webhook_secret, true);

    const afterRotate = await listAudit(baseUrl, projectId, owner.token);
    const rotatedEvents = afterRotate.data.data.filter(
      (event: any) => event.action === 'project_settings_updated',
    );
    assert.equal(rotatedEvents.length, 2, 'rotating webhook_secret should create a second settings audit event');
    const rotateEvent = rotatedEvents.find(
      (event: any) =>
        Array.isArray(event.metadata.changed_fields) &&
        event.metadata.changed_fields.length === 1 &&
        event.metadata.changed_fields[0] === 'webhook_secret',
    );
    assert.ok(rotateEvent, 'secret rotation event should record only webhook_secret as changed');
    assert.deepEqual(rotateEvent.metadata.changed_fields, ['webhook_secret']);
    assert.equal(rotateEvent.metadata.had_webhook_secret, true);
    assert.equal(rotateEvent.metadata.has_webhook_secret, true);
    assert.equal(JSON.stringify(rotateEvent.metadata).includes('settings-audit-rotated-secret-value'), false);

    // ─── Action filter returns settings audit events ───────────────────────
    const filtered = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/audit-events?action=project_settings_updated`,
      owner.token,
    );
    assert.equal(filtered.status, 200);
    assert.ok(filtered.data.data.every((event: any) => event.action === 'project_settings_updated'));
    assert.ok(filtered.data.data.some((event: any) => event.metadata.new_name === 'Settings Audit Renamed'));

    // ─── Rejected updates do not create settings audit events ──────────────
    const beforeRejectedCount = afterRotate.data.total;

    const invalidVisibility = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      visibility: 'invalid_value',
    });
    assert.equal(invalidVisibility.status, 422, 'invalid visibility should be rejected');

    const forbiddenViewerPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, viewer.token, {
      name: 'Viewer rename attempt',
    });
    assert.equal(forbiddenViewerPatch.status, 403, 'viewer PATCH should be forbidden');

    const forbiddenOutsiderPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, outsider.token, {
      name: 'Outsider rename attempt',
    });
    assert.equal(forbiddenOutsiderPatch.status, 403, 'outsider PATCH should be forbidden');

    const afterRejected = await listAudit(baseUrl, projectId, owner.token);
    assert.equal(
      afterRejected.data.total,
      beforeRejectedCount,
      'rejected settings updates should not create audit rows',
    );
    assert.equal(
      afterRejected.data.data.filter((event: any) => event.action === 'project_settings_updated').length,
      2,
      'no additional settings audit events should be recorded after rejections',
    );

    // ─── No-op update (same values) does not create another audit event ─────
    const noopPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      name: 'Settings Audit Renamed',
      visibility: 'public',
    });
    assert.equal(noopPatch.status, 200, 'noop PATCH should still succeed');

    const afterNoop = await listAudit(baseUrl, projectId, owner.token);
    assert.equal(
      afterNoop.data.data.filter((event: any) => event.action === 'project_settings_updated').length,
      2,
      'noop update should not create another settings audit event',
    );

    // ─── Clearing webhook secret records presence change only ──────────────
    const clearSecretPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      webhook_secret: null,
    });
    assert.equal(clearSecretPatch.status, 200, 'clearing webhook_secret should succeed');
    assert.equal(clearSecretPatch.data.has_webhook_secret, false);

    const afterClear = await listAudit(baseUrl, projectId, owner.token);
    const clearEvents = afterClear.data.data.filter(
      (event: any) => event.action === 'project_settings_updated',
    );
    assert.equal(clearEvents.length, 3, 'clearing webhook_secret should create a settings audit event');

    const clearEvent = clearEvents.find(
      (event: any) =>
        Array.isArray(event.metadata.changed_fields) &&
        event.metadata.changed_fields.length === 1 &&
        event.metadata.changed_fields[0] === 'webhook_secret' &&
        event.metadata.has_webhook_secret === false,
    );
    assert.ok(clearEvent, 'secret clearing event should record only webhook_secret as changed');
    assert.deepEqual(clearEvent.metadata.changed_fields, ['webhook_secret']);
    assert.equal(clearEvent.metadata.had_webhook_secret, true);
    assert.equal(clearEvent.metadata.has_webhook_secret, false);
    assert.equal('previous_webhook_secret' in clearEvent.metadata, false, 'raw secret must not leak');
    assert.equal('new_webhook_secret' in clearEvent.metadata, false, 'raw secret must not leak');

    // ─── Viewer can read settings audit events; outsider cannot ────────────
    const viewerAudit = await listAudit(baseUrl, projectId, viewer.token);
    assert.equal(viewerAudit.status, 200, 'viewer should be able to read audit trail');
    assert.ok(viewerAudit.data.data.some((event: any) => event.action === 'project_settings_updated'));

    const outsiderAudit = await listAudit(baseUrl, projectId, outsider.token);
    assert.equal(outsiderAudit.status, 403, 'outsider should not be able to read audit trail');

    console.log('project-settings-audit tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

function listAudit(baseUrl: string, projectId: string, token: string): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events`, token);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectSettingsAuditTest123!',
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
