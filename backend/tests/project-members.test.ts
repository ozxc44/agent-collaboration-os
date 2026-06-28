import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-members-test-secret';

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
    const owner = await register(baseUrl, 'members-owner');
    const admin = await register(baseUrl, 'members-admin');
    const member = await register(baseUrl, 'members-member');
    const viewer = await register(baseUrl, 'members-viewer');
    const removable = await register(baseUrl, 'members-removable');
    const outsider = await register(baseUrl, 'members-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Members Test',
      description: 'Member management backend coverage',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    assert.equal((await addMember(baseUrl, projectId, owner.token, admin.userId, 'admin')).status, 201);
    assert.equal((await addMember(baseUrl, projectId, owner.token, member.userId, 'member')).status, 201);
    assert.equal((await addMember(baseUrl, projectId, owner.token, viewer.userId, 'viewer')).status, 201);
    assert.equal((await addMember(baseUrl, projectId, owner.token, removable.userId, 'viewer')).status, 201);

    const ownerCreate = await addMember(baseUrl, projectId, owner.token, outsider.userId, 'owner');
    assert.equal(ownerCreate.status, 422, 'POST member role=owner should be rejected');

    const ownerDefaultRole = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: outsider.userId,
    });
    assert.equal(ownerDefaultRole.status, 201, 'missing role should still default to member');
    assert.equal(ownerDefaultRole.data.role, 'member');

    const ownerPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/members/${member.userId}`, owner.token, {
      role: 'admin',
    });
    assert.equal(ownerPatch.status, 200, 'owner can promote member to admin');
    assert.equal(ownerPatch.data.role, 'admin');

    const adminPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/members/${member.userId}`, admin.token, {
      role: 'viewer',
    });
    assert.equal(adminPatch.status, 200, 'admin can change non-owner member role');
    assert.equal(adminPatch.data.role, 'viewer');

    const adminPromoteOwner = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/members/${member.userId}`, admin.token, {
      role: 'owner',
    });
    assert.equal(adminPromoteOwner.status, 422, 'admin cannot promote anyone to owner');

    const ownerNoopOwnerPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/members/${owner.userId}`, owner.token, {
      role: 'owner',
    });
    assert.equal(ownerNoopOwnerPatch.status, 422, 'PATCH role=owner is out of scope even for owner rows');

    const memberPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/members/${viewer.userId}`, member.token, {
      role: 'member',
    });
    assert.equal(memberPatch.status, 403, 'member cannot manage roles');

    const viewerDelete = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/members/${member.userId}`, viewer.token);
    assert.equal(viewerDelete.status, 403, 'viewer cannot remove members');

    const adminDeleteSoleOwner = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/members/${owner.userId}`, admin.token);
    assert.equal(adminDeleteSoleOwner.status, 422, 'admin cannot remove the sole owner');

    const deleteRemovable = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/members/${removable.userId}`, owner.token);
    assert.equal(deleteRemovable.status, 204, 'owner can remove non-owner member');

    const members = await api(baseUrl, 'GET', `/v1/projects/${projectId}/members`, owner.token);
    assert.equal(members.status, 200);
    assert.ok(!members.data.data.some((row: any) => row.user_id === removable.userId), 'removed member should not be listed');
    assert.ok(members.data.data.some((row: any) => row.user_id === owner.userId && row.role === 'owner'), 'owner should remain listed');

    console.log('project-members tests passed');
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

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectMembersTest123!',
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
