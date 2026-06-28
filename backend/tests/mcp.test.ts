import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'mcp-test-secret';

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
    // ─── Setup ──────────────────────────────────────────────────────────────
    const owner = await register(baseUrl, 'mcp-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'MCP Test Project',
      description: 'Testing MCP capability routes',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Create an agent to use as agent_id in capability registration
    const agent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'MCP Test Agent',
    });
    assert.equal(agent.status, 201);
    const agentId = agent.data.id;

    // Create a member (has ViewProject but NOT EditProject)
    const member = await register(baseUrl, 'mcp-member');
    const memberRes = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/members`,
      owner.token,
      { user_id: member.userId, role: 'member' },
    );
    assert.equal(memberRes.status, 201);

    // Create an admin user (has EditProject via admin role)
    const admin = await register(baseUrl, 'mcp-admin');
    const adminRes = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/members`,
      owner.token,
      { user_id: admin.userId, role: 'admin' },
    );
    assert.equal(adminRes.status, 201);

    // Create a second project for cross-project delete test
    const otherOwner = await register(baseUrl, 'mcp-other-owner');
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', otherOwner.token, {
      name: 'Other Project',
      description: 'Cross-project isolation test',
    });
    assert.equal(otherProject.status, 201);
    const otherProjectId = otherProject.data.id;

    // ─── Test 1: Unauthenticated request is denied ──────────────────────────
    console.log('Test 1: Unauthenticated request is denied');
    const unauthRes = await fetch(`${baseUrl}/v1/projects/${projectId}/mcp/capabilities`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(unauthRes.status, 401, 'Unauthenticated GET should return 401');

    const unauthPost = await fetch(`${baseUrl}/v1/projects/${projectId}/mcp/capabilities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, name: 'test' }),
    });
    assert.equal(unauthPost.status, 401, 'Unauthenticated POST should return 401');

    const unauthDelete = await fetch(
      `${baseUrl}/v1/projects/${projectId}/mcp/capabilities/nonexistent`,
      { method: 'DELETE', headers: { 'Content-Type': 'application/json' } },
    );
    assert.equal(unauthDelete.status, 401, 'Unauthenticated DELETE should return 401');

    // ─── Test 2: Owner can register an MCP capability ───────────────────────
    console.log('Test 2: Owner with EditProject can register an MCP capability');
    const registerRes = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
      { agent_id: agentId, name: 'test-capability', description: 'A test tool', schema: { type: 'object' } },
    );
    assert.equal(registerRes.status, 201, 'Owner should register capability');
    assert.equal(registerRes.data.project_id, projectId);
    assert.equal(registerRes.data.agent_id, agentId);
    assert.equal(registerRes.data.name, 'test-capability');
    assert.equal(registerRes.data.description, 'A test tool');
    assert.ok(registerRes.data.id, 'Should return capability id');
    const capId = registerRes.data.id;

    // ─── Test 2b: Admin with EditProject can register an MCP capability ───────
    console.log('Test 2b: Admin with EditProject can register an MCP capability');
    const adminRegisterRes = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      admin.token,
      { agent_id: agentId, name: 'admin-capability', description: 'Registered by admin' },
    );
    assert.equal(adminRegisterRes.status, 201, 'Admin should register capability');
    assert.equal(adminRegisterRes.data.project_id, projectId);
    assert.equal(adminRegisterRes.data.agent_id, agentId);
    assert.equal(adminRegisterRes.data.name, 'admin-capability');
    assert.ok(adminRegisterRes.data.id, 'Should return capability id');
    const adminCapId = adminRegisterRes.data.id;

    // ─── Test 3: Owner and member can list capabilities ─────────────────────
    console.log('Test 3: Owner with ViewProject can list capabilities');
    const ownerList = await api(
      baseUrl, 'GET',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
    );
    assert.equal(ownerList.status, 200, 'Owner should list capabilities');
    assert.ok(Array.isArray(ownerList.data.data), 'Should return data array');
    assert.equal(ownerList.data.data.length, 2, 'Should have 2 capabilities');
    const ownerListIds = ownerList.data.data.map((c: any) => c.id);
    assert.ok(ownerListIds.includes(capId), 'Owner list should include owner capability');
    assert.ok(ownerListIds.includes(adminCapId), 'Owner list should include admin capability');

    console.log('Test 3b: Member with ViewProject can list capabilities');
    const memberList = await api(
      baseUrl, 'GET',
      `/v1/projects/${projectId}/mcp/capabilities`,
      member.token,
    );
    assert.equal(memberList.status, 200, 'Member should list capabilities');
    assert.ok(Array.isArray(memberList.data.data), 'Should return data array');
    assert.equal(memberList.data.data.length, 2, 'Member should see both capabilities');
    const memberListIds = memberList.data.data.map((c: any) => c.id);
    assert.ok(memberListIds.includes(capId), 'Member list should include owner capability');
    assert.ok(memberListIds.includes(adminCapId), 'Member list should include admin capability');

    // ─── Test 4: Invalid register payloads return 422 ───────────────────────
    console.log('Test 4a: Missing agent_id returns 422');
    const noAgentId = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
      { name: 'test' },
    );
    assert.equal(noAgentId.status, 422, 'Missing agent_id should return 422');
    assert.ok(noAgentId.data.detail, 'Should have detail');
    assert.equal(noAgentId.data.detail[0].loc[1], 'agent_id');

    console.log('Test 4b: Empty agent_id returns 422');
    const emptyAgentId = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
      { agent_id: '', name: 'test' },
    );
    assert.equal(emptyAgentId.status, 422, 'Empty agent_id should return 422');

    console.log('Test 4c: Non-string agent_id returns 422');
    const badAgentId = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
      { agent_id: 123, name: 'test' },
    );
    assert.equal(badAgentId.status, 422, 'Non-string agent_id should return 422');

    console.log('Test 4d: Missing name returns 422');
    const noName = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
      { agent_id: agentId },
    );
    assert.equal(noName.status, 422, 'Missing name should return 422');
    assert.equal(noName.data.detail[0].loc[1], 'name');

    console.log('Test 4e: Empty name returns 422');
    const emptyName = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
      { agent_id: agentId, name: '' },
    );
    assert.equal(emptyName.status, 422, 'Empty name should return 422');

    console.log('Test 4f: Whitespace-only name returns 422');
    const whitespaceName = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
      { agent_id: agentId, name: '   ' },
    );
    assert.equal(whitespaceName.status, 422, 'Whitespace-only name should return 422');

    // ─── Test 5: Delete returns 204 ─────────────────────────────────────────
    console.log('Test 5: Delete removes capability and returns 204');
    // Register a second capability to delete
    const cap2 = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
      { agent_id: agentId, name: 'to-delete' },
    );
    assert.equal(cap2.status, 201);
    const cap2Id = cap2.data.id;

    const deleteRes = await api(
      baseUrl, 'DELETE',
      `/v1/projects/${projectId}/mcp/capabilities/${cap2Id}`,
      owner.token,
    );
    assert.equal(deleteRes.status, 204, 'Delete should return 204');

    // Verify it's gone from the list
    const listAfterDelete = await api(
      baseUrl, 'GET',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
    );
    assert.equal(listAfterDelete.status, 200);
    const remainingIds = listAfterDelete.data.data.map((c: any) => c.id);
    assert.ok(!remainingIds.includes(cap2Id), 'Deleted capability should not appear in list');

    // ─── Test 6: Deleting missing/wrong-project capability returns 404 ──────
    console.log('Test 6a: Deleting nonexistent capability returns 404');
    const deleteMissing = await api(
      baseUrl, 'DELETE',
      `/v1/projects/${projectId}/mcp/capabilities/00000000-0000-0000-0000-000000000000`,
      owner.token,
    );
    assert.equal(deleteMissing.status, 404, 'Deleting nonexistent should return 404');

    console.log('Test 6b: Deleting capability from wrong project returns 404');
    // capId belongs to projectId, try deleting from otherProjectId
    const deleteWrongProject = await api(
      baseUrl, 'DELETE',
      `/v1/projects/${otherProjectId}/mcp/capabilities/${capId}`,
      otherOwner.token,
    );
    assert.equal(deleteWrongProject.status, 404, 'Cross-project delete should return 404');

    // Verify the original capability still exists
    const verifyStillThere = await api(
      baseUrl, 'GET',
      `/v1/projects/${projectId}/mcp/capabilities`,
      owner.token,
    );
    const stillThereIds = verifyStillThere.data.data.map((c: any) => c.id);
    assert.ok(stillThereIds.includes(capId), 'Original capability should still exist after cross-project delete attempt');

    // ─── Test 7: Member cannot register (no EditProject) ────────────────────
    console.log('Test 7: Member without EditProject cannot register');
    const memberRegister = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/mcp/capabilities`,
      member.token,
      { agent_id: agentId, name: 'member-attempt' },
    );
    assert.equal(memberRegister.status, 403, 'Member should get 403 on register');

    // ─── Test 8: Member cannot delete (no EditProject) ──────────────────────
    console.log('Test 8: Member without EditProject cannot delete');
    const memberDelete = await api(
      baseUrl, 'DELETE',
      `/v1/projects/${projectId}/mcp/capabilities/${capId}`,
      member.token,
    );
    assert.equal(memberDelete.status, 403, 'Member should get 403 on delete');

    console.log('All MCP route tests passed');
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
    password: 'McpTest123!',
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
