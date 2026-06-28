import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'collab-req-test-secret';

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
  await AppDataSource.initialize();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // ── Setup ─────────────────────────────────────────────────────────────────
    const owner = await register(baseUrl, 'owner');
    const requester = await register(baseUrl, 'requester');
    const otherUser = await register(baseUrl, 'other');

    // Owner creates project
    const projectRes = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Collab Test Project',
      description: 'Testing collaboration requests',
      visibility: 'public',
    });
    check('create project', projectRes.status, 201);
    const projectId = projectRes.data.id;

    // Owner creates an agent
    const agentRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'CollabAgent',
      description: 'Agent for collab testing',
    });
    check('create agent', agentRes.status, 201);
    const agentId = agentRes.data.id;
    const agentKey = agentRes.data.api_key;

    // ── Test 1: Create project_join request via new API ───────────────────────
    console.log('\n── Test 1: Create project_join request ──');
    const joinRes = await api(baseUrl, 'POST', '/v1/requests', requester.token, {
      request_type: 'project_join',
      project_id: projectId,
      requested_role: 'member',
      note: 'Please let me join',
    });
    check('create project_join returns 201', joinRes.status, 201);
    check('request_type is project_join', joinRes.data.request_type, 'project_join');
    check('status is pending_owner', joinRes.data.status, 'pending_owner');
    check('project_id set', joinRes.data.project_id, projectId);
    check('requested_by_user_id set', joinRes.data.requested_by_user_id, requester.userId);
    check('note set', joinRes.data.note, 'Please let me join');
    const joinRequestId = joinRes.data.id;

    // ── Test 2: Duplicate join request returns 409 ───────────────────────────
    console.log('\n── Test 2: Duplicate join request ──');
    const dupRes = await api(baseUrl, 'POST', '/v1/requests', requester.token, {
      request_type: 'project_join',
      project_id: projectId,
    });
    check('duplicate returns 409', dupRes.status, 409);

    // ── Test 3: List requests ─────────────────────────────────────────────────
    console.log('\n── Test 3: List requests ──');
    const listRes = await api(baseUrl, 'GET', '/v1/requests?scope=owner', requester.token);
    check('list returns 200', listRes.status, 200);
    check('list has data', Array.isArray(listRes.data.data), true);
    check('list has 1 item', listRes.data.data.length, 1);
    check('list item id matches', listRes.data.data[0].id, joinRequestId);

    // ── Test 4: Owner inbox notification ──────────────────────────────────────
    // First bind agent to owner
    const bindRes = await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', owner.token, {
      agent_id: agentId,
    });
    check('bind agent returns 200', bindRes.status, 200);

    // Create another join request to trigger inbox (owner now has bound agent)
    const requester2 = await register(baseUrl, 'requester2');
    const joinRes2 = await api(baseUrl, 'POST', '/v1/requests', requester2.token, {
      request_type: 'project_join',
      project_id: projectId,
    });
    check('second join request 201', joinRes2.status, 201);

    const ownerInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', agentKey);
    check('owner inbox returns 200', ownerInbox.status, 200);
    const collabCreated = ownerInbox.data.data.find((item: any) => item.event_type === 'collaboration_request_created');
    check('collaboration_request_created inbox exists', Boolean(collabCreated), true);

    // ── Test 5: Approve project_join request ──────────────────────────────────
    console.log('\n── Test 5: Approve project_join ──');
    const approveRes = await api(baseUrl, 'POST', `/v1/requests/${joinRequestId}/approve`, owner.token);
    check('approve returns 200', approveRes.status, 200);
    check('status is approved', approveRes.data.status, 'approved');
    check('reviewed_by set', approveRes.data.reviewed_by, owner.userId);

    // Verify membership was created
    const membersRes = await api(baseUrl, 'GET', `/v1/projects/${projectId}/members`, owner.token);
    check('members list returns 200', membersRes.status, 200);
    const memberEntry = membersRes.data.data.find((m: any) => m.user_id === requester.userId);
    check('requester is now a member', Boolean(memberEntry), true);

    // ── Test 6: Reject project_join request ───────────────────────────────────
    console.log('\n── Test 6: Reject project_join ──');
    const rejectJoinRes = await api(baseUrl, 'POST', `/v1/requests/${joinRes2.data.id}/reject`, owner.token);
    check('reject returns 200', rejectJoinRes.status, 200);
    check('rejected status', rejectJoinRes.data.status, 'rejected');

    // Reject should NOT add membership
    const membersAfterReject = await api(baseUrl, 'GET', `/v1/projects/${projectId}/members`, owner.token);
    const rejectedMember = membersAfterReject.data.data.find((m: any) => m.user_id === requester2.userId);
    check('rejected requester not a member', rejectedMember, undefined);

    // ── Test 7: owner_agent_bind request via new API ──────────────────────────
    console.log('\n── Test 7: owner_agent_bind request ──');
    // Unbind first
    await api(baseUrl, 'PATCH', '/v1/users/me/owner-agent', owner.token, { agent_id: null });

    const bindReqRes = await api(baseUrl, 'POST', '/v1/requests', owner.token, {
      request_type: 'owner_agent_bind',
      target_agent_id: agentId,
    });
    check('bind request returns 201', bindReqRes.status, 201);
    check('bind request_type', bindReqRes.data.request_type, 'owner_agent_bind');
    check('bind status pending_agent', bindReqRes.data.status, 'pending_agent');
    check('bind target_agent_id', bindReqRes.data.target_agent_id, agentId);
    const bindRequestId = bindReqRes.data.id;

    // Agent should receive owner_agent_bind_requested inbox
    const agentInbox = await apiWithKey(baseUrl, 'GET', '/v1/agent/inbox', agentKey);
    check('agent inbox returns 200', agentInbox.status, 200);
    const bindRequested = agentInbox.data.data.find((item: any) => item.event_type === 'owner_agent_bind_requested');
    check('owner_agent_bind_requested inbox exists', Boolean(bindRequested), true);

    // ── Test 8: Agent approves owner_agent_bind ──────────────────────────────
    console.log('\n── Test 8: Agent approves owner_agent_bind ──');
    const agentApprove = await apiWithKey(baseUrl, 'POST', `/v1/requests/${bindRequestId}/approve`, agentKey);
    check('agent approve returns 200', agentApprove.status, 200);
    check('bind request approved', agentApprove.data.status, 'approved');

    // Verify owner_agent_id was set
    const meRes = await api(baseUrl, 'GET', '/v1/auth/me', owner.token);
    check('owner_agent_id set after approval', meRes.data.owner_agent_id, agentId);

    // ── Test 9: Cancel request ────────────────────────────────────────────────
    console.log('\n── Test 9: Cancel request ──');
    const requester3 = await register(baseUrl, 'requester3');
    const joinRes3 = await api(baseUrl, 'POST', '/v1/requests', requester3.token, {
      request_type: 'project_join',
      project_id: projectId,
    });
    check('create join 3 returns 201', joinRes3.status, 201);

    const cancelRes = await api(baseUrl, 'POST', `/v1/requests/${joinRes3.data.id}/cancel`, requester3.token);
    check('cancel returns 200', cancelRes.status, 200);
    check('cancelled status', cancelRes.data.status, 'cancelled');

    // Cancel should NOT add membership
    const membersAfterCancel = await api(baseUrl, 'GET', `/v1/projects/${projectId}/members`, owner.token);
    const cancelledMember = membersAfterCancel.data.data.find((m: any) => m.user_id === requester3.userId);
    check('cancelled requester not a member', cancelledMember, undefined);

    // ── Test 10: Non-requester cannot cancel ──────────────────────────────────
    console.log('\n── Test 10: Cancel authorization ──');
    const requester4 = await register(baseUrl, 'requester4');
    const joinRes4 = await api(baseUrl, 'POST', '/v1/requests', requester4.token, {
      request_type: 'project_join',
      project_id: projectId,
    });
    const wrongCancel = await api(baseUrl, 'POST', `/v1/requests/${joinRes4.data.id}/cancel`, otherUser.token);
    check('wrong user cancel returns 403', wrongCancel.status, 403);

    // ── Test 11: Reject/cancel leave owner_agent_id unchanged ─────────────────
    console.log('\n── Test 11: Reject/cancel no side effects ──');
    const ownerMeBefore = await api(baseUrl, 'GET', '/v1/auth/me', owner.token);
    const ownerAgentBefore = ownerMeBefore.data.owner_agent_id;

    // Reject a request - owner_agent_id should stay the same
    await api(baseUrl, 'POST', `/v1/requests/${joinRes4.data.id}/reject`, owner.token);
    const ownerMeAfterReject = await api(baseUrl, 'GET', '/v1/auth/me', owner.token);
    check('owner_agent_id unchanged after reject', ownerMeAfterReject.data.owner_agent_id, ownerAgentBefore);

    // ── Test 12: Old join-request API still works and bridges ─────────────────
    console.log('\n── Test 12: Old join-request API bridge ──');
    const requester5 = await register(baseUrl, 'requester5');
    const oldJoinRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/join-requests`, requester5.token, {
      requested_role: 'member',
      note: 'Via old API',
    });
    check('old join request returns 201', oldJoinRes.status, 201);
    check('old join request has id', Boolean(oldJoinRes.data.id), true);

    // Check that a collaboration_request was created with legacy_join_request_id
    const collabList = await api(baseUrl, 'GET', `/v1/requests?scope=project&project_id=${projectId}`, owner.token);
    check('collab list returns 200', collabList.status, 200);
    const bridged = collabList.data.data.find((r: any) => r.legacy_join_request_id === oldJoinRes.data.id);
    check('bridged collab request exists', Boolean(bridged), true);
    check('bridged type is project_join', bridged?.request_type, 'project_join');

    // Approve via old API
    const oldApproveRes = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/join-requests/${oldJoinRes.data.id}`, owner.token, {
      status: 'approved',
    });
    check('old approve returns 200', oldApproveRes.status, 200);

    // Check that collab request status was synced
    const bridgedAfter = await api(baseUrl, 'GET', `/v1/requests?scope=project&project_id=${projectId}`, owner.token);
    const bridgedUpdated = bridgedAfter.data.data.find((r: any) => r.legacy_join_request_id === oldJoinRes.data.id);
    check('bridged request synced to approved', bridgedUpdated?.status, 'approved');

    // ── Test 13: project_invite request ───────────────────────────────────────
    console.log('\n── Test 13: project_invite request ──');
    const invitee = await register(baseUrl, 'invitee');
    const inviteRes = await api(baseUrl, 'POST', '/v1/requests', owner.token, {
      request_type: 'project_invite',
      project_id: projectId,
      target_user_id: invitee.userId,
      requested_role: 'viewer',
    });
    check('invite returns 201', inviteRes.status, 201);
    check('invite type', inviteRes.data.request_type, 'project_invite');
    check('invite target_user_id', inviteRes.data.target_user_id, invitee.userId);
    check('invite status pending_owner', inviteRes.data.status, 'pending_owner');

    // Non-admin cannot invite
    const nonAdminInvite = await api(baseUrl, 'POST', '/v1/requests', requester.token, {
      request_type: 'project_invite',
      project_id: projectId,
      target_user_id: otherUser.userId,
    });
    check('non-admin invite returns 403', nonAdminInvite.status, 403);

    // ── Test 14: Terminal status rejection ────────────────────────────────────
    console.log('\n── Test 14: Terminal status guard ──');
    const alreadyApproved = await api(baseUrl, 'POST', `/v1/requests/${joinRequestId}/reject`, owner.token);
    check('reject approved request returns 409', alreadyApproved.status, 409);

    const alreadyCancelled = await api(baseUrl, 'POST', `/v1/requests/${joinRes3.data.id}/approve`, owner.token);
    check('approve cancelled request returns 409', alreadyCancelled.status, 409);

    // ── Test 15: Filter by status ─────────────────────────────────────────────
    console.log('\n── Test 15: Filter by status ──');
    const approvedOnly = await api(baseUrl, 'GET', '/v1/requests?status=approved', requester.token);
    check('filtered list returns 200', approvedOnly.status, 200);
    const allApproved = approvedOnly.data.data.every((r: any) => r.status === 'approved');
    check('all items are approved', allApproved, true);

    // ── Test 16: Invalid request_type ─────────────────────────────────────────
    console.log('\n── Test 16: Invalid request_type ──');
    const invalidType = await api(baseUrl, 'POST', '/v1/requests', requester.token, {
      request_type: 'invalid_type',
    });
    check('invalid type returns 422', invalidType.status, 422);

    // ── Test 17: Back-sync legacy join request on collab approve ────────────
    console.log('\n── Test 17: Back-sync approve ──');
    const requester6 = await register(baseUrl, 'requester6');
    const oldJoinRes2 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/join-requests`, requester6.token, {
      requested_role: 'member',
      note: 'Bridge back-sync approve test',
    });
    check('old join request 2 returns 201', oldJoinRes2.status, 201);
    const legacyJoinReqId2 = oldJoinRes2.data.id;

    // Find the bridged collaboration request
    const collabList2 = await api(baseUrl, 'GET', `/v1/requests?scope=project&project_id=${projectId}`, owner.token);
    const bridgedForApprove = collabList2.data.data.find((r: any) => r.legacy_join_request_id === legacyJoinReqId2);
    check('bridged collab request exists for approve test', Boolean(bridgedForApprove), true);

    // Approve via the NEW collaboration API
    const collabApproveRes = await api(baseUrl, 'POST', `/v1/requests/${bridgedForApprove.id}/approve`, owner.token);
    check('collab approve returns 200', collabApproveRes.status, 200);
    check('collab request approved', collabApproveRes.data.status, 'approved');

    // Verify the legacy join request was back-synced to approved
    const legacyAfterApprove = await api(baseUrl, 'GET', `/v1/projects/${projectId}/join-requests`, owner.token);
    const legacyApproved = legacyAfterApprove.data.data.find((r: any) => r.id === legacyJoinReqId2);
    check('legacy join request back-synced to approved', legacyApproved?.status, 'approved');

    // ── Test 18: Back-sync legacy join request on collab reject ─────────────
    console.log('\n── Test 18: Back-sync reject ──');
    const requester7 = await register(baseUrl, 'requester7');
    const oldJoinRes3 = await api(baseUrl, 'POST', `/v1/projects/${projectId}/join-requests`, requester7.token, {
      requested_role: 'member',
      note: 'Bridge back-sync reject test',
    });
    check('old join request 3 returns 201', oldJoinRes3.status, 201);
    const legacyJoinReqId3 = oldJoinRes3.data.id;

    const collabList3 = await api(baseUrl, 'GET', `/v1/requests?scope=project&project_id=${projectId}`, owner.token);
    const bridgedForReject = collabList3.data.data.find((r: any) => r.legacy_join_request_id === legacyJoinReqId3);
    check('bridged collab request exists for reject test', Boolean(bridgedForReject), true);

    // Reject via the NEW collaboration API
    const collabRejectRes = await api(baseUrl, 'POST', `/v1/requests/${bridgedForReject.id}/reject`, owner.token);
    check('collab reject returns 200', collabRejectRes.status, 200);
    check('collab request rejected', collabRejectRes.data.status, 'rejected');

    // Verify the legacy join request was back-synced to rejected
    const legacyAfterReject = await api(baseUrl, 'GET', `/v1/projects/${projectId}/join-requests`, owner.token);
    const legacyRejected = legacyAfterReject.data.data.find((r: any) => r.id === legacyJoinReqId3);
    check('legacy join request back-synced to rejected', legacyRejected?.status, 'rejected');

    // ── Test 19: Non-bridged collab request unaffected ──────────────────────
    console.log('\n── Test 19: Non-bridged request unaffected ──');
    const requester8 = await register(baseUrl, 'requester8');
    const nonBridgedRes = await api(baseUrl, 'POST', '/v1/requests', requester8.token, {
      request_type: 'project_join',
      project_id: projectId,
      requested_role: 'member',
    });
    check('non-bridged join request returns 201', nonBridgedRes.status, 201);
    check('non-bridged has no legacy_join_request_id', nonBridgedRes.data.legacy_join_request_id, null);

    const nonBridgedApprove = await api(baseUrl, 'POST', `/v1/requests/${nonBridgedRes.data.id}/approve`, owner.token);
    check('non-bridged approve returns 200', nonBridgedApprove.status, 200);
    check('non-bridged status approved', nonBridgedApprove.data.status, 'approved');

    // ── Summary ───────────────────────────────────────────────────────────────
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

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'CollabReqTest123!',
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
