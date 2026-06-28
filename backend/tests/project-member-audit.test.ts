import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-member-audit-test-secret';

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
    const owner = await register(baseUrl, 'audit-owner');
    const viewer = await register(baseUrl, 'audit-viewer');
    const target = await register(baseUrl, 'audit-target');
    const outsider = await register(baseUrl, 'audit-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Member Audit Test',
      description: 'Member audit backend coverage',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const ownerRoleAdd = await addMember(baseUrl, projectId, owner.token, outsider.userId, 'owner');
    assert.equal(ownerRoleAdd.status, 422, 'rejected owner role add should fail before audit');
    assert.equal((await listAudit(baseUrl, projectId, owner.token)).data.data.length, 0);

    const addViewer = await addMember(baseUrl, projectId, owner.token, viewer.userId, 'viewer');
    assert.equal(addViewer.status, 201);

    const addTarget = await addMember(baseUrl, projectId, owner.token, target.userId, 'member');
    assert.equal(addTarget.status, 201);

    const patchTarget = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/members/${target.userId}`, owner.token, {
      role: 'admin',
    });
    assert.equal(patchTarget.status, 200);

    const deleteTarget = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/members/${target.userId}`, owner.token);
    assert.equal(deleteTarget.status, 204);

    const audit = await listAudit(baseUrl, projectId, owner.token);
    assert.equal(audit.status, 200);
    assert.ok(audit.data.data.length >= 4, 'successful add/add/change/remove actions should be audited');

    const targetEvents = audit.data.data.filter((event: any) => event.target_user_id === target.userId);
    assert.deepEqual(
      new Set(targetEvents.map((event: any) => event.action)),
      new Set(['member_added', 'member_role_changed', 'member_removed']),
    );

    const roleChange = targetEvents.find((event: any) => event.action === 'member_role_changed');
    assert.equal(roleChange.previous_role, 'member');
    assert.equal(roleChange.new_role, 'admin');
    assert.equal(roleChange.actor_user_id, owner.userId);
    assert.equal(roleChange.target_display_name, 'audit-target');

    const removal = targetEvents.find((event: any) => event.action === 'member_removed');
    assert.equal(removal.previous_role, 'admin');
    assert.equal(removal.new_role, null);

    const viewerRead = await listAudit(baseUrl, projectId, viewer.token);
    assert.equal(viewerRead.status, 200, 'project viewer should be able to read audit trail');
    assert.ok(viewerRead.data.data.some((event: any) => event.action === 'member_removed'));

    const beforeRejectedMutations = viewerRead.data.total;
    const viewerPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/members/${viewer.userId}`, viewer.token, {
      role: 'member',
    });
    assert.equal(viewerPatch.status, 403, 'viewer cannot mutate members');
    const afterRejectedMutations = await listAudit(baseUrl, projectId, owner.token);
    assert.equal(afterRejectedMutations.data.total, beforeRejectedMutations, 'rejected mutation should not create audit row');

    const outsiderRead = await listAudit(baseUrl, projectId, outsider.token);
    assert.equal(outsiderRead.status, 403, 'outsider cannot read project audit trail');

    console.log('project-member-audit tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function addMember(
  baseUrl: string,
  projectId: string,
  token: string,
  userId: string,
  role: string,
): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, token, {
    user_id: userId,
    role,
  });
}

function listAudit(baseUrl: string, projectId: string, token: string): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events`, token);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectMemberAuditTest123!',
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
