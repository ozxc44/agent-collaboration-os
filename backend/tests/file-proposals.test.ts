import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'file-proposals-test-secret';

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
    // -- Setup --
    const owner = await register(baseUrl, 'owner');
    const nonMember = await register(baseUrl, 'nonmember');

    // Create a public project
    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'File Proposals Test',
      description: 'Testing proposal flow',
      visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    // Create an agent in the project
    const agentRes = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, {
      name: 'ProposalAgent',
      description: 'Agent for proposal testing',
    });
    check('create agent', agentRes.status, 201);
    const agentId = agentRes.data.id;
    const agentApiKey = agentRes.data.api_key;

    // Create a file in the project (for base_revision_id tests)
    const file = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'README.md',
      content: '# Original Content',
      message: 'Initial file',
    });
    check('create file', file.status, 201);
    const fileId = file.data.id;
    const currentRevisionId = file.data.current_revision_id;

    // -- Agent can create proposal --
    console.log('\n-- Agent creates proposal --');

    const agentProposal = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/file-proposals`, agentApiKey, {
      path: 'README.md',
      proposed_content: '# Agent Proposed Content\n\nNew section added by agent.',
      title: 'Update README',
      description: 'Adding a new section',
      base_revision_id: currentRevisionId,
    });
    check('agent creates proposal for existing file', agentProposal.status, 201);
    check('proposal status is pending', agentProposal.data.status, 'pending');
    check('proposal created_by_agent_id matches', agentProposal.data.created_by_agent_id, agentId);
    check('proposal created_by_user_id is null', agentProposal.data.created_by_user_id, null);
    check('proposal file_id matches', agentProposal.data.file_id, fileId);
    check('proposal base_revision_id matches', agentProposal.data.base_revision_id, currentRevisionId);
    const proposalId = agentProposal.data.id;

    // Agent creates proposal for new file (no existing file)
    const newFileProposal = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/file-proposals`, agentApiKey, {
      path: 'docs/new-guide.md',
      proposed_content: '# New Guide\n\nAgent-proposed new file.',
      title: 'New guide',
    });
    check('agent creates proposal for new file', newFileProposal.status, 201);
    check('new file proposal file_id is null', newFileProposal.data.file_id, null);
    check('new file proposal base_revision_id is null', newFileProposal.data.base_revision_id, null);
    const newFileProposalId = newFileProposal.data.id;

    // -- Agent cannot direct file write (JWT-only) --
    console.log('\n-- Agent cannot direct file write --');

    const directWrite = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/files`, agentApiKey, {
      path: 'agent-write.md',
      content: 'Direct write attempt',
    });
    // Agent file writes are now authenticated but scoped to deliverables/ only.
    // Writing outside deliverables/ returns 403 (forbidden path), not 401.
    check('agent denied direct file write (outside deliverables/)', directWrite.status, 403);

    // -- List proposals --
    console.log('\n-- List proposals --');

    const listAll = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/file-proposals`, agentApiKey);
    check('list all proposals', listAll.status, 200);
    check('list has 2 proposals', listAll.data.data.length, 2);

    const listPending = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/file-proposals?status=pending`, agentApiKey);
    check('list pending proposals', listPending.status, 200);
    check('pending count is 2', listPending.data.data.length, 2);

    const listByPath = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/file-proposals?path=README.md`, agentApiKey);
    check('list proposals by path', listByPath.status, 200);
    check('path filter returns 1', listByPath.data.data.length, 1);

    // -- Get single proposal --
    console.log('\n-- Get single proposal --');

    const getOne = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/file-proposals/${proposalId}`, agentApiKey);
    check('get single proposal', getOne.status, 200);
    check('proposal id matches', getOne.data.id, proposalId);

    const getMissing = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/file-proposals/00000000-0000-0000-0000-000000000000`, agentApiKey);
    check('get missing proposal returns 404', getMissing.status, 404);

    // -- Owner can approve and file content/revision changes --
    console.log('\n-- Owner approves proposal --');

    const approve = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/file-proposals/${proposalId}/review`,
      owner.token,
      { status: 'approved', message: 'Looks good' },
    );
    check('owner approves proposal', approve.status, 200);
    check('proposal status is approved', approve.data.status, 'approved');
    check('proposal reviewed_by matches owner', approve.data.reviewed_by, owner.userId);
    check('proposal merged_revision_id is set', typeof approve.data.merged_revision_id, 'string');
    check('proposal review_message set', approve.data.review_message, 'Looks good');

    // Verify file content was updated
    const updatedFile = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${fileId}`, owner.token);
    check('file content updated after approval', updatedFile.data.content, '# Agent Proposed Content\n\nNew section added by agent.');
    check('file content_hash updated', updatedFile.data.content_hash, agentProposal.data.content_hash);

    // Verify new revision was created
    const revisions = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${fileId}/revisions`, owner.token);
    check('file has 2 revisions after approval', revisions.data.data.length, 2);
    const latestRevision = revisions.data.data[revisions.data.data.length - 1];
    check('latest revision number is 2', latestRevision.revision_number, 2);
    check('latest revision matches proposal content', latestRevision.content, '# Agent Proposed Content\n\nNew section added by agent.');

    // Approve the new file proposal
    const approveNew = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/file-proposals/${newFileProposalId}/review`,
      owner.token,
      { status: 'approved' },
    );
    check('approve new file proposal', approveNew.status, 200);
    check('new file proposal merged_revision_id set', typeof approveNew.data.merged_revision_id, 'string');

    // Verify new file was created
    const filesList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files`, owner.token);
    const newFileExists = filesList.data.data.some((f: any) => f.path === 'docs/new-guide.md');
    check('new file created after approval', newFileExists, true);

    // -- Stale base_revision_id approval conflicts --
    console.log('\n-- Stale base_revision_id conflict --');

    // Create another proposal with the OLD base_revision_id (now stale)
    const staleProposal = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/file-proposals`, agentApiKey, {
      path: 'README.md',
      proposed_content: '# Stale proposal',
      base_revision_id: currentRevisionId, // this is now stale (rev 1, current is rev 2)
    });
    check('create stale proposal', staleProposal.status, 201);

    const staleApprove = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/file-proposals/${staleProposal.data.id}/review`,
      owner.token,
      { status: 'approved' },
    );
    check('stale approval returns 409', staleApprove.status, 409);
    check('stale error mentions conflict', staleApprove.data.detail.includes('conflict'), true);

    // -- Owner can reject --
    console.log('\n-- Owner rejects proposal --');

    const rejectProposal = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/file-proposals`, agentApiKey, {
      path: 'rejected-file.md',
      proposed_content: '# This will be rejected',
      title: 'Bad idea',
    });
    check('create proposal to reject', rejectProposal.status, 201);

    const reject = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/file-proposals/${rejectProposal.data.id}/review`,
      owner.token,
      { status: 'rejected', message: 'Not aligned with project goals' },
    );
    check('owner rejects proposal', reject.status, 200);
    check('rejected proposal status', reject.data.status, 'rejected');
    check('rejected proposal review_message', reject.data.review_message, 'Not aligned with project goals');
    check('rejected proposal merged_revision_id is null', reject.data.merged_revision_id, null);

    // -- Cannot review already-reviewed proposal --
    console.log('\n-- Cannot re-review --');

    const reReview = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/file-proposals/${proposalId}/review`,
      owner.token,
      { status: 'rejected' },
    );
    check('cannot re-review approved proposal', reReview.status, 409);

    // -- Non-member access denied --
    console.log('\n-- Non-member access denied --');

    const nonMemberProposal = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/file-proposals`, agentApiKey, {
      path: 'test.md',
      proposed_content: '# Test',
    });

    const nonMemberList = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/file-proposals`,
      nonMember.token,
    );
    check('non-member denied list proposals', nonMemberList.status, 403);

    const nonMemberReview = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/file-proposals/${nonMemberProposal.data.id}/review`,
      nonMember.token,
      { status: 'approved' },
    );
    check('non-member denied review proposals', nonMemberReview.status, 403);

    // -- Cross-project agent access denied --
    console.log('\n-- Cross-project agent denied --');

    const otherProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Other Project',
    });
    const otherAgent = await api(baseUrl, 'POST', `/v1/projects/${otherProject.data.id}/agents`, owner.token, {
      name: 'OtherAgent',
    });
    const crossProjectAttempt = await apiWithKey(
      baseUrl,
      'POST',
      `/v1/projects/${projectId}/file-proposals`,
      otherAgent.data.api_key,
      { path: 'hack.md', proposed_content: '# Cross project' },
    );
    check('cross-project agent denied create proposal', crossProjectAttempt.status, 403);

    // -- Validation --
    console.log('\n-- Validation --');

    const noPath = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/file-proposals`, agentApiKey, {
      proposed_content: '# No path',
    });
    check('missing path returns 422', noPath.status, 422);

    const noContent = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/file-proposals`, agentApiKey, {
      path: 'test.md',
    });
    check('missing proposed_content returns 422', noContent.status, 422);

    const badReview = await api(
      baseUrl,
      'PATCH',
      `/v1/projects/${projectId}/file-proposals/${nonMemberProposal.data.id}/review`,
      owner.token,
      { status: 'invalid_status' },
    );
    check('invalid review status returns 422', badReview.status, 422);

    // -- Summary --
    console.log(`\n-- Results: ${passed} passed, ${failed} failed --`);
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
    password: 'FileProposalTest123!',
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
