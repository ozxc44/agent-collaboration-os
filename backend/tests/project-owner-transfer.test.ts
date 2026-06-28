import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-owner-transfer-test-secret';

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
    const owner = await register(baseUrl, 'owner-transfer-owner');
    const admin = await register(baseUrl, 'owner-transfer-admin');
    const viewer = await register(baseUrl, 'owner-transfer-viewer');
    const outsider = await register(baseUrl, 'owner-transfer-outsider');
    const nextOwner = await register(baseUrl, 'owner-transfer-next');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Owner Transfer Test',
      description: 'Owner transfer backend coverage',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    assert.equal((await addMember(baseUrl, projectId, owner.token, admin.userId, 'admin')).status, 201);
    assert.equal((await addMember(baseUrl, projectId, owner.token, viewer.userId, 'viewer')).status, 201);
    assert.equal((await addMember(baseUrl, projectId, owner.token, nextOwner.userId, 'member')).status, 201);

    const mismatch = await transferOwner(baseUrl, projectId, owner.token, nextOwner.userId, 'Wrong Name');
    assert.equal(mismatch.status, 422, 'project-name confirmation should be required');

    const outsiderTarget = await transferOwner(baseUrl, projectId, owner.token, outsider.userId, 'Owner Transfer Test');
    assert.equal(outsiderTarget.status, 404, 'target must already be a project member');

    const adminTransfer = await transferOwner(baseUrl, projectId, admin.token, nextOwner.userId, 'Owner Transfer Test');
    assert.equal(adminTransfer.status, 403, 'admin cannot transfer ownership');

    const viewerTransfer = await transferOwner(baseUrl, projectId, viewer.token, nextOwner.userId, 'Owner Transfer Test');
    assert.equal(viewerTransfer.status, 403, 'viewer cannot transfer ownership');

    const outsiderTransfer = await transferOwner(baseUrl, projectId, outsider.token, nextOwner.userId, 'Owner Transfer Test');
    assert.equal(outsiderTransfer.status, 403, 'outsider cannot transfer ownership');

    const beforeAudit = await listAudit(baseUrl, projectId, owner.token);
    const beforeTransferEvents = beforeAudit.data.data.filter((event: any) => event.action === 'owner_transferred');
    assert.equal(beforeTransferEvents.length, 0, 'rejected transfer attempts should not create owner-transfer audit rows');

    const transfer = await transferOwner(baseUrl, projectId, owner.token, nextOwner.userId, 'Owner Transfer Test');
    assert.equal(transfer.status, 200);
    assert.equal(transfer.data.project.owner_id, nextOwner.userId);

    const members = await api(baseUrl, 'GET', `/v1/projects/${projectId}/members`, nextOwner.token);
    assert.equal(members.status, 200);
    const rows = members.data.data;
    assert.equal(rows.filter((row: any) => row.role === 'owner').length, 1, 'exactly one owner should remain');
    assert.equal(rows.find((row: any) => row.user_id === nextOwner.userId).role, 'owner');
    assert.equal(rows.find((row: any) => row.user_id === owner.userId).role, 'admin');

    const oldOwnerRead = await api(baseUrl, 'GET', `/v1/projects/${projectId}`, owner.token);
    assert.equal(oldOwnerRead.status, 200, 'old owner remains a project admin/member');
    assert.equal(oldOwnerRead.data.owner_id, nextOwner.userId);

    const repeatTransfer = await transferOwner(baseUrl, projectId, owner.token, admin.userId, 'Owner Transfer Test');
    assert.equal(repeatTransfer.status, 403, 'old owner is now admin and cannot transfer again');

    const audit = await listAudit(baseUrl, projectId, nextOwner.token);
    assert.equal(audit.status, 200);
    const transferEvent = audit.data.data.find((event: any) => event.action === 'owner_transferred');
    assert.ok(transferEvent, 'owner transfer should create audit row');
    assert.equal(transferEvent.actor_user_id, owner.userId);
    assert.equal(transferEvent.target_user_id, nextOwner.userId);
    assert.equal(transferEvent.previous_role, 'owner');
    assert.equal(transferEvent.new_role, 'owner');
    assert.equal(transferEvent.metadata.previous_owner_user_id, owner.userId);
    assert.equal(transferEvent.metadata.new_owner_user_id, nextOwner.userId);

    console.log('project-owner-transfer tests passed');
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

function transferOwner(
  baseUrl: string,
  projectId: string,
  token: string,
  targetUserId: string,
  confirmProjectName: string,
): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'POST', `/v1/projects/${projectId}/owner-transfer`, token, {
    target_user_id: targetUserId,
    confirm_project_name: confirmProjectName,
  });
}

function listAudit(baseUrl: string, projectId: string, token: string): Promise<{ status: number; data: any }> {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events`, token);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectOwnerTransferTest123!',
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
