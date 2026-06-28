import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'agents-rules-test-secret';

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
    const owner = await register(baseUrl, 'owner');
    const pmUser = await register(baseUrl, 'pm');
    const workerUser = await register(baseUrl, 'wk');

    const project = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'Agents Rules Test', description: 'AGENTS.md main-agent maintenance', visibility: 'public',
    });
    check('create project', project.status, 201);
    const projectId = project.data.id;

    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: pmUser.userId, role: 'member' });
    await api(baseUrl, 'POST', `/v1/projects/${projectId}/members`, owner.token, { user_id: workerUser.userId, role: 'member' });

    const pmAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, pmUser.token, { name: 'pm-agent' });
    const pmKey = pmAgent.data.api_key;
    const workerAgent = await api(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, workerUser.token, { name: 'worker-agent' });
    const workerKey = workerAgent.data.api_key;
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', pmKey, {});
    await apiWithKey(baseUrl, 'POST', '/v1/agents/heartbeat', workerKey, {});

    // Promote pmAgent to project main agent.
    await api(baseUrl, 'PATCH', `/v1/projects/${projectId}`, owner.token, { main_agent_id: pmAgent.data.id });

    const RULES = '# AGENTS.md\n\n- Use conventional commits.\n- Deliverables go under deliverables/<agent>/.\n- Escalate to the main agent when blocked.\n';

    // ── 1. Worker CANNOT write AGENTS.md (outside deliverables/, not main agent) ─
    const writeByWorker = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/files`, workerKey, {
      path: 'AGENTS.md', content: RULES, message: 'worker tries rules',
    });
    check('worker denied writing AGENTS.md', writeByWorker.status, 403);

    // ── 2. Project main agent CAN write AGENTS.md ────────────────────────
    const writeByPm = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/files`, pmKey, {
      path: 'AGENTS.md', content: RULES, message: 'initial project rules',
    });
    check('main agent writes AGENTS.md (deliverables/ exception)', writeByPm.status, 201);
    const baseRevisionId = writeByPm.data.revision?.id;
    check('write returns revision id', typeof baseRevisionId === 'string', true);

    // ── 3. Worker CANNOT write a random privileged path (still locked to deliverables/) ─
    const writeOther = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/files`, pmKey, {
      path: 'README.md', content: 'no', message: 'main tries non-rules path',
    });
    check('main agent still locked out of other privileged paths (only AGENTS.md exempt)', writeOther.status, 403);

    // ── 4. Anyone can READ the rules (worker reads via /agents-rules) ────
    const readByWorker = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents-rules`, workerKey);
    check('worker reads agents-rules', readByWorker.status, 200);
    check('rules content matches', readByWorker.data.content, RULES);
    check('rules path', readByWorker.data.path, 'AGENTS.md');

    // ── 5. agents-rules 404 when absent ──────────────────────────────────
    const otherProject = await api(baseUrl, 'POST', '/v1/projects', owner.token, {
      name: 'No Rules Project', visibility: 'public',
    });
    const absent = await api(baseUrl, 'GET', `/v1/projects/${otherProject.data.id}/agents-rules`, owner.token);
    check('agents-rules 404 when no AGENTS.md', absent.status, 404);

    // ── 6. Update AGENTS.md (upsert) — main agent can revise (needs base_revision_id) ──
    const REVISED = RULES + '- Ping the main agent every 30s.\n';
    const updateByPm = await apiWithKey(baseUrl, 'POST', `/v1/projects/${projectId}/files`, pmKey, {
      path: 'AGENTS.md', content: REVISED, message: 'revise rules', base_revision_id: baseRevisionId,
    });
    check('main agent updates AGENTS.md (upsert)', updateByPm.status, 200);
    const reRead = await apiWithKey(baseUrl, 'GET', `/v1/projects/${projectId}/agents-rules`, workerKey);
    check('revised content reflected', reRead.data.content, REVISED);

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
    if (failed > 0) process.exit(1);
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
    password: 'AgentsRules123!', display_name: prefix,
  });
  assert.equal(response.status, 201);
  return { token: response.data.access_token, userId: response.data.user.id };
}

async function api(baseUrl: string, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

async function apiWithKey(baseUrl: string, method: string, path: string, apiKey: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': apiKey };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

main().catch((err) => { console.error(err); process.exit(1); });
