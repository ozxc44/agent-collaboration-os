import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-packages-test-secret';

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
    const owner = await register(baseUrl, 'package-owner');
    const admin = await register(baseUrl, 'package-admin');
    const member = await register(baseUrl, 'package-member');
    const viewer = await register(baseUrl, 'package-viewer');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Package Test Project',
      description: 'Testing project package metadata',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: admin.userId, role: 'admin' })).status, 201);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: member.userId, role: 'member' })).status, 201);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: viewer.userId, role: 'viewer' })).status, 201);

    console.log('Test 1: Owner can create package metadata');
    const create = await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, owner.token, {
      name: ' Demo Package ',
      package_type: 'generic',
      version: ' V1.0.0 ',
      description: 'Package metadata record',
      repository_url: 'https://example.com/demo-package',
      metadata: { checksum: 'sha256:abc', size: 42 },
      project_id: 'ignored',
      created_by: member.userId,
    });
    assert.equal(create.status, 201);
    assert.equal(create.data.name, 'demo-package');
    assert.equal(create.data.version, 'v1.0.0');
    assert.equal(create.data.package_type, 'generic');
    assert.equal(create.data.description, 'Package metadata record');
    assert.equal(create.data.repository_url, 'https://example.com/demo-package');
    assert.deepEqual(create.data.metadata, { checksum: 'sha256:abc', size: 42 });
    assert.equal(create.data.project_id, projectId);
    assert.equal(create.data.created_by, owner.userId);
    const packageId = create.data.id;

    console.log('Test 2: Admin can create another package version');
    const adminCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, admin.token, {
      name: 'demo package',
      package_type: 'npm',
      version: '1.1.0',
      description: 'Admin-created version',
    });
    assert.equal(adminCreate.status, 201);
    assert.equal(adminCreate.data.name, 'demo-package');
    assert.equal(adminCreate.data.version, '1.1.0');

    console.log('Test 3: Member/viewer cannot create');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, member.token, { name: 'member-pkg', version: '1.0.0' })).status, 403);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, viewer.token, { name: 'viewer-pkg', version: '1.0.0' })).status, 403);

    console.log('Test 4: Duplicate normalized name/version returns 409');
    const duplicate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, owner.token, {
      name: 'DEMO PACKAGE!!!',
      version: 'v1.0.0',
      description: 'Duplicate package',
    });
    assert.equal(duplicate.status, 409);

    console.log('Test 5: Invalid package type and metadata return 422');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, owner.token, { name: 'bad', package_type: 'jar', version: '1.0.0' })).status, 422);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, owner.token, { name: 'bad-meta', version: '1.0.0', metadata: ['no'] })).status, 422);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, owner.token, { name: 'bad-url', version: '1.0.0', repository_url: 'ftp://example.com/pkg' })).status, 422);

    console.log('Test 6: Owner/member/viewer can list and summary omits metadata');
    for (const user of [owner, member, viewer]) {
      const list = await api(baseUrl, 'GET', `/v1/projects/${projectId}/packages`, user.token);
      assert.equal(list.status, 200);
      assert.equal(list.data.meta.total, 2);
      assert.equal(list.data.data.length, 2);
      assert.equal(list.data.data[0].metadata, undefined);
      assert.equal(list.data.data[0].description, undefined);
    }

    console.log('Test 7: Owner/member/viewer can read full package');
    for (const user of [owner, member, viewer]) {
      const read = await api(baseUrl, 'GET', `/v1/projects/${projectId}/packages/${packageId}`, user.token);
      assert.equal(read.status, 200);
      assert.equal(read.data.id, packageId);
      assert.equal(read.data.description, 'Package metadata record');
      assert.deepEqual(read.data.metadata, { checksum: 'sha256:abc', size: 42 });
    }

    console.log('Test 8: Missing package returns 404');
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/packages/00000000-0000-4000-8000-000000000000`, owner.token)).status, 404);

    console.log('Test 9: Owner/admin can update; member/viewer cannot update');
    const update = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/packages/${packageId}`, owner.token, {
      description: 'Updated package metadata',
      repository_url: 'https://example.com/demo-package-updated',
      metadata: { checksum: 'sha256:def' },
    });
    assert.equal(update.status, 200);
    assert.equal(update.data.description, 'Updated package metadata');
    assert.equal(update.data.repository_url, 'https://example.com/demo-package-updated');
    assert.deepEqual(update.data.metadata, { checksum: 'sha256:def' });
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/packages/${packageId}`, admin.token, { package_type: 'python' })).status, 200);
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/packages/${packageId}`, member.token, { description: 'No' })).status, 403);
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/packages/${packageId}`, viewer.token, { description: 'No' })).status, 403);

    console.log('Test 10: Bounds and mass-assignment guard');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, owner.token, { name: 'x'.repeat(256), version: '1.0.0' })).status, 422);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/packages`, owner.token, { name: 'oversized', version: '1.0.0', description: 'x'.repeat(200_001) })).status, 422);
    const before = await api(baseUrl, 'GET', `/v1/projects/${projectId}/packages/${packageId}`, owner.token);
    const mass = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/packages/${packageId}`, owner.token, {
      description: 'Mass assignment guard',
      project_id: 'pwned',
      created_by: viewer.userId,
      updated_by: viewer.userId,
      id: '00000000-0000-4000-8000-000000000001',
    });
    assert.equal(mass.status, 200);
    assert.equal(mass.data.id, packageId);
    assert.equal(mass.data.project_id, projectId);
    assert.equal(mass.data.created_by, before.data.created_by);

    console.log('All project packages tests passed');
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
    password: 'PackageTestPassword123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
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
