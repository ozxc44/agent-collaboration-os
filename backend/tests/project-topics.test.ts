import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-topics-test-secret';

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
    const owner = await register(baseUrl, 'owner');
    const viewer = await register(baseUrl, 'viewer');
    const outsider = await register(baseUrl, 'outsider');

    // Create a project with the owner.
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Topics Test Project',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Add viewer as a viewer member.
    const addViewer = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/members`,
      owner.token,
      { user_id: viewer.userId, role: 'viewer' },
    );
    assert.equal(addViewer.status, 201);

    // ─── Topics in create ─────────────────────────────────────────────────────

    const withTopics = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Created With Topics',
      topics: ['typescript', 'node', 'API'],
    });
    assert.equal(withTopics.status, 201);
    assert.deepEqual(withTopics.data.topics, ['typescript', 'node', 'API']);

    // ─── Topics in project read ───────────────────────────────────────────────

    // Default project starts with empty topics.
    const readEmpty = await api(baseUrl, 'GET', `/v1/projects/${projectId}`, owner.token);
    assert.equal(readEmpty.status, 200);
    assert.deepEqual(readEmpty.data.topics, []);

    // ─── PATCH: set topics ────────────────────────────────────────────────────

    const setTopics = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['typescript', 'testing', 'backend'],
    });
    assert.equal(setTopics.status, 200);
    assert.deepEqual(setTopics.data.topics, ['typescript', 'testing', 'backend']);

    // Verify persisted.
    const readAfterSet = await api(baseUrl, 'GET', `/v1/projects/${projectId}`, owner.token);
    assert.deepEqual(readAfterSet.data.topics, ['typescript', 'testing', 'backend']);

    // ─── PATCH: replace topics ────────────────────────────────────────────────

    const replaceTopics = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['python', 'fastapi'],
    });
    assert.equal(replaceTopics.status, 200);
    assert.deepEqual(replaceTopics.data.topics, ['python', 'fastapi']);

    // ─── PATCH: clear topics with empty array ─────────────────────────────────

    const clearTopics = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: [],
    });
    assert.equal(clearTopics.status, 200);
    assert.deepEqual(clearTopics.data.topics, []);

    // ─── Validation: must be an array ─────────────────────────────────────────

    const notArray = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: 'typescript',
    });
    assert.equal(notArray.status, 422);
    assert.ok(notArray.data.detail.includes('array'));

    const notArrayObj = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: { tag: 'typescript' },
    });
    assert.equal(notArrayObj.status, 422);

    // ─── Validation: each topic must be a string ──────────────────────────────

    const nonString = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['valid', 42],
    });
    assert.equal(nonString.status, 422);
    assert.ok(nonString.data.detail.includes('string'));

    // ─── Validation: max 20 topics ────────────────────────────────────────────

    const tooMany = Array.from({ length: 21 }, (_, i) => `topic-${i}`);
    const overMax = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: tooMany,
    });
    assert.equal(overMax.status, 422);
    assert.ok(overMax.data.detail.includes('20'));

    // Exactly 20 should succeed.
    const exactlyMax = Array.from({ length: 20 }, (_, i) => `topic-${i}`);
    const maxOk = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: exactlyMax,
    });
    assert.equal(maxOk.status, 200);
    assert.equal(maxOk.data.topics.length, 20);

    // ─── Validation: max 50 characters per topic ──────────────────────────────

    const longTopic = 'a'.repeat(51);
    const tooLong = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['short', longTopic],
    });
    assert.equal(tooLong.status, 422);
    assert.ok(tooLong.data.detail.includes('50'));

    // Exactly 50 should succeed.
    const exactLen = 'b'.repeat(50);
    const lenOk = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: [exactLen],
    });
    assert.equal(lenOk.status, 200);
    assert.deepEqual(lenOk.data.topics, [exactLen]);

    // ─── Validation: empty topics rejected ────────────────────────────────────

    const emptyEntry = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['valid', '', 'also-valid'],
    });
    // Empty strings are silently dropped; remaining topics should pass.
    assert.equal(emptyEntry.status, 200);
    assert.deepEqual(emptyEntry.data.topics, ['valid', 'also-valid']);

    // Only empty strings → empty result.
    const allEmpty = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['  ', ''],
    });
    assert.equal(allEmpty.status, 200);
    assert.deepEqual(allEmpty.data.topics, []);

    // ─── Validation: whitespace trimming ──────────────────────────────────────

    const whitespace = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['  typescript  ', ' node '],
    });
    assert.equal(whitespace.status, 200);
    assert.deepEqual(whitespace.data.topics, ['typescript', 'node']);

    // ─── Validation: duplicate collapse (case-insensitive) ────────────────────

    const duplicates = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['TypeScript', 'typescript', 'TYPESCRIPT', 'node'],
    });
    assert.equal(duplicates.status, 200);
    assert.deepEqual(duplicates.data.topics, ['TypeScript', 'node']);

    // ─── Validation: control characters rejected ──────────────────────────────

    const controlChar = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['valid', 'bad\x00topic'],
    });
    assert.equal(controlChar.status, 422);
    assert.ok(controlChar.data.detail.includes('control'));

    // ─── RBAC: viewer cannot mutate ───────────────────────────────────────────

    const viewerMutate = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, viewer.token, {
      topics: ['hacked'],
    });
    assert.equal(viewerMutate.status, 403);

    // ─── RBAC: outsider cannot mutate ─────────────────────────────────────────

    const outsiderMutate = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, outsider.token, {
      topics: ['hacked'],
    });
    assert.equal(outsiderMutate.status, 403);

    // ─── RBAC: anonymous cannot mutate ────────────────────────────────────────

    const anonMutate = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, undefined, {
      topics: ['hacked'],
    });
    assert.equal(anonMutate.status, 401);

    // ─── RBAC: viewer can read topics ─────────────────────────────────────────

    // Set topics as owner first.
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      topics: ['readable', 'public'],
    });

    const viewerRead = await api(baseUrl, 'GET', `/v1/projects/${projectId}`, viewer.token);
    assert.equal(viewerRead.status, 200);
    assert.deepEqual(viewerRead.data.topics, ['readable', 'public']);

    // ─── Topics in summary ────────────────────────────────────────────────────

    const summary = await api(baseUrl, 'GET', `/v1/projects/${projectId}/summary`, owner.token);
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.data.topics, ['readable', 'public']);

    // Viewer can read summary topics.
    const viewerSummary = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/summary`,
      viewer.token,
    );
    assert.equal(viewerSummary.status, 200);
    assert.deepEqual(viewerSummary.data.topics, ['readable', 'public']);

    // ─── Topics in overview ───────────────────────────────────────────────────

    const overview = await api(baseUrl, 'GET', `/v1/projects/${projectId}/overview`, owner.token);
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.data.project.topics, ['readable', 'public']);

    // ─── Topics in project list ───────────────────────────────────────────────

    const list = await api(baseUrl, 'GET', '/v1/projects', owner.token);
    assert.equal(list.status, 200);
    const listed = list.data.data.find((p: any) => p.id === projectId);
    assert.ok(listed, 'project should appear in list');
    assert.deepEqual(listed.topics, ['readable', 'public']);

    // ─── Create with invalid topics rejected ──────────────────────────────────

    const badCreate = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Bad Topics Create',
      topics: 'not-an-array',
    });
    assert.equal(badCreate.status, 422);

    // ─── No-auth cannot read project ──────────────────────────────────────────

    const noAuth = await api(baseUrl, 'GET', `/v1/projects/${projectId}`);
    assert.equal(noAuth.status, 401);

    // ─── Dedicated topics endpoints ───────────────────────────────────────────

    // Set topics via dedicated PUT and read back via dedicated GET.
    const putTopics = await api(baseUrl, 'PUT', `/v1/projects/${projectId}/topics`, owner.token, {
      topics: ['dedicated', 'endpoint'],
    });
    assert.equal(putTopics.status, 200);
    assert.deepEqual(putTopics.data.topics, ['dedicated', 'endpoint']);

    const getTopics = await api(baseUrl, 'GET', `/v1/projects/${projectId}/topics`, owner.token);
    assert.equal(getTopics.status, 200);
    assert.deepEqual(getTopics.data.topics, ['dedicated', 'endpoint']);

    // PUT clear topics.
    const clearDedicated = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      owner.token,
      { topics: [] },
    );
    assert.equal(clearDedicated.status, 200);
    assert.deepEqual(clearDedicated.data.topics, []);

    // ─── Dedicated endpoints: validation reuse ────────────────────────────────

    const putNotArray = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      owner.token,
      { topics: 'typescript' },
    );
    assert.equal(putNotArray.status, 422);
    assert.ok(putNotArray.data.detail.includes('array'));

    const putTooMany = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      owner.token,
      { topics: Array.from({ length: 21 }, (_, i) => `t-${i}`) },
    );
    assert.equal(putTooMany.status, 422);
    assert.ok(putTooMany.data.detail.includes('20'));

    const putTooLong = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      owner.token,
      { topics: ['a'.repeat(51)] },
    );
    assert.equal(putTooLong.status, 422);
    assert.ok(putTooLong.data.detail.includes('50'));

    const putControl = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      owner.token,
      { topics: ['ok', 'bad\x00topic'] },
    );
    assert.equal(putControl.status, 422);
    assert.ok(putControl.data.detail.includes('control'));

    const putDups = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      owner.token,
      { topics: ['Go', 'go', 'GO'] },
    );
    assert.equal(putDups.status, 200);
    assert.deepEqual(putDups.data.topics, ['Go']);

    // ─── Dedicated endpoints: RBAC ────────────────────────────────────────────

    // Viewer can read topics via dedicated GET.
    await api(baseUrl, 'PUT', `/v1/projects/${projectId}/topics`, owner.token, {
      topics: ['rbac', 'test'],
    });
    const viewerGet = await api(baseUrl, 'GET', `/v1/projects/${projectId}/topics`, viewer.token);
    assert.equal(viewerGet.status, 200);
    assert.deepEqual(viewerGet.data.topics, ['rbac', 'test']);

    // Viewer cannot edit via dedicated PUT.
    const viewerPut = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      viewer.token,
      { topics: ['hacked'] },
    );
    assert.equal(viewerPut.status, 403);

    // Outsider cannot read or edit.
    const outsiderGet = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/topics`,
      outsider.token,
    );
    assert.equal(outsiderGet.status, 403);
    const outsiderPut = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      outsider.token,
      { topics: ['hacked'] },
    );
    assert.equal(outsiderPut.status, 403);

    // Unauthenticated cannot read or edit.
    const anonGet = await api(baseUrl, 'GET', `/v1/projects/${projectId}/topics`);
    assert.equal(anonGet.status, 401);
    const anonPut = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${projectId}/topics`,
      undefined,
      { topics: ['hacked'] },
    );
    assert.equal(anonPut.status, 401);

    // Private project: outsider and unauthenticated are denied.
    const privateProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Private Topics Project',
      visibility: 'private',
      topics: ['secret'],
    });
    assert.equal(privateProject.status, 201);
    const privateProjectId = privateProject.data.id;

    const privateOutsiderGet = await api(
      baseUrl,
      'GET',
      `/v1/projects/${privateProjectId}/topics`,
      outsider.token,
    );
    assert.equal(privateOutsiderGet.status, 403);
    const privateOutsiderPut = await api(
      baseUrl,
      'PUT',
      `/v1/projects/${privateProjectId}/topics`,
      outsider.token,
      { topics: ['leaked'] },
    );
    assert.equal(privateOutsiderPut.status, 403);
    const privateAnonGet = await api(
      baseUrl,
      'GET',
      `/v1/projects/${privateProjectId}/topics`,
    );
    assert.equal(privateAnonGet.status, 401);

    // ─── Topic search across member-visible projects ──────────────────────────

    // Owner can search topics from both projects (public and private).
    const searchAll = await api(
      baseUrl,
      'GET',
      `/v1/projects/topics/search?limit=100`,
      owner.token,
    );
    assert.equal(searchAll.status, 200);
    assert.ok(Array.isArray(searchAll.data.data));
    assert.ok(searchAll.data.data.includes('rbac'));
    assert.ok(searchAll.data.data.includes('secret'));

    // Filtered search.
    const searchQ = await api(
      baseUrl,
      'GET',
      `/v1/projects/topics/search?q=sec`,
      owner.token,
    );
    assert.equal(searchQ.status, 200);
    assert.ok(searchQ.data.data.includes('secret'));
    assert.ok(!searchQ.data.data.includes('rbac'));
    assert.equal(searchQ.data.meta.offset, 0);
    assert.ok(Number.isFinite(searchQ.data.meta.total));

    // Outsider search excludes private project topics and public project they cannot access.
    const outsiderSearch = await api(
      baseUrl,
      'GET',
      `/v1/projects/topics/search`,
      outsider.token,
    );
    assert.equal(outsiderSearch.status, 200);
    assert.ok(!outsiderSearch.data.data.includes('secret'));
    assert.ok(!outsiderSearch.data.data.includes('rbac'));

    console.log('project-topics tests passed');
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
    password: 'ProjectTopicsTest123!',
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
