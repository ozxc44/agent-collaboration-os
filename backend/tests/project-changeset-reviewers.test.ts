import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-changeset-reviewers-test-secret';

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
    const owner = await register(baseUrl, 'reviewer-owner');
    const admin = await register(baseUrl, 'reviewer-admin');
    const member = await register(baseUrl, 'reviewer-member');
    const viewer = await register(baseUrl, 'reviewer-viewer');
    const outsider = await register(baseUrl, 'reviewer-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Changeset Reviewer Test',
      description: 'Project for changeset reviewer assignment tests',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: admin.userId,
      role: 'admin',
    });
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: member.userId,
      role: 'member',
    });
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });

    const ownerChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, owner.token, {
      title: 'Owner changeset',
      file_ops: [{ op: 'upsert', path: 'reviewer-test.md', content: 'owner changeset' }],
    });
    assert.equal(ownerChangeset.status, 201);

    const memberChangeset = await api(baseUrl, 'POST', `/v1/projects/${projectId}/changesets`, member.token, {
      title: 'Member changeset',
      file_ops: [{ op: 'upsert', path: 'member-changeset.md', content: 'member changeset' }],
    });
    assert.equal(memberChangeset.status, 201);

    const ownerAssign = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewers: [admin.userId, member.userId] },
    );
    assert.equal(ownerAssign.status, 200);
    assert.equal(ownerAssign.data.requested_reviewers?.length, 2);
    assert.deepEqual(
      ownerAssign.data.requested_reviewer_summary?.reviewer_ids?.sort(),
      [admin.userId, member.userId].sort(),
    );
    assert.equal(ownerAssign.data.requested_reviewer_summary?.requested_count, 2);

    const detail = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}`,
      owner.token,
    );
    assert.equal(detail.status, 200);
    assert.deepEqual(
      detail.data.requested_reviewers?.map((r: any) => r.reviewer_id).sort(),
      [admin.userId, member.userId].sort(),
    );
    assert.equal(detail.data.requested_reviewer_summary?.requested_count, 2);

    const list = await api(baseUrl, 'GET', `/v1/projects/${projectId}/changesets`, owner.token);
    assert.equal(list.status, 200);
    const listed = list.data.data.find((c: any) => c.id === ownerChangeset.data.id);
    assert.ok(listed);
    assert.equal(listed.requested_reviewers?.length, 2);
    assert.equal(listed.requested_reviewer_summary?.requested_count, 2);

    const viewerAssign = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}/requested-reviewers`,
      viewer.token,
      { requested_reviewers: [admin.userId] },
    );
    assert.equal(viewerAssign.status, 403);

    const outsiderAssign = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}/requested-reviewers`,
      outsider.token,
      { requested_reviewers: [admin.userId] },
    );
    assert.equal(outsiderAssign.status, 403);

    const nonMemberAssign = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewers: [outsider.userId] },
    );
    assert.equal(nonMemberAssign.status, 422);
    assert.deepEqual(nonMemberAssign.data.missing_reviewer_ids, [outsider.userId]);

    const duplicateAssign = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewers: [admin.userId, admin.userId] },
    );
    assert.equal(duplicateAssign.status, 422);

    const adminAssign = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${memberChangeset.data.id}/requested-reviewers`,
      admin.token,
      { requested_reviewers: [owner.userId, viewer.userId] },
    );
    assert.equal(adminAssign.status, 200);
    assert.equal(adminAssign.data.requested_reviewers?.length, 2);

    const memberAssignOwn = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${memberChangeset.data.id}/requested-reviewers`,
      member.token,
      { requested_reviewers: [admin.userId] },
    );
    assert.equal(memberAssignOwn.status, 200);

    const memberAssignOther = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}/requested-reviewers`,
      member.token,
      { requested_reviewers: [admin.userId] },
    );
    assert.equal(memberAssignOther.status, 403);

    const aliasAssign = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewer_ids: [admin.userId] },
    );
    assert.equal(aliasAssign.status, 200);
    assert.equal(aliasAssign.data.requested_reviewers?.length, 1);

    const clearAssign = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/changesets/${ownerChangeset.data.id}/requested-reviewers`,
      owner.token,
      { requested_reviewers: [] },
    );
    assert.equal(clearAssign.status, 200);
    assert.equal(clearAssign.data.requested_reviewers?.length, 0);
    assert.equal(clearAssign.data.requested_reviewer_summary?.requested_count, 0);

    const audit = await api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events?limit=100`, owner.token);
    assert.equal(audit.status, 200);
    const reviewerAuditEvents = audit.data.data.filter(
      (event: any) => event.action === 'changeset_reviewers_requested',
    );
    assert.ok(reviewerAuditEvents.length >= 2, 'audit events should be written for reviewer assignment changes');
    assert.ok(
      reviewerAuditEvents.some((event: any) =>
        Array.isArray(event.metadata?.requested_reviewer_ids) &&
        event.metadata.requested_reviewer_ids.includes(admin.userId) &&
        event.metadata.requested_reviewer_ids.includes(member.userId),
      ),
      'audit should record the requested reviewer ids',
    );
    assert.ok(
      reviewerAuditEvents.some((event: any) =>
        Array.isArray(event.metadata?.requested_reviewer_ids) &&
        event.metadata.requested_reviewer_ids.length === 0,
      ),
      'audit should record clearing reviewers',
    );

    console.log('project-changeset-reviewers tests passed');
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
    password: 'ProjectChangesetReviewersTest123!',
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
