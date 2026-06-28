/**
 * End-to-End API Test Suite
 *
 * Tests 11 core API flows using pure Node.js fetch.
 * Each test prints ✅ or ❌, with a summary at the end.
 *
 * Usage:
 *   1. Start the backend: npx tsx src/index.ts
 *   2. Run tests:        npx tsx tests/e2e-api.test.ts
 */

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const TEST_EMAIL = `e2e-test-${Date.now()}@example.com`;
const TEST_PASSWORD = 'test-password-123';
const TEST_EMAIL_2 = `e2e-test-2-${Date.now()}@example.com`;
const TEST_PASSWORD_2 = 'test-password-456';

// ─── Test State ──────────────────────────────────────────────────────────────

const results: Record<string, { name: string; passed: boolean; detail?: string }> = {};
let token = '';
let userId = '';
let projectId = '';
let agentId = '';
let agentApiKey = '';
let sessionId = '';
let messageId = '';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ApiResult {
  status: number;
  data: any;
}

async function api(
  method: string,
  path: string,
  authToken?: string,
  body?: unknown,
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function apiWithApiKey(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function pass(name: string, detail?: string) {
  results[name] = { name, passed: true, detail };
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string) {
  results[name] = { name, passed: false, detail };
  console.log(`  ❌ ${name} — ${detail}`);
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function test1_RegisterAndGetToken() {
  section('Test 1: Register User → Get Token');

  // Register
  const regRes = await api('POST', '/v1/auth/register', undefined, {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    display_name: 'E2E Test User',
  });

  if (regRes.status !== 201) {
    fail('Register user', `Expected 201, got ${regRes.status}: ${JSON.stringify(regRes.data)}`);
    return;
  }
  if (!regRes.data.access_token) {
    fail('Register user', 'No access_token in response');
    return;
  }

  token = regRes.data.access_token;
  userId = regRes.data.user.id;
  pass('Register user', `email=${TEST_EMAIL}, userId=${userId.substring(0, 8)}...`);

  // Login (get token)
  const loginRes = await api('POST', '/v1/auth/token', undefined, {
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });

  if (loginRes.status !== 200 || !loginRes.data.access_token) {
    fail('Login (get token)', `Expected 200 with token, got ${loginRes.status}`);
    return;
  }
  pass('Login (get token)', `token_type=${loginRes.data.token_type}`);
}

async function test2_CreateProject() {
  section('Test 2: Create Project');

  const res = await api('POST', '/v1/projects', token, {
    name: 'e2e-test-project',
    description: 'Project created by E2E test suite',
  });

  if (res.status !== 201) {
    fail('Create project', `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    return;
  }
  if (!res.data.id) {
    fail('Create project', 'No project id in response');
    return;
  }

  projectId = res.data.id;
  pass('Create project', `id=${projectId.substring(0, 8)}..., name="${res.data.name}"`);
}

async function test3_AddMember() {
  section('Test 3: Add Member');

  // First register a second user
  const regRes = await api('POST', '/v1/auth/register', undefined, {
    email: TEST_EMAIL_2,
    password: TEST_PASSWORD_2,
    display_name: 'E2E Test User 2',
  });

  if (regRes.status !== 201) {
    fail('Add member (register user 2)', `Expected 201, got ${regRes.status}`);
    return;
  }
  const userId2 = regRes.data.user.id;

  // Add second user as member
  const addRes = await api(
    'POST',
    `/v1/projects/${projectId}/members`,
    token,
    { user_id: userId2, role: 'member' },
  );

  if (addRes.status !== 201) {
    fail('Add member', `Expected 201, got ${addRes.status}: ${JSON.stringify(addRes.data)}`);
    return;
  }

  pass('Add member', `user_id=${userId2.substring(0, 8)}..., role=member`);

  // Verify member is listed
  const listRes = await api('GET', `/v1/projects/${projectId}/members`, token);
  if (listRes.status !== 200) {
    fail('List members', `Expected 200, got ${listRes.status}`);
    return;
  }

  const memberCount = listRes.data.data?.length || 0;
  pass('List members', `count=${memberCount}`);
}

async function test4_CreateAgent() {
  section('Test 4: Create Agent');

  const res = await api(
    'POST',
    `/v1/projects/${projectId}/agents`,
    token,
    {
      name: 'test-agent',
      description: 'Agent created by E2E test suite',
      system_prompt: 'You are a test assistant.',
      endpoint_url: 'http://localhost:9001/zz/v1/invoke',
      invoke_secret: 'test-invoke-secret-at-least-16-chars',
    },
  );

  if (res.status !== 201) {
    fail('Create agent', `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    return;
  }
  if (!res.data.id || !res.data.api_key) {
    fail('Create agent', 'Missing id or api_key in response');
    return;
  }

  agentId = res.data.id;
  agentApiKey = res.data.api_key;
  if (res.data.endpoint_url !== 'http://localhost:9001/zz/v1/invoke') {
    fail('Create agent endpoint_url', `Expected endpoint_url in V1 response, got ${res.data.endpoint_url}`);
    return;
  }
  if ('invoke_secret' in res.data) {
    fail('Create agent secret redaction', 'invoke_secret must not be returned');
    return;
  }
  pass('Create agent', `id=${agentId.substring(0, 8)}..., name="${res.data.name}"`);
  pass('Agent API key', `prefix=${res.data.api_key_prefix}`);
}

async function test5_CreateSession() {
  section('Test 5: Create Session');

  const res = await api(
    'POST',
    `/v1/projects/${projectId}/sessions`,
    token,
    {
      title: 'E2E Test Session',
      agent_ids: [agentId],
    },
  );

  if (res.status !== 201) {
    fail('Create session', `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    return;
  }
  if (!res.data.id) {
    fail('Create session', 'No session id in response');
    return;
  }

  sessionId = res.data.id;
  pass('Create session', `id=${sessionId.substring(0, 8)}..., title="${res.data.title}"`);
}

async function test6_SendMessage() {
  section('Test 6: Send Message');

  const res = await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${sessionId}/messages`,
    token,
    { content: 'Hello from E2E test!' },
  );

  if (res.status !== 201) {
    fail('Send message', `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    return;
  }
  if (!res.data.id) {
    fail('Send message', 'No message id in response');
    return;
  }

  messageId = res.data.id;
  pass('Send message', `id=${messageId.substring(0, 8)}..., role=${res.data.role}`);
}

async function test7_ListMessages() {
  section('Test 7: View Message List (Get Session)');

  const res = await api(
    'GET',
    `/v1/projects/${projectId}/sessions/${sessionId}`,
    token,
  );

  if (res.status !== 200) {
    fail('Get session (messages)', `Expected 200, got ${res.status}`);
    return;
  }

  const messages = res.data.messages || [];
  if (messages.length === 0) {
    fail('Get session messages', 'Expected at least 1 message, got 0');
    return;
  }

  const found = messages.some((m: any) => m.id === messageId);
  if (!found) {
    fail('Get session messages', `Message ${messageId.substring(0, 8)}... not found in list`);
    return;
  }

  pass('Get session with messages', `count=${messages.length}`);
}

async function test8_AgentHeartbeat() {
  section('Test 8: Agent Heartbeat');

  const res = await apiWithApiKey(
    'POST',
    '/v1/agents/heartbeat',
    agentApiKey,
    {
      status: 'active',
      metadata: { test: true, cpu: 45, memory: 60 },
    },
  );

  if (res.status !== 200) {
    fail('Agent heartbeat', `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    return;
  }
  if (!res.data.ok) {
    fail('Agent heartbeat', 'Expected ok=true');
    return;
  }

  pass('Agent heartbeat', `ok=${res.data.ok}, next_heartbeat_at=${res.data.next_heartbeat_at}`);
}

async function test9_QueryAgentHealth() {
  section('Test 9: Query Agent Health');

  const res = await api('GET', `/v1/agents/${agentId}/health`, token);

  if (res.status !== 200) {
    fail('Query agent health', `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
    return;
  }

  pass('Query agent health', `status=${res.data.status}, open_incidents=${res.data.open_incidents}`);

  // Also verify health fields
  if (typeof res.data.uptime_seconds !== 'number') {
    fail('Health uptime_seconds', 'Expected number');
    return;
  }
  pass('Health uptime', `${res.data.uptime_seconds}s`);
}

async function test9b_V1AgentRootAndHealthContract() {
  section('Test 9b: V1 Agent Root + Health Contract');

  const getRes = await api('GET', `/v1/agents/${agentId}`, token);
  if (getRes.status !== 200) {
    fail('Root get agent', `Expected 200, got ${getRes.status}: ${JSON.stringify(getRes.data)}`);
    return;
  }
  if (getRes.data.endpoint_url !== 'http://localhost:9001/zz/v1/invoke') {
    fail('Root get agent endpoint_url', `Unexpected endpoint_url=${getRes.data.endpoint_url}`);
    return;
  }
  if ('invoke_secret' in getRes.data) {
    fail('Root get secret redaction', 'invoke_secret must not be returned');
    return;
  }
  pass('Root get agent', `endpoint_url=${getRes.data.endpoint_url}`);

  const patchRes = await api('PATCH', `/v1/agents/${agentId}`, token, {
    endpoint_url: 'http://localhost:9002/zz/v1/invoke',
    system_prompt: 'Updated V1 test prompt.',
  });
  if (patchRes.status !== 200) {
    fail('Root patch agent', `Expected 200, got ${patchRes.status}: ${JSON.stringify(patchRes.data)}`);
    return;
  }
  if (patchRes.data.endpoint_url !== 'http://localhost:9002/zz/v1/invoke') {
    fail('Root patch endpoint_url', `Unexpected endpoint_url=${patchRes.data.endpoint_url}`);
    return;
  }
  pass('Root patch agent', `endpoint_url=${patchRes.data.endpoint_url}`);

  const healthPostRes = await api('POST', `/v1/agents/${agentId}/health`, token, {
    status: 'healthy',
    run_id: 'run_e2e_v1_health',
    latency_ms: 123,
    metrics: [{ name: 'tokens_output', value: 42, unit: 'tokens' }],
    observed_at: new Date().toISOString(),
  });
  if (healthPostRes.status !== 202) {
    fail('Post V1 agent health', `Expected 202, got ${healthPostRes.status}: ${JSON.stringify(healthPostRes.data)}`);
    return;
  }
  if (healthPostRes.data.agent_id !== agentId || !Array.isArray(healthPostRes.data.metrics)) {
    fail('Post V1 agent health snapshot', 'Missing agent_id or metrics array');
    return;
  }
  pass('Post V1 agent health', `status=${healthPostRes.data.status}`);

  const healthGetRes = await api('GET', `/v1/health?agent_id=${agentId}`);
  if (healthGetRes.status !== 200) {
    fail('Get V1 health by agent', `Expected 200, got ${healthGetRes.status}: ${JSON.stringify(healthGetRes.data)}`);
    return;
  }
  if (healthGetRes.data.agent_id !== agentId || !healthGetRes.data.checked_at) {
    fail('Get V1 health snapshot', 'Missing agent_id or checked_at');
    return;
  }
  pass('Get V1 health by agent', `status=${healthGetRes.data.status}`);
}

async function test10_ListProjectAgents() {
  section('Test 10: List Project Agents');

  const res = await api(
    'GET',
    `/v1/projects/${projectId}/agents`,
    token,
  );

  if (res.status !== 200) {
    fail('List project agents', `Expected 200, got ${res.status}`);
    return;
  }

  const agents = res.data.data || [];
  const total = res.data.meta?.total || 0;

  if (agents.length === 0 || total === 0) {
    fail('List project agents', 'Expected at least 1 agent');
    return;
  }

  const found = agents.some((a: any) => a.id === agentId);
  if (!found) {
    fail('List project agents', `Agent ${agentId.substring(0, 8)}... not found in list`);
    return;
  }

  pass('List project agents', `count=${total}`);
}

async function test11_SSEEventStream() {
  section('Test 11: SSE Event Stream');

  try {
    const sseRes = await fetch(
      `${BASE_URL}/v1/sessions/${sessionId}/stream`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (sseRes.status !== 200) {
      fail('SSE connect', `Expected 200, got ${sseRes.status}`);
      return;
    }

    const contentType = sseRes.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      fail('SSE content-type', `Expected text/event-stream, got ${contentType}`);
      return;
    }

    pass('SSE connect', `status=200, content-type=${contentType}`);

    // Read a few events then close
    const reader = sseRes.body?.getReader();
    if (!reader) {
      fail('SSE reader', 'No readable stream');
      return;
    }

    const timeout = setTimeout(() => {
      reader.cancel();
    }, 3000);

    let gotHeartbeat = false;
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk.includes(': heartbeat') || chunk.includes('data:')) {
          gotHeartbeat = true;
        }
      }
    } catch {
      // Reader cancelled by timeout
    }
    clearTimeout(timeout);

    pass('SSE stream read & close', gotHeartbeat ? 'received data from stream' : 'connected and closed cleanly');
  } catch (err) {
    fail('SSE event stream', `${err}`);
  }
}

// ─── Bonus: Health Endpoint (no auth) ────────────────────────────────────────

async function testBonus_HealthEndpoint() {
  section('Bonus: Health Endpoint (no auth)');

  const res = await api('GET', '/v1/health');

  if (res.status !== 200) {
    fail('Health endpoint', `Expected 200, got ${res.status}`);
    return;
  }

  if (!res.data.status || !res.data.version) {
    fail('Health endpoint', 'Missing status or version');
    return;
  }

  pass('Health endpoint', `status=${res.data.status}, version=${res.data.version}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║    E2E API Test Suite                                   ║');
  console.log(`║    Target: ${BASE_URL.padEnd(46)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  const startTime = Date.now();
  let unhandledError: unknown = null;

  try {
    await testBonus_HealthEndpoint();
    await test1_RegisterAndGetToken();
    await test2_CreateProject();
    await test3_AddMember();
    await test4_CreateAgent();
    await test5_CreateSession();
    await test6_SendMessage();
    await test7_ListMessages();
    await test8_AgentHeartbeat();
    await test9_QueryAgentHealth();
    await test9b_V1AgentRootAndHealthContract();
    await test10_ListProjectAgents();
    await test11_SSEEventStream();
  } catch (err) {
    unhandledError = err;
    console.error(`\n❌ Unhandled error during tests: ${err}`);
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const allResults = Object.values(results);
  const passed = allResults.filter((r) => r.passed).length;
  const failed = allResults.filter((r) => !r.passed).length;
  const total = allResults.length;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║    Test Results Summary                                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n  Total:  ${total}`);
  console.log(`  Passed: ${passed} ✅`);
  console.log(`  Failed: ${failed} ❌`);
  console.log(`  Time:   ${elapsed}s`);

  if (failed > 0) {
    console.log('\n  Failed tests:');
    for (const r of allResults) {
      if (!r.passed) {
        console.log(`    ❌ ${r.name}: ${r.detail}`);
      }
    }
  }

  if (unhandledError || total === 0) {
    console.log('\n  ❌ Test suite did not complete. Ensure the backend is running or set API_URL.');
  }

  console.log(
    failed === 0 && !unhandledError && total > 0
      ? '\n  🎉 All tests passed!\n'
      : `\n  ⚠️  ${failed} test(s) failed.\n`,
  );

  process.exit(failed > 0 || unhandledError || total === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
