/**
 * Demo: Code Review Multi-Agent Swarm
 *
 * Simulates a code review scenario with two agents collaborating:
 *   - reviewer-bot: Reviews code submissions and provides feedback
 *   - auto-approve-bot: Handles trivial / low-risk changes automatically
 *
 * Usage:
 *   1. Start the backend: npx tsx src/index.ts
 *   2. Run this demo:    npx tsx demo/demo-code-review-swarm.ts
 */

import 'reflect-metadata';

// ─── Types from backend entities ─────────────────────────────────────────────
interface AgentResponse {
  id: string;
  project_id: string;
  name: string;
  description: string;
  status: string;
  api_key: string;
  api_key_prefix: string;
  created_at: string;
  updated_at: string;
}

interface SessionResponse {
  id: string;
  project_id: string;
  title: string;
  agent_ids: string[];
  status: string;
  created_by: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MessageResponse {
  id: string;
  role: string;
  content: string;
  session_id: string;
  agent_id: string | null;
  user_id: string | null;
  created_at: string;
}

interface SessionDetailResponse {
  id: string;
  project_id: string;
  title: string;
  agent_ids: string[];
  status: string;
  messages: MessageResponse[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const DEMO_EMAIL = `code-review-demo-${Date.now()}@example.com`;
const DEMO_PASSWORD = 'demo-password-123';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function api(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
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

function logSection(title: string) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(60)}`);
}

function logStep(step: string, detail?: string) {
  console.log(`\n▶ ${step}`);
  if (detail) console.log(`  ${detail}`);
}

function logJson(label: string, obj: any) {
  console.log(`  📋 ${label}:`);
  console.log(`    ${JSON.stringify(obj, null, 2).replace(/\n/g, '\n    ')}`);
}

// ─── Main Demo Flow ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║    Code Review Multi-Agent Swarm Demo                   ║');
  console.log('║    Agents: reviewer-bot, auto-approve-bot               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // ─── Step 1: Register & Login ──────────────────────────────────────────
  logSection('Step 1: User Registration & Auth');

  logStep('Registering demo user', DEMO_EMAIL);
  const regRes = await api('POST', '/v1/auth/register', undefined, {
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    display_name: 'Code Review Demo User',
  });

  if (regRes.status !== 201) {
    console.error('  ❌ Registration failed:', regRes.data);
    process.exit(1);
  }
  const token: string = regRes.data.access_token;
  const userId: string = regRes.data.user.id;
  console.log('  ✅ User registered');
  logJson('User', { id: userId, email: DEMO_EMAIL });

  // ─── Step 2: Create Project ────────────────────────────────────────────
  logSection('Step 2: Create Project');

  logStep('Creating project "code-review-demo"');
  const projRes = await api('POST', '/v1/projects', token, {
    name: 'code-review-demo',
    description: 'Demo project for multi-agent code review collaboration',
  });

  if (projRes.status !== 201) {
    console.error('  ❌ Project creation failed:', projRes.data);
    process.exit(1);
  }
  const projectId: string = projRes.data.id;
  console.log('  ✅ Project created');
  logJson('Project', { id: projectId, name: projRes.data.name });

  // ─── Step 3: Create Agents ─────────────────────────────────────────────
  logSection('Step 3: Create Agents');

  logStep('Creating reviewer-bot agent');
  const reviewerRes = await api(
    'POST',
    `/v1/projects/${projectId}/agents`,
    token,
    {
      name: 'reviewer-bot',
      description: 'Reviews code submissions for quality, security, and best practices',
      system_prompt: 'You are a senior code reviewer. Analyze code for bugs, security issues, and suggest improvements.',
    },
  );

  if (reviewerRes.status !== 201) {
    console.error('  ❌ reviewer-bot creation failed:', reviewerRes.data);
    process.exit(1);
  }
  const reviewerAgent: AgentResponse = reviewerRes.data;
  const reviewerApiKey: string = reviewerRes.data.api_key;
  console.log('  ✅ reviewer-bot created');
  logJson('reviewer-bot', {
    id: reviewerAgent.id,
    name: reviewerAgent.name,
    status: reviewerAgent.status,
  });

  logStep('Creating auto-approve-bot agent');
  const approveRes = await api(
    'POST',
    `/v1/projects/${projectId}/agents`,
    token,
    {
      name: 'auto-approve-bot',
      description: 'Automatically approves trivial changes like README updates and typo fixes',
      system_prompt: 'You approve simple, low-risk changes automatically. Only flag complex or risky changes for human review.',
    },
  );

  if (approveRes.status !== 201) {
    console.error('  ❌ auto-approve-bot creation failed:', approveRes.data);
    process.exit(1);
  }
  const approveAgent: AgentResponse = approveRes.data;
  const approveApiKey: string = approveRes.data.api_key;
  console.log('  ✅ auto-approve-bot created');
  logJson('auto-approve-bot', {
    id: approveAgent.id,
    name: approveAgent.name,
    status: approveAgent.status,
  });

  // ─── Step 4: Create Session ────────────────────────────────────────────
  logSection('Step 4: Create Session');

  logStep('Creating session with both agents');
  const sessRes = await api(
    'POST',
    `/v1/projects/${projectId}/sessions`,
    token,
    {
      title: 'PR #42: Fix authentication middleware',
      agent_ids: [reviewerAgent.id, approveAgent.id],
    },
  );

  if (sessRes.status !== 201) {
    console.error('  ❌ Session creation failed:', sessRes.data);
    process.exit(1);
  }
  const session: SessionResponse = sessRes.data;
  console.log('  ✅ Session created');
  logJson('Session', {
    id: session.id,
    title: session.title,
    agents: session.agent_ids.length,
  });

  // ─── Step 5: Simulate Code Review Message Flow ─────────────────────────
  logSection('Step 5: Simulate Code Review Flow');

  // Message 1: User submits code for review
  logStep('Message 1 → User submits PR for review');
  const msg1Res = await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[PR #42] Fixed auth middleware - added JWT expiry validation and rate limiting. Changes: src/middleware/auth.ts (42 lines changed)',
    },
  );
  console.log(
    `  ✅ Message sent (id: ${msg1Res.data.id?.substring(0, 8)}...)`,
  );

  // Message 2: reviewer-bot reviews the code
  logStep('Message 2 → reviewer-bot analyzes the PR');
  const msg2Res = await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[reviewer-bot] 🔍 Code Review Results:\n\n✅ JWT expiry validation - Good implementation\n⚠️ Rate limiting: Consider using sliding window instead of fixed window\n❌ Missing error handling for token refresh edge case\n\nSuggestion: Add unit tests for the new validation logic.',
    },
  );
  console.log(
    `  ✅ Reviewer feedback sent (id: ${msg2Res.data.id?.substring(0, 8)}...)`,
  );

  // Message 3: auto-approve-bot checks risk level
  logStep('Message 3 → auto-approve-bot evaluates risk level');
  const msg3Res = await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[auto-approve-bot] Risk Assessment: MEDIUM\n\n42 lines changed in auth middleware. Requires manual review due to security sensitivity. Auto-approve not recommended for this PR.',
    },
  );
  console.log(
    `  ✅ Risk assessment sent (id: ${msg3Res.data.id?.substring(0, 8)}...)`,
  );

  // Message 4: User addresses review feedback
  logStep('Message 4 → User addresses review feedback');
  const msg4Res = await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[Author] Updated PR based on review:\n- Switched to sliding window rate limiter\n- Added error handling for token refresh\n- Added 12 unit tests\n\nPlease re-review.',
    },
  );
  console.log(
    `  ✅ Follow-up message sent (id: ${msg4Res.data.id?.substring(0, 8)}...)`,
  );

  // Message 5: reviewer-bot approves
  logStep('Message 5 → reviewer-bot approves after fixes');
  const msg5Res = await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[reviewer-bot] ✅ LGTM! All issues addressed. Sliding window implementation looks solid. Tests cover edge cases well.\n\nRecommended: Approve and merge.',
    },
  );
  console.log(
    `  ✅ Approval sent (id: ${msg5Res.data.id?.substring(0, 8)}...)`,
  );

  // Message 6: auto-approve-bot gives final approval
  logStep('Message 6 → auto-approve-bot gives final approval');
  const msg6Res = await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[auto-approve-bot] ✅ Auto-approved\n\nRisk level lowered to LOW after reviewer approval. All checks passed. Ready to merge.',
    },
  );
  console.log(
    `  ✅ Final approval sent (id: ${msg6Res.data.id?.substring(0, 8)}...)`,
  );

  // ─── Step 6: View Complete Message History ─────────────────────────────
  logSection('Step 6: Complete Message History');

  logStep('Fetching session with all messages');
  const detailRes = await api(
    'GET',
    `/v1/projects/${projectId}/sessions/${session.id}`,
    token,
  );

  if (detailRes.status === 200) {
    const detail: SessionDetailResponse = detailRes.data;
    console.log(`\n  📨 Session: "${detail.title}" (${detail.messages.length} messages)`);
    console.log('  ────────────────────────────────────────────────────');

    for (const msg of detail.messages) {
      const time = new Date(msg.created_at).toLocaleTimeString();
      const preview = msg.content.substring(0, 80).replace(/\n/g, ' ');
      console.log(`  [${time}] ${msg.role.padEnd(6)} | ${preview}${msg.content.length > 80 ? '...' : ''}`);
    }
  }

  // ─── Step 7: Agent Heartbeats ──────────────────────────────────────────
  logSection('Step 7: Agent Heartbeats');

  logStep('Sending heartbeat from reviewer-bot');
  const hb1Res = await fetch(`${BASE_URL}/v1/agents/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': reviewerApiKey,
    },
    body: JSON.stringify({
      status: 'active',
      metadata: { reviews_completed: 1, queue_size: 0 },
    }),
  });
  const hb1Data = (await hb1Res.json()) as any;
  console.log(`  ✅ reviewer-bot heartbeat: ok=${hb1Data.ok}`);

  logStep('Sending heartbeat from auto-approve-bot');
  const hb2Res = await fetch(`${BASE_URL}/v1/agents/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': approveApiKey,
    },
    body: JSON.stringify({
      status: 'idle',
      metadata: { approvals_today: 5, auto_approved: 3 },
    }),
  });
  const hb2Data = (await hb2Res.json()) as any;
  console.log(`  ✅ auto-approve-bot heartbeat: ok=${hb2Data.ok}`);

  // ─── Step 8: SSE Event Stream ──────────────────────────────────────────
  logSection('Step 8: SSE Event Stream');

  logStep('Connecting to SSE event stream (5s)...');
  try {
    const sseRes = await fetch(
      `${BASE_URL}/v1/sessions/${session.id}/stream`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (sseRes.status === 200) {
      console.log('  ✅ SSE connected, reading events...');
      const reader = sseRes.body?.getReader();
      if (reader) {
        const timeout = setTimeout(() => {
          reader.cancel();
          console.log('  📡 SSE stream closed after timeout');
        }, 5000);

        const decoder = new TextDecoder();
        let eventCount = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter((l) => l.trim());
            for (const line of lines) {
              if (line.startsWith('data:')) {
                eventCount++;
                const dataStr = line.substring(5).trim();
                try {
                  const eventData = JSON.parse(dataStr);
                  console.log(
                    `  📡 Event #${eventCount}: type=${eventData.type || 'unknown'}`,
                  );
                } catch {
                  console.log(`  📡 Event #${eventCount}: ${dataStr.substring(0, 60)}`);
                }
              } else if (line.startsWith('event:')) {
                console.log(`  📡 Event type: ${line.substring(6).trim()}`);
              }
            }
          }
        } catch {
          // Reader cancelled
        }
        clearTimeout(timeout);
        console.log(`  📊 Received ${eventCount} events from SSE stream`);
      }
    } else {
      console.log(`  ⚠️ SSE connection returned status ${sseRes.status}`);
    }
  } catch (err) {
    console.log(`  ⚠️ SSE stream error: ${err}`);
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  logSection('Demo Complete!');

  console.log(`
  📊 Summary:
  ───────────────────────────────────────────
  Project:     code-review-demo (${projectId.substring(0, 8)}...)
  Agents:      2 (reviewer-bot, auto-approve-bot)
  Session:     "${session.title}"
  Messages:    6 (simulated code review flow)
  Flow:        Submit → Review → Risk Assess → Fix → Approve → Auto-approve

  ✅ All steps completed successfully!
  `);
}

main().catch((err) => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});
