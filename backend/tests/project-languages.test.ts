import assert from 'node:assert/strict';
import http from 'node:http';
import { ProjectFile } from '../src/entities/project-file.entity';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'project-languages-test-secret';

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
    const owner = await register(baseUrl, 'languages-owner');
    const viewer = await register(baseUrl, 'languages-viewer');
    const outsider = await register(baseUrl, 'languages-outsider');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Project Languages Test',
      description: 'Testing repository language breakdown',
      visibility: 'public',
    });
    assert.equal(project.status, 201);
    const projectId = project.data.id;

    // Add viewer to prove ViewProject access is sufficient.
    const addViewer = await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, {
      user_id: viewer.userId,
      role: 'viewer',
    });
    assert.equal(addViewer.status, 201);

    // Seed a mix of recognized, unknown, and extensionless files.
    const seed = [
      { path: 'src/main.ts', content: 'const greeting: string = "hello";' },
      { path: 'src/utils.ts', content: 'export const helper = () => {};' },
      { path: 'app.js', content: 'console.log("hello world");' },
      { path: 'styles.css', content: 'body { margin: 0; padding: 0; }' },
      { path: 'config.json', content: '{"debug": true}' },
      { path: 'README.md', content: '# Project Languages\n\nTest repository.' },
      { path: 'assets/logo.png', content: 'PNG-fake-binary-content' },
      { path: 'Dockerfile', content: 'FROM node:20' },
      { path: 'notes', content: 'plain text without extension' },
      { path: 'data.unknownext', content: 'unknown extension content' },
    ];

    const createdFiles = new Map<string, { id: string; sizeBytes: number }>();
    for (const item of seed) {
      const r = await api(baseUrl, 'POST', `/v1/projects/${projectId}/files`, owner.token, {
        path: item.path,
        content: item.content,
      });
      assert.equal(r.status, 201, `seed ${item.path}`);
      createdFiles.set(item.path, {
        id: r.data.id,
        sizeBytes: Buffer.byteLength(item.content, 'utf8'),
      });
    }

    const expectedTypeScript =
      createdFiles.get('src/main.ts')!.sizeBytes + createdFiles.get('src/utils.ts')!.sizeBytes;
    const expectedJavaScript = createdFiles.get('app.js')!.sizeBytes;
    const expectedCss = createdFiles.get('styles.css')!.sizeBytes;
    const expectedJson = createdFiles.get('config.json')!.sizeBytes;
    const expectedMarkdown = createdFiles.get('README.md')!.sizeBytes;
    const expectedTotalBytes =
      expectedTypeScript + expectedJavaScript + expectedCss + expectedJson + expectedMarkdown;

    // ─── Basic language breakdown ────────────────────────────────────────────
    const languagesRes = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/languages`,
      owner.token,
    );
    assert.equal(languagesRes.status, 200);
    assert.deepEqual(languagesRes.data.source, 'project_files');
    assert.ok(Array.isArray(languagesRes.data.limitations));
    assert.ok(
      languagesRes.data.limitations.includes('extension-based local estimate'),
      'should document extension-based estimate',
    );

    const languages = languagesRes.data.languages as Record<string, number>;
    assert.equal(
      languages.TypeScript,
      expectedTypeScript,
      'TypeScript bytes should equal sum of .ts files',
    );
    assert.equal(languages.JavaScript, expectedJavaScript);
    assert.equal(languages.CSS, expectedCss);
    assert.equal(languages.JSON, expectedJson);
    assert.equal(languages.Markdown, expectedMarkdown);
    assert.equal(languagesRes.data.total_bytes, expectedTotalBytes);

    // Unknown-extension and extensionless files are omitted honestly.
    assert.equal(languages['PNG'], undefined, '.png should not be mapped to a language');
    assert.equal(
      Object.prototype.hasOwnProperty.call(languages, 'Dockerfile'),
      false,
      'extensionless Dockerfile should not appear',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(languages, 'notes'),
      false,
      'extensionless file should not appear',
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(languages, 'UNKNOWNEXT'),
      false,
      'unknown extension should not appear',
    );

    // Deterministic ordering: bytes descending, then language name ascending.
    const languageEntries = Object.entries(languages) as [string, number][];
    for (let i = 1; i < languageEntries.length; i++) {
      const prev = languageEntries[i - 1];
      const curr = languageEntries[i];
      assert.ok(
        prev[1] > curr[1] || (prev[1] === curr[1] && prev[0].localeCompare(curr[0]) < 0),
        'language ordering must be deterministic',
      );
    }

    // ─── Viewer can read, outsider cannot ────────────────────────────────────
    const viewerRes = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/languages`,
      viewer.token,
    );
    assert.equal(viewerRes.status, 200);

    const outsiderRes = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/languages`,
      outsider.token,
    );
    assert.equal(outsiderRes.status, 403);

    // ─── Authentication requirements ─────────────────────────────────────────
    const noAuth = await api(baseUrl, 'GET', `/v1/projects/${projectId}/languages`);
    assert.equal(noAuth.status, 401);

    const badToken = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/languages`,
      'invalid-token',
    );
    assert.equal(badToken.status, 401);

    // ─── Cross-project scoping ───────────────────────────────────────────────
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', outsider.token, {
      name: 'Other Languages Project',
      visibility: 'private',
    });
    assert.equal(otherProject.status, 201);
    const otherFile = await api(
      baseUrl,
      'POST',
      `/v1/projects/${otherProject.data.id}/files`,
      outsider.token,
      { path: 'main.rs', content: 'fn main() {}' },
    );
    assert.equal(otherFile.status, 201);

    const primaryLanguages = await api(
      baseUrl,
      'GET',
      `/v1/projects/${projectId}/languages`,
      owner.token,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(primaryLanguages.data.languages, 'Rust'),
      false,
      'other project files must not leak',
    );

    // ─── Deleted files are excluded ──────────────────────────────────────────
    const deleteProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Deleted Languages Test',
    });
    assert.equal(deleteProject.status, 201);
    const deleteProjectId = deleteProject.data.id;

    const doomedFile = await api(
      baseUrl,
      'POST',
      `/v1/projects/${deleteProjectId}/files`,
      owner.token,
      { path: 'deleted.ts', content: 'export const removed = true;' },
    );
    assert.equal(doomedFile.status, 201);

    const beforeDelete = await api(
      baseUrl,
      'GET',
      `/v1/projects/${deleteProjectId}/languages`,
      owner.token,
    );
    assert.equal(beforeDelete.status, 200);
    assert.equal(beforeDelete.data.languages.TypeScript > 0, true);

    const fileRepo = AppDataSource.getRepository(ProjectFile);
    await fileRepo.update(doomedFile.data.id, { deletedAt: new Date() });

    const afterDelete = await api(
      baseUrl,
      'GET',
      `/v1/projects/${deleteProjectId}/languages`,
      owner.token,
    );
    assert.equal(afterDelete.status, 200);
    assert.deepEqual(afterDelete.data.languages, {});
    assert.equal(afterDelete.data.total_bytes, 0);

    // ─── Empty/unknown-only project ──────────────────────────────────────────
    const emptyProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Empty Languages Test',
    });
    assert.equal(emptyProject.status, 201);
    const emptyProjectId = emptyProject.data.id;

    const emptyFiles = [
      { path: 'README', content: 'no extension' },
      { path: 'binary.bin', content: 'binary-like content' },
    ];
    for (const item of emptyFiles) {
      const r = await api(
        baseUrl,
        'POST',
        `/v1/projects/${emptyProjectId}/files`,
        owner.token,
        item,
      );
      assert.equal(r.status, 201, `seed empty ${item.path}`);
    }

    const emptyRes = await api(
      baseUrl,
      'GET',
      `/v1/projects/${emptyProjectId}/languages`,
      owner.token,
    );
    assert.equal(emptyRes.status, 200);
    assert.deepEqual(emptyRes.data.languages, {});
    assert.equal(emptyRes.data.total_bytes, 0);
    assert.equal(emptyRes.data.source, 'project_files');
    assert.ok(emptyRes.data.limitations.length > 0);

    // ─── Non-existent project is rejected by permission layer ────────────────
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const notFound = await api(
      baseUrl,
      'GET',
      `/v1/projects/${fakeId}/languages`,
      owner.token,
    );
    assert.equal(notFound.status, 403);

    console.log('project-languages tests passed');
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
    password: 'ProjectLanguagesTest123!',
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
