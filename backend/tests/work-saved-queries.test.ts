import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'work-saved-queries-test-secret';

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
    const owner = await register(baseUrl, 'saved-owner');
    const admin = await register(baseUrl, 'saved-admin');
    const member = await register(baseUrl, 'saved-member');
    const viewer = await register(baseUrl, 'saved-viewer');
    const outsider = await register(baseUrl, 'saved-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Saved Queries Test',
      description: 'Project for work saved query tests',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Add project members with different roles
    await addMember(baseUrl, projectId, owner.token, admin.userId, 'admin');
    await addMember(baseUrl, projectId, owner.token, member.userId, 'member');
    await addMember(baseUrl, projectId, owner.token, viewer.userId, 'viewer');

    const projectAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'Saved Query Agent',
    });
    assert.equal(projectAgent.status, 201);

    // ── Empty list for members ─────────────────────────────────────────────
    const ownerEmpty = await api(baseUrl, 'GET', `/v1/projects/${projectId}/work-saved-queries`, owner.token);
    assert.equal(ownerEmpty.status, 200);
    assert.deepEqual(ownerEmpty.data.data, []);

    const viewerEmpty = await api(baseUrl, 'GET', `/v1/projects/${projectId}/work-saved-queries`, viewer.token);
    assert.equal(viewerEmpty.status, 200);
    assert.deepEqual(viewerEmpty.data.data, []);

    // ── Create saved queries by owner/admin/member ─────────────────────────
    const ownerQuery = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'Owner query',
      description: 'Created by owner',
      query: { status: ['open'], has_artifacts: true },
    });
    assert.equal(ownerQuery.status, 201);
    assert.equal(ownerQuery.data.name, 'Owner query');
    assert.equal(ownerQuery.data.description, 'Created by owner');
    assert.equal(ownerQuery.data.scope, 'work');
    assert.deepEqual(ownerQuery.data.query, { status: ['open'], has_artifacts: true });
    assert.equal(typeof ownerQuery.data.created_by, 'string');
    assert.equal(ownerQuery.data.created_by, owner.userId);
    assert.equal(ownerQuery.data.updated_by, owner.userId);

    const adminQuery = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, admin.token, {
      name: 'Admin query',
      query: { saved_view: 'blocked', search: 'auth' },
    });
    assert.equal(adminQuery.status, 201);
    assert.equal(adminQuery.data.description, null);
    assert.deepEqual(adminQuery.data.query, { saved_view: 'blocked', search: 'auth' });

    const memberQuery = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, member.token, {
      name: 'Member query',
      query: { agent: 'agent-1', has_links: true },
    });
    assert.equal(memberQuery.status, 201);

    // ── Duplicate name rejected ────────────────────────────────────────────
    const duplicate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'Owner query',
      query: { status: ['review'] },
    });
    assert.equal(duplicate.status, 409);

    // ── List returns stored queries sorted by updated_at DESC ───────────────
    const list = await api(baseUrl, 'GET', `/v1/projects/${projectId}/work-saved-queries`, viewer.token);
    assert.equal(list.status, 200);
    assert.equal(list.data.data.length, 3);
    const names = list.data.data.map((q: any) => q.name);
    assert.ok(names.includes('Owner query'));
    assert.ok(names.includes('Admin query'));
    assert.ok(names.includes('Member query'));

    // ── Viewer cannot mutate ───────────────────────────────────────────────
    const viewerCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, viewer.token, {
      name: 'Viewer query',
      query: { status: ['open'] },
    });
    assert.equal(viewerCreate.status, 403);

    const viewerUpdate = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/work-saved-queries/${ownerQuery.data.id}`, viewer.token, {
      name: 'Viewer renamed',
    });
    assert.equal(viewerUpdate.status, 403);

    const viewerDelete = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/work-saved-queries/${ownerQuery.data.id}`, viewer.token);
    assert.equal(viewerDelete.status, 403);

    // ── Outsider denied all operations ─────────────────────────────────────
    const outsiderList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/work-saved-queries`, outsider.token);
    assert.equal(outsiderList.status, 403);

    const outsiderCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, outsider.token, {
      name: 'Outsider query',
      query: { status: ['open'] },
    });
    assert.equal(outsiderCreate.status, 403);

    // ── Anonymous denied ───────────────────────────────────────────────────
    const anonymousList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/work-saved-queries`);
    assert.equal(anonymousList.status, 401);

    // ── Agent API keys are explicitly denied ───────────────────────────────
    const agentList = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/work-saved-queries`, projectAgent.data.api_key);
    assert.equal(agentList.status, 403);

    const agentCreate = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, projectAgent.data.api_key, {
      name: 'Agent query',
      query: { status: ['open'] },
    });
    assert.equal(agentCreate.status, 403);

    // ── Update by member ───────────────────────────────────────────────────
    const update = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/work-saved-queries/${memberQuery.data.id}`, member.token, {
      description: 'Updated by member',
      query: { status: ['blocked', 'failed'], has_blockers: true },
    });
    assert.equal(update.status, 200);
    assert.equal(update.data.description, 'Updated by member');
    assert.deepEqual(update.data.query, { status: ['blocked', 'failed'], has_blockers: true });
    assert.equal(update.data.updated_by, member.userId);

    // ── Rename with duplicate check ────────────────────────────────────────
    const renameConflict = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/work-saved-queries/${adminQuery.data.id}`, owner.token, {
      name: 'Owner query',
    });
    assert.equal(renameConflict.status, 409);

    const renameOk = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/work-saved-queries/${adminQuery.data.id}`, owner.token, {
      name: 'Admin query renamed',
    });
    assert.equal(renameOk.status, 200);
    assert.equal(renameOk.data.name, 'Admin query renamed');

    // ── Delete by owner ────────────────────────────────────────────────────
    const deleteRes = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/work-saved-queries/${ownerQuery.data.id}`, owner.token);
    assert.equal(deleteRes.status, 204);

    const afterDelete = await api(baseUrl, 'GET', `/v1/projects/${projectId}/work-saved-queries`, owner.token);
    assert.equal(afterDelete.status, 200);
    assert.equal(afterDelete.data.data.length, 2);
    assert.ok(!afterDelete.data.data.some((q: any) => q.id === ownerQuery.data.id));

    // ── Validation rejects unsupported query fields ────────────────────────
    const unsupportedField = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'Bad field',
      query: { milestone: 'v1' },
    });
    assert.equal(unsupportedField.status, 422);

    const unsupportedSavedView = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'Bad view',
      query: { saved_view: 'github_issues' },
    });
    assert.equal(unsupportedSavedView.status, 422);

    const invalidStatus = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'Bad status',
      query: { status: ['merged'] },
    });
    assert.equal(invalidStatus.status, 422);

    const emptyQuery = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'Empty query',
      query: {},
    });
    assert.equal(emptyQuery.status, 422);

    const nonObjectQuery = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'Non object',
      query: 'status=open',
    });
    assert.equal(nonObjectQuery.status, 422);

    // ── Name/description validation ────────────────────────────────────────
    const missingName = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      query: { status: ['open'] },
    });
    assert.equal(missingName.status, 422);

    const emptyName = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: '   ',
      query: { status: ['open'] },
    });
    assert.equal(emptyName.status, 422);

    const longName = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'x'.repeat(129),
      query: { status: ['open'] },
    });
    assert.equal(longName.status, 422);

    const invalidDescription = await api(baseUrl, 'POST', `/v1/projects/${projectId}/work-saved-queries`, owner.token, {
      name: 'Bad desc',
      description: 123,
      query: { status: ['open'] },
    });
    assert.equal(invalidDescription.status, 422);

    // ── Not found handling ─────────────────────────────────────────────────
    const notFound = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/work-saved-queries/00000000-0000-0000-0000-000000000000`, owner.token, {
      name: 'Nope',
    });
    assert.equal(notFound.status, 404);

    const deleteNotFound = await api(baseUrl, 'DELETE', `/v1/projects/${projectId}/work-saved-queries/00000000-0000-0000-0000-000000000000`, owner.token);
    assert.equal(deleteNotFound.status, 404);

    console.log('work-saved-queries tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string; email: string }> {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`;
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email,
    password: 'SavedQuery123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return {
    token: response.data.access_token,
    userId: response.data.user.id,
    email,
  };
}

async function addMember(
  baseUrl: string,
  projectId: string,
  token: string,
  userId: string,
  role: string,
): Promise<void> {
  const response = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, token, {
    user_id: userId,
    role,
  });
  assert.equal(response.status, 201);
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

async function apiWithKey(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
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
