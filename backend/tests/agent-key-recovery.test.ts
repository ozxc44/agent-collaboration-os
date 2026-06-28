import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agent-key-recovery-test-secret';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  const app = (await import('../src/app')).default;
  const { Agent, AgentStatus, AgentLifecycleStatus, AgentRuntime } = await import('../src/entities/agent.entity');
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // ── Setup ─────────────────────────────────────────────────────────────
    const owner = await register(baseUrl, 'owner');   // creates the project
    const member = await register(baseUrl, 'member'); // will be added as project member
    const outsider = await register(baseUrl, 'outsider'); // never a member

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Key Recovery Test',
      description: 'RBAC recovery: owner can rotate/agent-self-service join-requests',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // ── Case 1: MEMBER can rotate key of the agent they created ──────────
    // (this was the live "能建不能改" bug: member has no EditAgent in the matrix,
    //  so rotate-key returned 403 "requires member" even for their own agent.)
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: member.userId,
      role: 'member',
    });

    const memberAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, member.token, {
      name: 'member-owned-agent',
      description: 'created by the member themselves',
    });
    check('member creates own agent', memberAgent.status, 201);
    const memberAgentId = memberAgent.data.id;
    const memberAgentKey = memberAgent.data.api_key;
    check('create returns full api_key once', typeof memberAgentKey === 'string' && memberAgentKey.startsWith('zzk_'), true);

    const rotateByMember = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/agents/${memberAgentId}/rotate-key`,
      member.token,
      {},
    );
    check('member rotates key of own agent (was 403 before fix)', rotateByMember.status, 200);
    check('rotate returns a NEW full api_key', typeof rotateByMember.data.api_key === 'string' && rotateByMember.data.api_key !== memberAgentKey, true);

    // The old key must no longer authenticate after rotation.
    const oldKeyAfterRotate = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents/${memberAgentId}`, memberAgentKey);
    check('old api_key invalid after rotate', oldKeyAfterRotate.status, 401);

    // ── Case 2: a member CANNOT rotate an agent they do NOT own ──────────
    const ownerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'owner-agent',
      description: 'created by the project owner',
    });
    const ownerAgentId = ownerAgent.data.id;

    const rotateOthers = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/agents/${ownerAgentId}/rotate-key`,
      member.token,
      {},
    );
    check('member denied rotate of agent they do not own', rotateOthers.status, 403);

    // ── Case 3: NON-MEMBER owner can rotate (join-request pending path) ───
    // Simulate the bootstrap scenario: an agent was registered before approval.
    // We cannot create the agent via API as a non-member (CreateAgent requires
    // membership), so seed it directly in the DB owned by the outsider, then
    // assert the outsider can recover the key without being a project member.
    const agentRepo = AppDataSource.getRepository(Agent);
    const seeded = new Agent();
    seeded.projectId = projectId;
    seeded.name = 'outsider-pre-approval-agent';
    seeded.description = 'seeded: owned by a user whose join-request is still pending';
    seeded.runtime = AgentRuntime.PYTHON;
    seeded.apiKeyHash = await hashApiKey('zzk_seedplaceholder_will_be_rotated');
    seeded.apiKeyPrefix = 'zzk_seed';
    seeded.identityCode = 'zzk_seed';
    seeded.status = AgentStatus.ACTIVE;
    seeded.lifecycleStatus = AgentLifecycleStatus.ACTIVE;
    seeded.ownerUserId = outsider.userId;
    seeded.createdBy = outsider.userId;
    await agentRepo.save(seeded);

    const rotateByOutsider = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/agents/${seeded.id}/rotate-key`,
      outsider.token,
      {},
    );
    check('non-member owner rotates own agent (pending-approval recovery)', rotateByOutsider.status, 200);
    check('non-member rotate returns new full api_key', typeof rotateByOutsider.data.api_key === 'string', true);

    // Sanity: a totally unrelated non-member still cannot rotate it.
    const stranger = await register(baseUrl, 'stranger');
    const rotateByStranger = await api(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/agents/${seeded.id}/rotate-key`,
      stranger.token,
      {},
    );
    check('unrelated non-member denied rotate', rotateByStranger.status, 403);

    // ── Case 4: self-service GET /v1/me/join-requests ────────────────────
    // outsider has NOT been added as a member; submit a join request and read
    // it back WITHOUT project membership (the ManageMembers-gated list would 403).
    const joinReq = await api(baseUrl, 'POST', `/v1/projects/${projectId}/join-requests`, outsider.token, {
      requested_role: 'member',
      note: 'recovering my agent after pre-approval registration',
    });
    check('outsider submits join request', joinReq.status, 201);

    const myRequests = await api(baseUrl, 'GET', '/v1/me/join-requests', outsider.token);
    check('self-service list own join-requests (no membership)', myRequests.status, 200);
    const mine = Array.isArray(myRequests.data.data) ? myRequests.data.data : [];
    check('self-service returns the pending request', mine.some((r: any) => r.id === joinReq.data.id), true);
    check('self-service includes project_name', mine.some((r: any) => r.project_name === 'Key Recovery Test'), true);

    // status filter works
    const myPending = await api(baseUrl, 'GET', '/v1/me/join-requests?status=pending', outsider.token);
    check('self-service status filter ok', myPending.status, 200);
    const pendingMine = Array.isArray(myPending.data.data) ? myPending.data.data : [];
    check('status=pending only returns pending', pendingMine.every((r: any) => r.status === 'pending'), true);

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function hashApiKey(key: string): Promise<string> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.default.hash(key, 10);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'KeyRecoveryTest123!',
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
