import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-wiki-test-secret';

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
    // Setup: create owner, admin, member, viewer users
    const owner = await register(baseUrl, 'wiki-owner');
    const admin = await register(baseUrl, 'wiki-admin');
    const member = await register(baseUrl, 'wiki-member');
    const viewer = await register(baseUrl, 'wiki-viewer');

    // Owner creates a project
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Wiki Test Project',
      description: 'Testing wiki backend',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Add admin, member, viewer to the project
    const adminMember = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/members`,
      owner.token,
      { user_id: admin.userId, role: 'admin' },
    );
    assert.equal(adminMember.status, 201);

    const memberMember = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/members`,
      owner.token,
      { user_id: member.userId, role: 'member' },
    );
    assert.equal(memberMember.status, 201);

    const viewerMember = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/members`,
      owner.token,
      { user_id: viewer.userId, role: 'viewer' },
    );
    assert.equal(viewerMember.status, 201);

    // Test 1: Owner can create a wiki page
    console.log('Test 1: Owner can create a wiki page');
    const createRes = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      owner.token,
      { title: 'Getting Started', content: '# Getting Started\n\nWelcome to the wiki!', slug: 'getting-started' },
    );
    assert.equal(createRes.status, 201, 'Owner should be able to create wiki page');
    assert.equal(createRes.data.slug, 'getting-started');
    assert.equal(createRes.data.title, 'Getting Started');
    assert.equal(createRes.data.content, '# Getting Started\n\nWelcome to the wiki!');
    assert.equal(createRes.data.revision, 1);
    assert.equal(createRes.data.project_id, projectId);
    assert.ok(createRes.data.id, 'Should have an id');
    assert.ok(createRes.data.created_at, 'Should have created_at');
    assert.ok(createRes.data.updated_at, 'Should have updated_at');

    // Test 2: Admin can create a wiki page
    console.log('Test 2: Admin can create a wiki page');
    const adminCreate = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      admin.token,
      { title: 'Architecture', content: '# Architecture\n\nSystem design overview.' },
    );
    assert.equal(adminCreate.status, 201, 'Admin should be able to create wiki page');
    assert.equal(adminCreate.data.slug, 'architecture');

    // Test 3: Member cannot create a wiki page (403)
    console.log('Test 3: Member cannot create a wiki page');
    const memberCreate = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      member.token,
      { title: 'Forbidden', content: 'Should not be created' },
    );
    assert.equal(memberCreate.status, 403, 'Member should get 403 on create');

    // Test 4: Viewer cannot create a wiki page (403)
    console.log('Test 4: Viewer cannot create a wiki page');
    const viewerCreate = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      viewer.token,
      { title: 'Forbidden', content: 'Should not be created' },
    );
    assert.equal(viewerCreate.status, 403, 'Viewer should get 403 on create');

    // Test 5: Duplicate slug returns 409
    console.log('Test 5: Duplicate slug returns 409');
    const dupRes = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      owner.token,
      { title: 'Getting Started Again', content: 'Duplicate', slug: 'getting-started' },
    );
    assert.equal(dupRes.status, 409, 'Duplicate slug should return 409');

    // Test 6: Owner can list wiki pages
    console.log('Test 6: Owner can list wiki pages');
    const listRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/wiki`, owner.token);
    assert.equal(listRes.status, 200, 'Owner should be able to list wiki pages');
    assert.ok(Array.isArray(listRes.data.data), 'Should return data array');
    assert.equal(listRes.data.data.length, 2, 'Should have 2 pages');
    assert.equal(listRes.data.meta.total, 2, 'Total should be 2');
    assert.equal(listRes.data.data[0].content, undefined, 'List should not include content');

    // Test 7: Member can list wiki pages
    console.log('Test 7: Member can list wiki pages');
    const memberList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/wiki`, member.token);
    assert.equal(memberList.status, 200, 'Member should be able to list wiki pages');
    assert.equal(memberList.data.data.length, 2, 'Member should see 2 pages');

    // Test 8: Viewer can list wiki pages
    console.log('Test 8: Viewer can list wiki pages');
    const viewerList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/wiki`, viewer.token);
    assert.equal(viewerList.status, 200, 'Viewer should be able to list wiki pages');
    assert.equal(viewerList.data.data.length, 2, 'Viewer should see 2 pages');

    // Test 9: Owner can read a wiki page by slug
    console.log('Test 9: Owner can read a wiki page by slug');
    const getRes = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/wiki/getting-started`,
      owner.token,
    );
    assert.equal(getRes.status, 200, 'Owner should be able to get wiki page');
    assert.equal(getRes.data.slug, 'getting-started');
    assert.equal(getRes.data.title, 'Getting Started');
    assert.equal(getRes.data.content, '# Getting Started\n\nWelcome to the wiki!');
    assert.equal(getRes.data.revision, 1);

    // Test 10: Member can read a wiki page
    console.log('Test 10: Member can read a wiki page');
    const memberGet = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/wiki/getting-started`,
      member.token,
    );
    assert.equal(memberGet.status, 200, 'Member should be able to read wiki page');
    assert.equal(memberGet.data.slug, 'getting-started');

    // Test 11: Viewer can read a wiki page
    console.log('Test 11: Viewer can read a wiki page');
    const viewerGet = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/wiki/getting-started`,
      viewer.token,
    );
    assert.equal(viewerGet.status, 200, 'Viewer should be able to read wiki page');
    assert.equal(viewerGet.data.slug, 'getting-started');

    // Test 12: Missing page returns 404
    console.log('Test 12: Missing page returns 404');
    const missingRes = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/wiki/nonexistent-page`,
      owner.token,
    );
    assert.equal(missingRes.status, 404, 'Missing page should return 404');

    // Test 13: Owner can update a wiki page
    console.log('Test 13: Owner can update a wiki page');
    const updateRes = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/wiki/getting-started`,
      owner.token,
      { title: 'Getting Started (Updated)', content: '# Getting Started\n\nUpdated content.' },
    );
    assert.equal(updateRes.status, 200, 'Owner should be able to update wiki page');
    assert.equal(updateRes.data.title, 'Getting Started (Updated)');
    assert.equal(updateRes.data.content, '# Getting Started\n\nUpdated content.');
    assert.equal(updateRes.data.revision, 2, 'Revision should increment to 2');

    // Test 14: Admin can update a wiki page
    console.log('Test 14: Admin can update a wiki page');
    const adminUpdate = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/wiki/architecture`,
      admin.token,
      { content: '# Architecture\n\nUpdated by admin.' },
    );
    assert.equal(adminUpdate.status, 200, 'Admin should be able to update wiki page');
    assert.equal(adminUpdate.data.content, '# Architecture\n\nUpdated by admin.');
    assert.equal(adminUpdate.data.revision, 2, 'Revision should increment');

    // Test 15: Member cannot update a wiki page (403)
    console.log('Test 15: Member cannot update a wiki page');
    const memberUpdate = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/wiki/getting-started`,
      member.token,
      { title: 'Hacked' },
    );
    assert.equal(memberUpdate.status, 403, 'Member should get 403 on update');

    // Test 16: Viewer cannot update a wiki page (403)
    console.log('Test 16: Viewer cannot update a wiki page');
    const viewerUpdate = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/wiki/getting-started`,
      viewer.token,
      { title: 'Hacked' },
    );
    assert.equal(viewerUpdate.status, 403, 'Viewer should get 403 on update');

    // Test 17: PATCH on missing page returns 404
    console.log('Test 17: PATCH on missing page returns 404');
    const patchMissing = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/wiki/nonexistent`,
      owner.token,
      { title: 'Nope' },
    );
    assert.equal(patchMissing.status, 404, 'PATCH on missing page should return 404');

    // Test 18: Slug normalization is deterministic and URL-safe
    console.log('Test 18: Slug normalization is deterministic and URL-safe');
    const normRes = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      owner.token,
      { title: 'My Page Title!', content: 'Content here' },
    );
    assert.equal(normRes.status, 201, 'Should create page with auto-derived slug');
    assert.equal(normRes.data.slug, 'my-page-title', 'Slug should be normalized');
    const normGet = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/wiki/my-page-title`,
      owner.token,
    );
    assert.equal(normGet.status, 200, 'Should be fetchable by normalized slug');
    assert.equal(normGet.data.slug, 'my-page-title');

    // Test 19: Normalized slug collision returns 409
    console.log('Test 19: Normalized slug collision returns 409');
    const normDupRes = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      owner.token,
      { title: 'Duplicate via normalized slug', content: 'Duplicate', slug: 'MY PAGE TITLE!!!' },
    );
    assert.equal(normDupRes.status, 409, 'Normalized duplicate slug should return 409');

    // Test 20: Content/title bounds enforced
    console.log('Test 20: Content/title bounds enforced');
    const longTitle = 'x'.repeat(501);
    const longTitleRes = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      owner.token,
      { title: longTitle, content: 'ok' },
    );
    assert.equal(longTitleRes.status, 422, 'Title over 500 chars should be rejected');

    const longContentRes = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/wiki`,
      owner.token,
      { title: 'Oversized Content', content: 'x'.repeat(1_000_001) },
    );
    assert.equal(longContentRes.status, 422, 'Content over 1,000,000 chars should be rejected');

    const longPatchContentRes = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/wiki/architecture`,
      owner.token,
      { content: 'x'.repeat(1_000_001) },
    );
    assert.equal(longPatchContentRes.status, 422, 'PATCH content over 1,000,000 chars should be rejected');

    // Test 21: Mass-assignment fields are ignored on update
    console.log('Test 21: Mass-assignment fields are ignored on update');
    const beforeMassAssign = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/wiki/architecture`,
      owner.token,
    );
    assert.equal(beforeMassAssign.status, 200);
    const massAssignRes = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/wiki/architecture`,
      owner.token,
      {
        title: 'Architecture Mass Assignment Guard',
        content: 'Only title/content should change',
        slug: 'pwned-slug',
        project_id: 'pwned-project',
        revision: 999,
        created_by: member.userId,
        created_at: '1999-01-01T00:00:00.000Z',
      },
    );
    assert.equal(massAssignRes.status, 200, 'Mass-assignment update should still allow valid title/content');
    assert.equal(massAssignRes.data.slug, 'architecture', 'PATCH must not change slug');
    assert.equal(massAssignRes.data.project_id, projectId, 'PATCH must not change project_id');
    assert.equal(massAssignRes.data.created_by, beforeMassAssign.data.created_by, 'PATCH must not change created_by');
    assert.equal(massAssignRes.data.revision, beforeMassAssign.data.revision + 1, 'Revision should increment by one only');
    const pwnedGet = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/wiki/pwned-slug`,
      owner.token,
    );
    assert.equal(pwnedGet.status, 404, 'Ignored slug field must not create a new lookup path');

    // Test 22: Revision increments across multiple updates
    console.log('Test 22: Revision increments across multiple updates');
    await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/wiki/architecture`,
      owner.token,
      { content: 'v3' },
    );
    const finalGet = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/wiki/architecture`,
      owner.token,
    );
    assert.equal(finalGet.data.revision, massAssignRes.data.revision + 1, 'Revision should increment after another update');

    console.log('All project wiki tests passed');
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
    password: 'WikiTestPassword123!',
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
