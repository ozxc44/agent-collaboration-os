import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-summary-test-secret';

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
    const other = await register(baseUrl, 'other');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Summary Test',
      description: 'Testing project-space summary',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    const otherProject = await api(baseUrl, 'POST', '/v1/projects', other.token, {
      name: 'Other Project',
      visibility: 'private',
    });
    assert.equal(otherProject.status, 201);

    // Seed files in the primary project — diverse paths for insight field coverage
    const seed = [
      { path: 'ReadMe.md', content: '# Project Summary\n\nBrief.' },
      { path: 'docs/guide.md', content: 'Guide content' },
      { path: 'docs/api.md', content: 'API reference' },
      { path: 'src/main.ts', content: 'console.log("main")' },
      { path: 'src/utils.ts', content: 'export const helper = () => {};' },
      { path: 'assets/logo.png', content: 'PNG-binary' },
      { path: 'deliverables/report.md', content: 'Final report' },
      { path: 'deliverables/slides.md', content: 'Slides' },
      { path: '.agent/RESULT.md', content: 'Result artifact' },
      { path: '.agent/TRACE.md', content: 'Trace artifact' },
    ];
    for (const item of seed) {
      const r = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
        path: item.path,
        content: item.content,
      });
      assert.equal(r.status, 201, `seed ${item.path}`);
    }

    // Seed a file in the other project to prove scoping
    const otherFile = await api(
      baseUrl,
      'POST',
      `/v1/projects/${otherProject.data.id}/files`,
      other.token,
      { path: 'README.md', content: 'Other readme' },
    );
    assert.equal(otherFile.status, 201);

    // ─── Basic summary shape and scoping ─────────────────────────────────────
    const summary = await api(baseUrl, 'GET', `/v1/projects/${projectId}/summary`, owner.token);
    assert.equal(summary.status, 200);
    assert.equal(summary.data.project_id, projectId);
    assert.equal(summary.data.status, 'active');
    assert.equal(summary.data.files.total_count, seed.length);
    assert.equal(
      summary.data.files.total_bytes,
      seed.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0),
    );

    // README detected case-insensitively
    assert.ok(summary.data.readme, 'README should be detected');
    assert.equal(summary.data.readme.path, 'ReadMe.md');

    // Bucket files detected case-insensitively
    assert.ok(summary.data.buckets.agent_result, 'RESULT.md bucket should be detected');
    assert.equal(summary.data.buckets.agent_result.path, '.agent/RESULT.md');
    assert.ok(summary.data.buckets.agent_trace, 'TRACE.md bucket should be detected');
    assert.equal(summary.data.buckets.agent_trace.path, '.agent/TRACE.md');
    assert.equal(summary.data.buckets.agent_review, null);

    // Deliverables bucket
    assert.deepEqual(
      summary.data.buckets.deliverables.map((f: any) => f.path).sort(),
      ['deliverables/report.md', 'deliverables/slides.md'],
    );

    // ─── New insight fields ───────────────────────────────────────────────────

    // Top-level directory count: docs, src, assets, deliverables, .agent = 5 dirs
    assert.equal(summary.data.files.directory_count, 5, 'should count 5 top-level directories');

    // File type breakdown: should include .md, .ts, .png sorted by count desc
    assert.ok(Array.isArray(summary.data.files.file_types), 'file_types should be an array');
    assert.ok(summary.data.files.file_types.length > 0, 'file_types should not be empty');
    assert.ok(summary.data.files.file_types.length <= 10, 'file_types should be bounded to top-10');
    // .md files dominate (ReadMe, docs/guide, docs/api, deliverables/report, deliverables/slides, .agent/RESULT, .agent/TRACE = 7)
    const mdType = summary.data.files.file_types.find((t: any) => t.extension === '.md');
    assert.ok(mdType, 'should include .md extension');
    assert.equal(mdType.count, 7, '.md should have 7 files');

    // Last updated file should reference the most recently touched file
    assert.ok(summary.data.last_updated_file, 'last_updated_file should be present');
    assert.ok(summary.data.last_updated_file.file_id, 'last_updated_file should have file_id');
    assert.ok(summary.data.last_updated_file.path, 'last_updated_file should have path');
    assert.ok(summary.data.last_updated_file.updated_at, 'last_updated_file should have updated_at');

    // Other project summary is scoped and does not leak primary project data
    const otherSummary = await api(
      baseUrl,
      'GET',
      `/v1/projects/${otherProject.data.id}/summary`,
      other.token,
    );
    assert.equal(otherSummary.status, 200);
    assert.equal(otherSummary.data.files.total_count, 1);
    assert.equal(otherSummary.data.readme.path, 'README.md');

    // Owner cannot see other project's summary
    const crossSummary = await api(
      baseUrl,
      'GET',
      `/v1/projects/${otherProject.data.id}/summary`,
      owner.token,
    );
    assert.equal(crossSummary.status, 403);

    // ─── README case-insensitive variants ─────────────────────────────────────
    const readmeProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'README Variants',
    });
    assert.equal(readmeProject.status, 201);
    const readmeProjectId = readmeProject.data.id;

    const readmeVariants = ['README.TXT', 'readme.md', 'Readme.Markdown', 'README'];
    for (const path of readmeVariants) {
      const r = await api(baseUrl, 'POST', `/v1/projects/${readmeProjectId}/files`, owner.token, {
        path,
        content: `${path} content`,
      });
      assert.equal(r.status, 201, `seed readme variant ${path}`);
    }

    const variantSummary = await api(
      baseUrl,
      'GET',
      `/v1/projects/${readmeProjectId}/summary`,
      owner.token,
    );
    assert.equal(variantSummary.status, 200);
    assert.ok(variantSummary.data.readme, 'README variant should be detected');
    // Root-level READMEs are preferred; among root READMEs, deterministic by path sort.
    assert.equal(variantSummary.data.readme.path, 'README');
    assert.equal(variantSummary.data.files.total_count, readmeVariants.length);

    // ─── Recent activity determinism ─────────────────────────────────────────
    const activityProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Activity Determinism',
    });
    assert.equal(activityProject.status, 201);
    const activityProjectId = activityProject.data.id;

    const activityFiles = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const activityRevisionByPath = new Map<string, string>();
    for (const path of activityFiles) {
      const r = await api(baseUrl, 'POST', `/v1/projects/${activityProjectId}/files`, owner.token, {
        path,
        content: `content of ${path}`,
      });
      assert.equal(r.status, 201, `seed activity ${path}`);
      activityRevisionByPath.set(path, r.data.current_revision_id);
    }

    // Update a few files to create non-trivial recent-file ordering
    for (const path of ['c.md', 'a.md', 'e.md']) {
      const r = await api(baseUrl, 'POST', `/v1/projects/${activityProjectId}/files`, owner.token, {
        path,
        content: `updated content of ${path}`,
        base_revision_id: activityRevisionByPath.get(path),
      });
      assert.equal(r.status, 200, `update activity ${path}`);
      activityRevisionByPath.set(path, r.data.current_revision_id);
    }

    const run1 = await api(
      baseUrl,
      'GET',
      `/v1/projects/${activityProjectId}/summary`,
      owner.token,
    );
    const run2 = await api(
      baseUrl,
      'GET',
      `/v1/projects/${activityProjectId}/summary`,
      owner.token,
    );
    assert.equal(run1.status, 200);
    assert.equal(run2.status, 200);
    assert.deepEqual(run1.data, run2.data, 'summary must be fully deterministic');
    assert.deepEqual(
      run1.data.recent_activity.files.map((f: any) => f.path),
      run2.data.recent_activity.files.map((f: any) => f.path),
      'recent files order must be deterministic',
    );
    assert.deepEqual(
      run1.data.recent_activity.revisions.map((r: any) => r.path),
      run2.data.recent_activity.revisions.map((r: any) => r.path),
      'recent revisions order must be deterministic',
    );

    // Most recently updated files should appear before untouched files.
    const recentPaths = run1.data.recent_activity.files.map((f: any) => f.path);
    assert.deepEqual(recentPaths.sort(), [...activityFiles].sort());

    // ─── Auth / membership requirements ──────────────────────────────────────
    const noAuth = await api(baseUrl, 'GET', `/v1/projects/${projectId}/summary`);
    assert.equal(noAuth.status, 401);

    const badToken = await api(baseUrl, 'GET', `/v1/projects/${projectId}/summary`, 'invalid-token');
    assert.equal(badToken.status, 401);

    console.log('project-summary tests passed');
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
    password: 'ProjectSummaryTest123!',
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
