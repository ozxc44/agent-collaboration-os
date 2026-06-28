import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'incident-rbac-test-secret';

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
    // Setup: create owner, project, agent, and an incident
    const owner = await register(baseUrl, 'incident-owner');
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Incident RBAC Test Project',
      description: 'Test incident authorization',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const agent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'RBAC Test Agent',
    });
    assert.equal(agent.status, 201);
    const agentId = agent.data.id;

    // Create an incident directly via the repository
    const { Incident } = await import('../src/entities/incident.entity');
    const incidentRepo = AppDataSource.getRepository(Incident);
    const testIncident = incidentRepo.create({
      agentId,
      type: 'loop',
      severity: 'warning',
      status: 'open',
      message: 'Test incident for RBAC',
    });
    await incidentRepo.save(testIncident);

    // Create a second user who is NOT a member of the project
    const outsider = await register(baseUrl, 'incident-outsider');

    // Create a third user who is a VIEWER member of the project
    const viewerUser = await register(baseUrl, 'incident-viewer');
    const viewerMember = await api(
      baseUrl, 'POST',
      `/v1/projects/${projectId}/members`,
      owner.token,
      { user_id: viewerUser.userId, role: 'viewer' },
    );
    assert.equal(viewerMember.status, 201);

    // ─── Test 1: Owner can list incidents ─────────────────────────────────
    console.log('Test 1: Owner can list incidents for their project');
    const ownerList = await api(baseUrl, 'GET', '/v1/incidents', owner.token);
    assert.equal(ownerList.status, 200, 'Owner should be able to list incidents');
    assert.ok(Array.isArray(ownerList.data.data), 'Should return data array');
    const ownerIncidentIds = ownerList.data.data.map((i: any) => i.id);
    assert.ok(ownerIncidentIds.includes(testIncident.id), 'Owner should see their project incident');

    // ─── Test 2: Authenticated user NOT member of project gets empty list ───
    console.log('Test 2: Unrelated user gets empty incident list');
    const outsiderList = await api(baseUrl, 'GET', '/v1/incidents', outsider.token);
    assert.equal(outsiderList.status, 200, 'Unrelated user should get 200 (empty)');
    assert.equal(outsiderList.data.data.length, 0, 'Unrelated user should see no incidents');

    // ─── Test 3: Owner can get a specific incident ──────────────────────────
    console.log('Test 3: Owner can get specific incident');
    const ownerGet = await api(baseUrl, 'GET', `/v1/incidents/${testIncident.id}`, owner.token);
    assert.equal(ownerGet.status, 200, 'Owner should be able to get incident');
    assert.equal(ownerGet.data.data.id, testIncident.id);

    // ─── Test 4: Unrelated authenticated user cannot get the incident ──────
    console.log('Test 4: Unrelated user cannot get the incident');
    const outsiderGet = await api(baseUrl, 'GET', `/v1/incidents/${testIncident.id}`, outsider.token);
    assert.equal(outsiderGet.status, 403, 'Unrelated user should get 403');

    // ─── Test 5: Viewer can get a specific incident (read-only) ────────────
    console.log('Test 5: Viewer can get specific incident');
    const viewerGet = await api(baseUrl, 'GET', `/v1/incidents/${testIncident.id}`, viewerUser.token);
    assert.equal(viewerGet.status, 200, 'Viewer should be able to get incident');
    assert.equal(viewerGet.data.data.id, testIncident.id);

    // ─── Test 6: Owner can patch/resolve an incident ───────────────────────
    console.log('Test 6: Owner can patch/resolve an incident');
    const ownerPatch = await api(
      baseUrl, 'PATCH',
      `/v1/incidents/${testIncident.id}`,
      owner.token,
      { status: 'resolved' },
    );
    assert.equal(ownerPatch.status, 200, 'Owner should be able to patch incident');
    assert.equal(ownerPatch.data.data.status, 'resolved');

    // ─── Test 7: Viewer CANNOT patch/resolve an incident ───────────────────
    console.log('Test 7: Viewer cannot patch/resolve an incident');
    // First re-open the incident
    await incidentRepo.update(testIncident.id, { status: 'open' });
    const viewerPatch = await api(
      baseUrl, 'PATCH',
      `/v1/incidents/${testIncident.id}`,
      viewerUser.token,
      { status: 'acknowledged' },
    );
    assert.equal(viewerPatch.status, 403, 'Viewer should get 403 on patch');

    // ─── Test 8: Unrelated user cannot patch the incident ─────────────────
    console.log('Test 8: Unrelated user cannot patch the incident');
    const outsiderPatch = await api(
      baseUrl, 'PATCH',
      `/v1/incidents/${testIncident.id}`,
      outsider.token,
      { status: 'dismissed' },
    );
    assert.equal(outsiderPatch.status, 403, 'Unrelated user should get 403 on patch');

    // ─── Test 9: Agent API key cannot access platform incident routes ───────
    console.log('Test 9: Agent API key cannot access platform incident routes');
    const heartbeatRes = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', agent.data.api_key, {
      status: 'healthy',
      metrics: { load: 0 },
    });
    assert.equal(heartbeatRes.status, 200, 'Heartbeat should succeed');

    const agentListIncidents = await fetch(`${baseUrl}/v1/incidents`, {
      headers: { 'X-API-Key': agent.data.api_key },
    });
    assert.equal(agentListIncidents.status, 401, 'Agent key should not access platform incidents');

    const agentGetIncident = await fetch(`${baseUrl}/v1/incidents/${testIncident.id}`, {
      headers: { 'X-API-Key': agent.data.api_key },
    });
    assert.equal(agentGetIncident.status, 401, 'Agent key should not access platform incident get');

    const agentPatchIncident = await fetch(`${baseUrl}/v1/incidents/${testIncident.id}`, {
      method: 'PATCH',
      headers: {
        'X-API-Key': agent.data.api_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'dismissed' }),
    });
    assert.equal(agentPatchIncident.status, 401, 'Agent key should not access platform incident patch');

    // ─── Test 10: List does not leak inaccessible incidents through totals ──
    console.log('Test 10: List totals do not leak inaccessible incidents');

    // Create incident for outsider's own project
    const outsiderProject = await api(baseUrl, 'POST', '/v1/projects', outsider.token, {
      name: 'Outsider Private Project',
      description: 'Private',
    });
    assert.equal(outsiderProject.status, 201);
    const outsiderAgent = await api(
      baseUrl, 'POST',
      `/v1/projects/${outsiderProject.data.id}/agents`,
      outsider.token,
      { name: 'Outsider Agent' },
    );
    assert.equal(outsiderAgent.status, 201);
    const outsiderIncident = incidentRepo.create({
      agentId: outsiderAgent.data.id,
      type: 'loop',
      severity: 'warning',
      status: 'open',
      message: 'Outsider private incident',
    });
    await incidentRepo.save(outsiderIncident);

    // Owner should see total that does NOT include outsider's incident
    const ownerList2 = await api(baseUrl, 'GET', '/v1/incidents', owner.token);
    assert.equal(ownerList2.status, 200);
    const ownerIncidentIds2 = ownerList2.data.data.map((i: any) => i.id);
    assert.ok(!ownerIncidentIds2.includes(outsiderIncident.id), 'Owner should not see outsider incident');
    // The total should match the number of incidents owner can see
    assert.equal(ownerList2.data.meta.total, ownerList2.data.data.length, 'Total should match data length (no leaked count)');

    console.log('All incident RBAC tests passed');
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
    password: 'IncidentRBACTest123!',
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
