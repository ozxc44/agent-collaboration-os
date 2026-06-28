import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-security-test-secret';

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
    const owner = await register(baseUrl, 'security-owner');
    const admin = await register(baseUrl, 'security-admin');
    const member = await register(baseUrl, 'security-member');
    const viewer = await register(baseUrl, 'security-viewer');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Security Test Project',
      description: 'Testing security advisories',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: admin.userId, role: 'admin' })).status, 201);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: member.userId, role: 'member' })).status, 201);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: viewer.userId, role: 'viewer' })).status, 201);

    console.log('Test 1: Owner can create security advisory');
    const create = await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, {
      title: 'Critical package issue',
      slug: ' Critical Package Issue ',
      severity: 'critical',
      status: 'published',
      affected_package: 'demo-package',
      affected_version: '<1.2.3',
      fixed_version: '1.2.3',
      cve_id: 'CVE-2026-0001',
      body: '# Advisory\n\nUpgrade immediately.',
      references: ['https://example.com/advisory'],
      project_id: 'ignored',
      created_by: member.userId,
    });
    assert.equal(create.status, 201);
    assert.equal(create.data.slug, 'critical-package-issue');
    assert.equal(create.data.severity, 'critical');
    assert.equal(create.data.status, 'published');
    assert.equal(create.data.affected_package, 'demo-package');
    assert.equal(create.data.cve_id, 'CVE-2026-0001');
    assert.deepEqual(create.data.references, ['https://example.com/advisory']);
    assert.equal(create.data.project_id, projectId);
    assert.equal(create.data.created_by, owner.userId);
    assert.ok(create.data.published_at);
    const advisoryId = create.data.id;

    console.log('Test 2: Admin can create draft advisory');
    const adminCreate = await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, admin.token, {
      title: 'Draft issue',
      severity: 'low',
      status: 'draft',
      body: 'Draft body',
    });
    assert.equal(adminCreate.status, 201);
    assert.equal(adminCreate.data.slug, 'draft-issue');
    assert.equal(adminCreate.data.published_at, null);

    console.log('Test 3: Member/viewer cannot create');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, member.token, { title: 'Nope' })).status, 403);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, viewer.token, { title: 'Nope' })).status, 403);

    console.log('Test 4: Duplicate slug returns 409');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, { title: 'Critical Package Issue!!!' })).status, 409);

    console.log('Test 5: Invalid severity/status/references return 422');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, { title: 'Bad severity', severity: 'severe' })).status, 422);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, { title: 'Bad status', status: 'scanning' })).status, 422);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, { title: 'Bad ref', references: ['ftp://example.com'] })).status, 422);

    console.log('Test 6: Owner/member/viewer can list and summary omits body');
    for (const user of [owner, member, viewer]) {
      const list = await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories`, user.token);
      assert.equal(list.status, 200);
      assert.equal(list.data.meta.total, 2);
      assert.equal(list.data.data.length, 2);
      assert.equal(list.data.data[0].body, undefined);
      assert.equal(list.data.data[0].references, undefined);
    }

    console.log('Test 6b: List supports severity/status filters and validates query bounds');
    const criticalList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories?severity=critical`, owner.token);
    assert.equal(criticalList.status, 200);
    assert.equal(criticalList.data.meta.total, 1);
    assert.equal(criticalList.data.data[0].slug, 'critical-package-issue');

    const draftList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories?status=draft`, owner.token);
    assert.equal(draftList.status, 200);
    assert.equal(draftList.data.meta.total, 1);
    assert.equal(draftList.data.data[0].slug, 'draft-issue');

    const combinedList = await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories?severity=low&status=draft`, owner.token);
    assert.equal(combinedList.status, 200);
    assert.equal(combinedList.data.meta.total, 1);
    assert.equal(combinedList.data.data[0].slug, 'draft-issue');

    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories?severity=severe`, owner.token)).status, 422);
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories?status=scanning`, owner.token)).status, 422);
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories?skip=-1`, owner.token)).status, 422);
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories?limit=101`, owner.token)).status, 422);

    console.log('Test 7: Owner/member/viewer can read full advisory');
    for (const user of [owner, member, viewer]) {
      const read = await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories/${advisoryId}`, user.token);
      assert.equal(read.status, 200);
      assert.equal(read.data.id, advisoryId);
      assert.equal(read.data.body, '# Advisory\n\nUpgrade immediately.');
      assert.deepEqual(read.data.references, ['https://example.com/advisory']);
    }

    console.log('Test 8: Missing advisory returns 404');
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories/00000000-0000-4000-8000-000000000000`, owner.token)).status, 404);

    console.log('Test 9: Owner/admin can update; member/viewer cannot update');
    const update = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/security-advisories/${advisoryId}`, owner.token, {
      title: 'Critical package issue updated',
      severity: 'high',
      status: 'resolved',
      body: 'Resolved by upgrading.',
      fixed_version: '1.2.4',
    });
    assert.equal(update.status, 200);
    assert.equal(update.data.title, 'Critical package issue updated');
    assert.equal(update.data.severity, 'high');
    assert.equal(update.data.status, 'resolved');
    assert.equal(update.data.fixed_version, '1.2.4');
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/security-advisories/${advisoryId}`, admin.token, { severity: 'medium' })).status, 200);
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/security-advisories/${advisoryId}`, member.token, { title: 'No' })).status, 403);
    assert.equal((await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/security-advisories/${advisoryId}`, viewer.token, { title: 'No' })).status, 403);

    console.log('Test 10: Bounds and mass-assignment guard');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, { title: 'x'.repeat(256) })).status, 422);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, { title: 'Oversized body', body: 'x'.repeat(1_000_001) })).status, 422);
    const before = await api(baseUrl, 'GET', `/v1/projects/${projectId}/security-advisories/${advisoryId}`, owner.token);
    const mass = await api(baseUrl, 'PATCH', `/v1/projects/${projectId}/security-advisories/${advisoryId}`, owner.token, {
      body: 'Mass assignment guard',
      project_id: 'pwned',
      created_by: viewer.userId,
      updated_by: viewer.userId,
      id: '00000000-0000-4000-8000-000000000001',
    });
    assert.equal(mass.status, 200);
    assert.equal(mass.data.id, advisoryId);
    assert.equal(mass.data.project_id, projectId);
    assert.equal(mass.data.created_by, before.data.created_by);

    console.log('Test 11: Owner can run local manifest hygiene scan');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'package.json',
      content: JSON.stringify({
        scripts: { bootstrap: 'curl http://example.invalid/install.sh' },
        dependencies: { lodash: '*', express: 'latest' },
      }),
      content_type: 'application/json',
      message: 'Seed manifest hygiene package',
    })).status, 201);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: '.npmrc',
      content: 'registry=http://registry.example.invalid\n',
      content_type: 'text/plain',
      message: 'Seed npmrc',
    })).status, 201);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'packages/bad/package.json',
      content: '{',
      content_type: 'application/json',
      message: 'Seed malformed manifest',
    })).status, 201);

    const scan = await api(baseUrl, 'POST', `/v1/projects/${projectId}/security/manifest-hygiene-scan`, owner.token);
    assert.equal(scan.status, 200);
    assert.equal(scan.data.scan_type, 'manifest_hygiene');
    assert.equal(scan.data.is_vulnerability_scan, false);
    assert.ok(Array.isArray(scan.data.checked_files));
    assert.ok(scan.data.checked_files.includes('package.json'));
    assert.ok(scan.data.checked_files.includes('.npmrc'));
    const ruleIds = scan.data.findings.map((finding: any) => finding.rule_id);
    assert.ok(ruleIds.includes('manifest_missing_lockfile'));
    assert.ok(ruleIds.includes('manifest_unpinned_dependency'));
    assert.ok(ruleIds.includes('manifest_insecure_script_url'));
    assert.ok(ruleIds.includes('manifest_insecure_registry'));
    assert.ok(ruleIds.includes('manifest_json_invalid'));
    assert.equal(scan.data.finding_count, scan.data.findings.length);

    console.log('Test 12: Read-only roles cannot run local manifest hygiene scan');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security/manifest-hygiene-scan`, member.token)).status, 403);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security/manifest-hygiene-scan`, viewer.token)).status, 403);

    console.log('Test 13: Project members can read local dependency audit');
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
      path: 'package-lock.json',
      content: JSON.stringify({
        name: 'security-test-project',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { lodash: '*', express: 'latest' } },
          'node_modules/lodash': { version: '4.17.20' },
        },
      }),
      content_type: 'application/json',
      message: 'Seed dependency audit lockfile',
    })).status, 201);
    const lodashAdvisory = await api(baseUrl, 'POST', `/v1/projects/${projectId}/security-advisories`, owner.token, {
      title: 'Lodash project advisory',
      severity: 'high',
      status: 'published',
      affected_package: 'lodash',
      affected_version: '<4.17.21',
      fixed_version: '4.17.21',
      cve_id: 'CVE-2026-LODASH',
    });
    assert.equal(lodashAdvisory.status, 201);

    for (const user of [owner, member, viewer]) {
      const audit = await api(baseUrl, 'GET', `/v1/projects/${projectId}/security/dependency-audit`, user.token);
      assert.equal(audit.status, 200);
      assert.equal(audit.data.audit_type, 'local_dependency_audit');
      assert.equal(audit.data.is_external_vulnerability_scan, false);
      assert.ok(audit.data.checked_files.includes('package.json'));
      assert.ok(audit.data.checked_files.includes('package-lock.json'));
      assert.equal(audit.data.dependency_count, 2);
      assert.equal(audit.data.dependency_counts_by_section.dependencies, 2);
      assert.equal(audit.data.lockfile_count, 1);
      assert.equal(audit.data.manifests[0].lockfiles.includes('package-lock.json'), true);
      assert.equal(audit.data.known_advisory_matches.length, 1);
      assert.equal(audit.data.known_advisory_matches[0].affected_package, 'lodash');
      assert.equal(audit.data.known_advisory_matches[0].severity, 'high');
      assert.ok(audit.data.limitations.some((item: string) => item.includes('No external vulnerability database')));
    }

    console.log('Test 14: Outsider/anonymous cannot read local dependency audit and no fake mutation route exists');
    const outsider = await register(baseUrl, 'security-outsider');
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/security/dependency-audit`, outsider.token)).status, 403);
    assert.equal((await api(baseUrl, 'GET', `/v1/projects/${projectId}/security/dependency-audit`)).status, 401);
    assert.equal((await api(baseUrl, 'POST', `/v1/projects/${projectId}/security/dependency-audit`, owner.token)).status, 404);

    console.log('All project security advisory tests passed');
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
    password: 'SecurityTestPassword123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
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
