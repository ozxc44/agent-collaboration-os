// Throwaway reproduction: does GET /overview with an UNASSIGNED agent key crash?
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'repro-unassigned-secret';

const http = require('node:http');

async function api(baseUrl, method, path, { token, apiKey, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, data };
}

async function main() {
  const { AppDataSource } = require('./src/data-source');
  const app = require('./src/app').default;
  await AppDataSource.initialize();
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Register owner + create project
    const reg = await api(baseUrl, 'POST', '/v1/auth/register', {
      body: {
        email: `repro-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`,
        password: 'ReproTest123!',
        display_name: 'repro-owner',
      },
    });
    if (reg.status !== 201) throw new Error('register failed: ' + reg.status);
    const token = reg.data.access_token;

    const proj = await api(baseUrl, 'POST', '/v1/projects', { token, body: { name: 'Repro Project', visibility: 'public' } });
    if (proj.status !== 201) throw new Error('create project failed: ' + proj.status);
    const pid = proj.data.id;

    // Create ONE agent with NO orchestrations and NO task assignments
    const agent = await api(baseUrl, 'POST', `/v1/projects/${pid}/agents`, { token, body: { name: 'Lonely Agent' } });
    if (agent.status !== 201) throw new Error('create agent failed: ' + agent.status);
    const apiKey = agent.data.api_key;
    const agentId = agent.data.id;

    console.log(`Created project ${pid}, unassigned agent ${agentId}`);
    console.log('Calling GET /overview with the unassigned agent API key...');

    const ov = await api(baseUrl, 'GET', `/v1/projects/${pid}/overview`, { apiKey });

    console.log(`\n>>> STATUS: ${ov.status}`);
    if (ov.status === 500) {
      console.log('>>> REPRODUCED: HTTP 500 (empty-IN crash confirmed)');
      console.log('>>> body:', JSON.stringify(ov.data));
      process.exitCode = 2; // signal "bug reproduced"
    } else if (ov.status === 200) {
      console.log('>>> NOT reproduced: HTTP 200 — overview succeeded for unassigned agent');
      console.log('>>> summary:', JSON.stringify(ov.data.summary));
      process.exitCode = 0;
    } else {
      console.log('>>> UNEXPECTED status:', ov.status, JSON.stringify(ov.data));
      process.exitCode = 1;
    }
  } finally {
    await new Promise((r) => server.close(r));
    await AppDataSource.destroy();
  }
}

main().catch((err) => { console.error('SCRIPT ERROR:', err); process.exit(1); });
