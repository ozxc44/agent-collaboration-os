import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'settings-permission-test-secret';

/**
 * Batch 32A — Settings Permission Backend Tests
 *
 * Verifies that the PATCH /v1/projects/:id route correctly enforces
 * EditProject permission for safe project metadata fields (name, description,
 * visibility). Owner and Admin can update; Member and Viewer cannot.
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
    const owner = await register(baseUrl, 'sp-owner');
    const admin = await register(baseUrl, 'sp-admin');
    const member = await register(baseUrl, 'sp-member');
    const viewer = await register(baseUrl, 'sp-viewer');

    // Owner creates the project
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Settings Permission Test',
      description: 'Original description',
      visibility: 'private',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Owner adds admin, member, and viewer to the project
    for (const [user, role] of [
      [admin, 'admin'],
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
        user_id: user.userId,
        role,
      });
      assert.equal(invite.status, 201, `invite ${role}`);
    }

    // ─── Owner can update project metadata ────────────────────────────────
    const ownerPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      name: 'Renamed by Owner',
      description: 'Owner updated description',
      visibility: 'public',
    });
    assert.equal(ownerPatch.status, 200, 'owner PATCH should succeed');
    assert.equal(ownerPatch.data.name, 'Renamed by Owner');
    assert.equal(ownerPatch.data.description, 'Owner updated description');
    assert.equal(ownerPatch.data.visibility, 'public');

    // ─── Admin can update project metadata ────────────────────────────────
    const adminPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, admin.token, {
      name: 'Renamed by Admin',
      description: 'Admin updated description',
      visibility: 'private',
    });
    assert.equal(adminPatch.status, 200, 'admin PATCH should succeed');
    assert.equal(adminPatch.data.name, 'Renamed by Admin');
    assert.equal(adminPatch.data.description, 'Admin updated description');
    assert.equal(adminPatch.data.visibility, 'private');

    // ─── Member CANNOT update project metadata (no EditProject) ──────────
    const memberPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, member.token, {
      name: 'Renamed by Member',
    });
    assert.equal(memberPatch.status, 403, 'member PATCH should be forbidden');

    // ─── Viewer CANNOT update project metadata (no EditProject) ──────────
    const viewerPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, viewer.token, {
      name: 'Renamed by Viewer',
    });
    assert.equal(viewerPatch.status, 403, 'viewer PATCH should be forbidden');

    // ─── Unauthenticated requests are rejected ───────────────────────────
    const noAuthPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, undefined, {
      name: 'Anonymous rename',
    });
    assert.equal(noAuthPatch.status, 401, 'unauthenticated PATCH should return 401');

    const badTokenPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, 'bad-token', {
      name: 'Bad token rename',
    });
    assert.equal(badTokenPatch.status, 401, 'bad token PATCH should return 401');

    // ─── Partial updates: individual fields ──────────────────────────────
    const nameOnly = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      name: 'Name Only Update',
    });
    assert.equal(nameOnly.status, 200, 'name-only PATCH should succeed');
    assert.equal(nameOnly.data.name, 'Name Only Update');
    // description and visibility should remain from the admin patch
    assert.equal(nameOnly.data.description, 'Admin updated description');
    assert.equal(nameOnly.data.visibility, 'private');

    const descOnly = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, admin.token, {
      description: 'Description Only Update',
    });
    assert.equal(descOnly.status, 200, 'description-only PATCH should succeed');
    assert.equal(descOnly.data.description, 'Description Only Update');
    assert.equal(descOnly.data.name, 'Name Only Update');

    const visOnly = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      visibility: 'public',
    });
    assert.equal(visOnly.status, 200, 'visibility-only PATCH should succeed');
    assert.equal(visOnly.data.visibility, 'public');

    // ─── Webhook secret is write-only in API responses ──────────────────
    const webhookPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      webhook_url: 'https://example.invalid/settings-permission',
      webhook_secret: 'settings-permission-webhook-secret',
      webhook_enabled_events: ['task.completed'],
    });
    assert.equal(webhookPatch.status, 200, 'owner webhook PATCH should succeed');
    assert.equal(webhookPatch.data.webhook_url, 'https://example.invalid/settings-permission');
    assert.equal(webhookPatch.data.has_webhook_secret, true);
    assert.equal('webhook_secret' in webhookPatch.data, false, 'PATCH response must not leak webhook_secret');

    const viewerRead = await api(baseUrl, 'GET', `/v1/projects/${projectId}`, viewer.token);
    assert.equal(viewerRead.status, 200, 'viewer GET should succeed');
    assert.equal(viewerRead.data.has_webhook_secret, true);
    assert.equal('webhook_secret' in viewerRead.data, false, 'viewer GET must not leak webhook_secret');

    // ─── Invalid visibility value is rejected ─────────────────────────────
    const badVis = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      visibility: 'invalid_value',
    });
    assert.equal(badVis.status, 422, 'invalid visibility should return 422');

    // ─── Non-member user cannot update project ────────────────────────────
    const outsider = await register(baseUrl, 'sp-outsider');
    const outsiderPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, outsider.token, {
      name: 'Outsider rename',
    });
    assert.equal(outsiderPatch.status, 403, 'non-member PATCH should be forbidden');

    // ─── Cross-project isolation: patching a non-existent project ─────────
    const fakeProjectPatch = await api(
      baseUrl,
      'PATCH',
      '/v1/projects/00000000-0000-0000-0000-000000000000',
      owner.token,
      { name: 'Ghost' },
    );
    assert.equal(fakeProjectPatch.status, 403, 'non-existent project should return 403 or 404');

    console.log('settings-permission tests passed');
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
    password: 'SettingsPermTest123!',
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
