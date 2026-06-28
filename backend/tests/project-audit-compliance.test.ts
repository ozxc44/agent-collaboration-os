import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-audit-compliance-test-secret';

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
    const owner = await register(baseUrl, 'audit-compliance-owner');
    const admin = await register(baseUrl, 'audit-compliance-admin');
    const viewer = await register(baseUrl, 'audit-compliance-viewer');
    const member = await register(baseUrl, 'audit-compliance-member');
    const outsider = await register(baseUrl, 'audit-compliance-outsider');
    const { ProjectAuditEvent, ProjectAuditAction } = await import('../src/entities/project-audit-event.entity');
    const auditRepo = AppDataSource.getRepository(ProjectAuditEvent);

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Audit Compliance Test',
      description: 'Compliance summary backend coverage',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const emptySummary = await compliance(baseUrl, projectId, owner.token);
    assert.equal(emptySummary.status, 200);
    assert.equal(emptySummary.data.project_id, projectId);
    assert.equal(emptySummary.data.total_events, 0);
    assert.equal(emptySummary.data.oldest_event_at, null);
    assert.equal(emptySummary.data.newest_event_at, null);
    assert.deepEqual(emptySummary.data.action_counts, {});
    assert.equal(emptySummary.data.export.available, true);
    assert.deepEqual(emptySummary.data.export.formats, ['json', 'csv']);
    assert.equal(emptySummary.data.retention_policy.configured, false);
    assert.equal(emptySummary.data.retention_policy.retention_days, null);
    assert.equal(emptySummary.data.retention_policy.status, 'not_configured');
    assert.equal(emptySummary.data.retention_policy.eligible_event_count, 0);
    assert.equal(emptySummary.data.legal_hold.enabled, false);
    assert.equal(emptySummary.data.legal_hold.status, 'disabled');
    assert.equal(emptySummary.data.immutable_attestation.available, true);
    assert.equal(emptySummary.data.immutable_attestation.status, 'empty');
    assert.equal(emptySummary.data.immutable_attestation.verified, true);
    assert.equal(emptySummary.data.immutable_attestation.local_only, true);
    assert.equal(emptySummary.data.immutable_attestation.legal_grade, false);
    assert.equal(emptySummary.data.immutable_attestation.total_events, 0);
    assert.equal(emptySummary.data.redaction_policy.strategy, 'key_based');
    assert.ok(
      emptySummary.data.redaction_policy.sensitive_keys.includes('webhook_secret'),
      'redaction policy should disclose sensitive key coverage without exposing values',
    );

    const addAdmin = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: admin.userId,
      role: 'admin',
    });
    assert.equal(addAdmin.status, 201);

    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addViewer.status, 201);

    const addMember = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: member.userId,
      role: 'member',
    });
    assert.equal(addMember.status, 201);

    const settingsPatch = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, {
      name: 'Project Audit Compliance Test Updated',
      webhook_url: 'https://example.invalid/compliance',
      webhook_secret: 'compliance-secret-must-not-leak',
    });
    assert.equal(settingsPatch.status, 200);

    const summary = await compliance(baseUrl, projectId, owner.token);
    assert.equal(summary.status, 200);
    assert.equal(summary.data.total_events >= 3, true, 'member adds and settings update should be counted');
    assert.equal(summary.data.action_counts.member_added >= 2, true);
    assert.equal(summary.data.action_counts.project_settings_updated, 1);
    assert.ok(summary.data.oldest_event_at, 'oldest timestamp should be present when events exist');
    assert.ok(summary.data.newest_event_at, 'newest timestamp should be present when events exist');
    assert.equal(
      JSON.stringify(summary.data).includes('compliance-secret-must-not-leak'),
      false,
      'compliance summary must not expose raw secret values',
    );
    assert.equal(summary.data.immutable_attestation.available, true);
    assert.equal(summary.data.immutable_attestation.status, 'verified');
    assert.equal(summary.data.immutable_attestation.verified, true);
    assert.equal(summary.data.immutable_attestation.local_only, true);
    assert.equal(summary.data.immutable_attestation.legal_grade, false);
    assert.equal(summary.data.immutable_attestation.algorithm, 'sha256');
    assert.equal(summary.data.immutable_attestation.covered_events, summary.data.total_events);
    assert.match(summary.data.immutable_attestation.latest_hash, /^[a-f0-9]{64}$/);

    const ownerAttestation = await attestation(baseUrl, projectId, owner.token);
    assert.equal(ownerAttestation.status, 200);
    assert.equal(ownerAttestation.data.immutable_attestation.verified, true);
    assert.equal(ownerAttestation.data.immutable_attestation.latest_hash, summary.data.immutable_attestation.latest_hash);

    const viewerSummary = await compliance(baseUrl, projectId, viewer.token);
    assert.equal(viewerSummary.status, 200, 'viewer should be able to read compliance summary');
    assert.equal(viewerSummary.data.total_events, summary.data.total_events);
    const viewerAttestation = await attestation(baseUrl, projectId, viewer.token);
    assert.equal(viewerAttestation.status, 200, 'viewer should be able to read local attestation');

    const memberSummary = await compliance(baseUrl, projectId, member.token);
    assert.equal(memberSummary.status, 200, 'member should be able to read compliance summary');
    assert.equal(memberSummary.data.total_events, summary.data.total_events);
    const memberAttestation = await attestation(baseUrl, projectId, member.token);
    assert.equal(memberAttestation.status, 200, 'member should be able to read local attestation');

    const outsiderSummary = await compliance(baseUrl, projectId, outsider.token);
    assert.equal(outsiderSummary.status, 403, 'outsider should not read compliance summary');
    const outsiderAttestation = await attestation(baseUrl, projectId, outsider.token);
    assert.equal(outsiderAttestation.status, 403, 'outsider should not read local attestation');

    const eventToTamper = await auditRepo.findOne({
      where: { id: summary.data.immutable_attestation.latest_event_id },
    });
    assert.ok(eventToTamper, 'expected a covered audit event to tamper');
    eventToTamper.metadataJson = { ...(eventToTamper.metadataJson ?? {}), tampered_after_chain: true };
    await auditRepo.save(eventToTamper);
    const tamperedAttestation = await attestation(baseUrl, projectId, owner.token);
    assert.equal(tamperedAttestation.status, 200);
    assert.equal(tamperedAttestation.data.immutable_attestation.verified, false);
    assert.equal(tamperedAttestation.data.immutable_attestation.status, 'broken');
    assert.equal(
      tamperedAttestation.data.immutable_attestation.broken_at_event_id,
      eventToTamper.id,
      'tampered event should be the broken chain point',
    );
    eventToTamper.metadataJson = {
      ...(eventToTamper.metadataJson ?? {}),
      tampered_after_chain: false,
    };
    eventToTamper.chainHash = null;
    eventToTamper.chainPrevHash = null;
    eventToTamper.chainHashVersion = null;
    await auditRepo.save(eventToTamper);

    const invalidPolicy = await updateCompliancePolicy(baseUrl, projectId, owner.token, {
      retention_days: 7,
    });
    assert.equal(invalidPolicy.status, 422, 'retention below minimum should reject');

    const invalidShape = await updateCompliancePolicy(baseUrl, projectId, owner.token, {
      retention_days: '90',
    });
    assert.equal(invalidShape.status, 422, 'retention days must be numeric, not string');

    const viewerPolicy = await updateCompliancePolicy(baseUrl, projectId, viewer.token, {
      retention_days: 90,
    });
    assert.equal(viewerPolicy.status, 403, 'viewer cannot mutate audit compliance policy');

    const memberPolicy = await updateCompliancePolicy(baseUrl, projectId, member.token, {
      retention_days: 90,
    });
    assert.equal(memberPolicy.status, 403, 'member cannot mutate audit compliance policy');

    const outsiderPolicy = await updateCompliancePolicy(baseUrl, projectId, outsider.token, {
      retention_days: 90,
    });
    assert.equal(outsiderPolicy.status, 403, 'outsider cannot mutate audit compliance policy');

    const ownerPolicy = await updateCompliancePolicy(baseUrl, projectId, owner.token, {
      retention_days: 90,
      legal_hold_enabled: true,
    });
    assert.equal(ownerPolicy.status, 200);
    assert.equal(ownerPolicy.data.retention_policy.configured, true);
    assert.equal(ownerPolicy.data.retention_policy.retention_days, 90);
    assert.equal(ownerPolicy.data.retention_policy.status, 'blocked_by_legal_hold');
    assert.equal(ownerPolicy.data.legal_hold.enabled, true);

    const policySummary = await compliance(baseUrl, projectId, viewer.token);
    assert.equal(policySummary.status, 200);
    assert.equal(policySummary.data.retention_policy.configured, true);
    assert.equal(policySummary.data.retention_policy.retention_days, 90);
    assert.equal(policySummary.data.retention_policy.status, 'blocked_by_legal_hold');
    assert.equal(policySummary.data.legal_hold.enabled, true);

    const oldDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await auditRepo.save(
      auditRepo.create({
        projectId,
        actorUserId: owner.userId,
        action: ProjectAuditAction.MEMBER_ADDED,
        targetUserId: null,
        previousRole: null,
        newRole: null,
        metadataJson: { seeded_for_retention_prune: true },
        createdAt: oldDate,
      } as any),
    );

    const legalHoldPrune = await pruneAuditRetention(baseUrl, projectId, owner.token);
    assert.equal(legalHoldPrune.status, 409, 'legal hold must block retention prune');
    assert.equal(legalHoldPrune.data.code, 'audit_legal_hold_enabled');

    const adminPolicy = await updateCompliancePolicy(baseUrl, projectId, admin.token, {
      retention_days: 30,
      legal_hold_enabled: false,
    });
    assert.equal(adminPolicy.status, 200, 'admin can update audit compliance policy');
    assert.equal(adminPolicy.data.retention_policy.status, 'active');
    assert.equal(adminPolicy.data.legal_hold.enabled, false);

    const beforePrune = await compliance(baseUrl, projectId, owner.token);
    assert.equal(beforePrune.data.retention_policy.eligible_event_count >= 1, true);

    const viewerPrune = await pruneAuditRetention(baseUrl, projectId, viewer.token);
    assert.equal(viewerPrune.status, 403, 'viewer cannot prune audit events');

    const prune = await pruneAuditRetention(baseUrl, projectId, owner.token);
    assert.equal(prune.status, 200);
    assert.equal(prune.data.retention_days, 30);
    assert.equal(prune.data.pruned_count >= 1, true);
    assert.equal(prune.data.legal_hold_enabled, false);

    const afterPrune = await compliance(baseUrl, projectId, owner.token);
    assert.equal(afterPrune.data.retention_policy.status, 'active');
    assert.equal(afterPrune.data.retention_policy.eligible_event_count, 0);
    assert.equal(afterPrune.data.action_counts.audit_retention_pruned, 1);

    const clearPolicy = await updateCompliancePolicy(baseUrl, projectId, owner.token, {
      retention_days: null,
      legal_hold_enabled: false,
    });
    assert.equal(clearPolicy.status, 200);
    assert.equal(clearPolicy.data.retention_policy.configured, false);
    assert.equal(clearPolicy.data.retention_policy.status, 'not_configured');

    const unconfiguredPrune = await pruneAuditRetention(baseUrl, projectId, owner.token);
    assert.equal(unconfiguredPrune.status, 409);
    assert.equal(unconfiguredPrune.data.code, 'audit_retention_not_configured');

    console.log('project-audit-compliance tests passed');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await AppDataSource.destroy();
  }
}

async function compliance(baseUrl: string, projectId: string, token: string) {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events/compliance`, token);
}

async function attestation(baseUrl: string, projectId: string, token: string) {
  return api(baseUrl, 'GET', `/v1/projects/${projectId}/audit-events/attestation`, token);
}

async function updateCompliancePolicy(baseUrl: string, projectId: string, token: string, body: unknown) {
  return api(baseUrl, 'PATCH', `/v1/projects/${projectId}/audit-events/compliance-policy`, token, body);
}

async function pruneAuditRetention(baseUrl: string, projectId: string, token: string) {
  return api(baseUrl, 'POST', `/v1/projects/${projectId}/audit-events/retention-prune`, token);
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string; userId: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'ProjectAuditComplianceTest123!',
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
