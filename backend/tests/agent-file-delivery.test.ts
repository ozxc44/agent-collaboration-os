import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agent-file-delivery-test-secret';

/**
 * Agent file delivery tests.
 *
 * Verifies:
 *   1. An agent (X-API-Key) can write files under deliverables/<agent_id>/.
 *   2. An agent CANNOT write outside deliverables/ (path safety).
 *   3. The human (JWT) can still read the delivered file.
 *   4. worker_context.md includes the delivery contract guidance.
 */
async function main(): Promise<void> {
  const { AppDataSource } = await import('../src/data-source');
  await AppDataSource.initialize();
  try {
    const app = (await import('../src/app')).default;
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const owner = await register(baseUrl, 'delivery-owner');
      const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
        name: 'Delivery Test',
        description: 'Agent file delivery.',
      });
      assert.equal(project.status, 201);
      const projectId = project.data.id;

      const agent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'deliverer' });
      assert.equal(agent.status, 201);
      const agentId: string = agent.data.id;
      const apiKey: string = agent.data.api_key;
      assert.ok(apiKey, 'agent must have an api key');

      // 1. Agent CAN write under deliverables/<agent_id>/
      const delivered = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/files`,
        apiKey,
        { path: `deliverables/${agentId}/report.md`, content: '# Report\n\nDelivered by agent.' },
      );
      assert.equal(delivered.status, 201, 'agent must be able to write under deliverables/<agent_id>/');

      // 2. Agent CANNOT write outside deliverables/ (path safety)
      const blocked = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/files`,
        apiKey,
        { path: '.agent/orchestrations/fake/goal.md', content: 'malicious' },
      );
      assert.equal(blocked.status, 403, 'agent must NOT write outside deliverables/');
      assert.match(
        String(blocked.data.detail || ''),
        /deliverables\//,
        'block reason must mention deliverables/',
      );

      // 3. Human can read the delivered file
      const files = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files?path_prefix=deliverables/`, owner.token);
      assert.equal(files.status, 200);
      const list = files.data.data || files.data;
      const found = (list as any[]).find((f) => f.path === `deliverables/${agentId}/report.md`);
      assert.ok(found, 'delivered file must be listed');
      const content = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${found.id}`, owner.token);
      assert.equal(content.status, 200);
      assert.match(content.data.content as string, /Delivered by agent/, 'delivered content must be readable by human');

      // 4. worker_context.md includes delivery contract
      const mainAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'main-deliv' });
      const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, owner.token, { name: 'worker-deliv' });
      await heartbeatAgent(baseUrl, mainAgent.data.api_key);
      await heartbeatAgent(baseUrl, workerAgent.data.api_key);
      const orch = await api(baseUrl, 'POST', `/v1/projects/${projectId}/orchestrations`, owner.token, {
        title: 'Deliv orch',
        objective: 'Verify delivery contract in worker context.',
        main_agent_id: mainAgent.data.id,
        worker_agent_ids: [workerAgent.data.id],
      });
      assert.equal(orch.status, 201);
      const taskResp = await apiWithKey(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/orchestrations/${orch.data.id}/tasks`,
        mainAgent.data.api_key,
        { title: 'deliver', goal: 'deliver a file', assigned_agent_id: workerAgent.data.id },
      );
      assert.equal(taskResp.status, 201);
      const allFiles = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files?path_prefix=.agent/`, owner.token);
      const all = (allFiles.data.data || allFiles.data) as any[];
      const ctxFile = all.find((f) => f.path.endsWith('.worker_context.md'));
      assert.ok(ctxFile, 'worker_context.md must exist');
      const ctx = await api(baseUrl, 'GET', `/v1/projects/${projectId}/files/${ctxFile.id}`, owner.token);
      const ctxContent = ctx.data.content as string;
      assert.match(ctxContent, /Delivery Contract/i, 'worker_context.md must include Delivery Contract section');
      assert.match(ctxContent, /zz agent deliver/, 'context must mention zz agent deliver');
      assert.match(ctxContent, /zz agent progress/, 'context must mention zz agent progress');
      assert.match(ctxContent, /zz changesets create/, 'context must mention zz changesets create');

      console.log('agent-file-delivery tests passed');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    await AppDataSource.destroy();
  }
}

async function register(baseUrl: string, prefix: string): Promise<{ token: string }> {
  const response = await api(baseUrl, 'POST', '/v1/auth/register', undefined, {
    email: `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
    password: 'AgentDelivery123!',
    display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token };
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, { status: 'healthy', metrics: { load: 0 } });
  assert.equal(response.status, 200);
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => { console.error(err); process.exit(1); });
