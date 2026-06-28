/**
 * Demo: Customer Support Multi-Agent Swarm
 *
 * Simulates a customer support scenario with three agents collaborating:
 *   - triage-bot: Classifies incoming questions by category and urgency
 *   - faq-bot: Answers frequently asked questions automatically
 *   - escalation-bot: Handles complex issues requiring human escalation
 *
 * Usage:
 *   1. Start the backend: npx tsx src/index.ts
 *   2. Run this demo:    npx tsx demo/demo-customer-support-swarm.ts
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
const DEMO_EMAIL = `support-demo-${Date.now()}@example.com`;
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
  console.log('║    Customer Support Multi-Agent Swarm Demo              ║');
  console.log('║    Agents: triage-bot, faq-bot, escalation-bot          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // ─── Step 1: Register & Login ──────────────────────────────────────────
  logSection('Step 1: User Registration & Auth');

  logStep('Registering demo user', DEMO_EMAIL);
  const regRes = await api('POST', '/v1/auth/register', undefined, {
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    display_name: 'Support Demo User',
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

  logStep('Creating project "support-demo"');
  const projRes = await api('POST', '/v1/projects', token, {
    name: 'support-demo',
    description: 'Demo project for multi-agent customer support collaboration',
  });

  if (projRes.status !== 201) {
    console.error('  ❌ Project creation failed:', projRes.data);
    process.exit(1);
  }
  const projectId: string = projRes.data.id;
  console.log('  ✅ Project created');
  logJson('Project', { id: projectId, name: projRes.data.name });

  // ─── Step 3: Create Agents ─────────────────────────────────────────────
  logSection('Step 3: Create Support Agents');

  // Agent 1: Triage Bot
  logStep('Creating triage-bot');
  const triageRes = await api(
    'POST',
    `/v1/projects/${projectId}/agents`,
    token,
    {
      name: 'triage-bot',
      description: 'Classifies customer inquiries by category and urgency level',
      system_prompt:
        'You are a triage agent. Analyze customer messages and classify them as: billing, technical, general, or escalation-needed.',
    },
  );
  if (triageRes.status !== 201) {
    console.error('  ❌ triage-bot creation failed:', triageRes.data);
    process.exit(1);
  }
  const triageAgent: AgentResponse = triageRes.data;
  console.log('  ✅ triage-bot created');
  logJson('triage-bot', { id: triageAgent.id, name: triageAgent.name });

  // Agent 2: FAQ Bot
  logStep('Creating faq-bot');
  const faqRes = await api(
    'POST',
    `/v1/projects/${projectId}/agents`,
    token,
    {
      name: 'faq-bot',
      description: 'Answers frequently asked questions from the knowledge base',
      system_prompt:
        'You are a FAQ agent. Provide concise answers from the knowledge base. If the question is complex, flag for escalation.',
    },
  );
  if (faqRes.status !== 201) {
    console.error('  ❌ faq-bot creation failed:', faqRes.data);
    process.exit(1);
  }
  const faqAgent: AgentResponse = faqRes.data;
  console.log('  ✅ faq-bot created');
  logJson('faq-bot', { id: faqAgent.id, name: faqAgent.name });

  // Agent 3: Escalation Bot
  logStep('Creating escalation-bot');
  const escalationRes = await api(
    'POST',
    `/v1/projects/${projectId}/agents`,
    token,
    {
      name: 'escalation-bot',
      description: 'Handles complex issues requiring human agent escalation',
      system_prompt:
        'You are an escalation agent. Gather context, summarize the issue, and prepare handoff notes for human agents.',
    },
  );
  if (escalationRes.status !== 201) {
    console.error('  ❌ escalation-bot creation failed:', escalationRes.data);
    process.exit(1);
  }
  const escalationAgent: AgentResponse = escalationRes.data;
  console.log('  ✅ escalation-bot created');
  logJson('escalation-bot', { id: escalationAgent.id, name: escalationAgent.name });

  // ─── Step 4: Create Session ────────────────────────────────────────────
  logSection('Step 4: Create Session');

  logStep('Creating support session with all 3 agents');
  const sessRes = await api(
    'POST',
    `/v1/projects/${projectId}/sessions`,
    token,
    {
      title: 'Customer Support Session #1001',
      agent_ids: [triageAgent.id, faqAgent.id, escalationAgent.id],
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

  // ─── Step 5: Scenario - Simple FAQ Question ────────────────────────────
  logSection('Scenario A: Simple FAQ Question');

  logStep('User asks a simple question');
  await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    { content: 'How do I reset my password?' },
  );
  console.log('  ✅ User message sent');

  logStep('triage-bot classifies the question');
  await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[triage-bot] 🏷️ Classification:\n- Category: technical\n- Urgency: LOW\n- Confidence: 95%\n- Recommended handler: faq-bot\n- Reason: Standard password reset procedure',
    },
  );
  console.log('  ✅ Triage complete');

  logStep('faq-bot answers the question');
  await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[faq-bot] 💡 To reset your password:\n\n1. Go to the login page\n2. Click "Forgot Password"\n3. Enter your email address\n4. Check your inbox for the reset link\n5. Click the link and set a new password\n\nThe reset link expires in 24 hours. Need more help?',
    },
  );
  console.log('  ✅ FAQ answer delivered');

  // ─── Step 6: Scenario - Complex Escalation ─────────────────────────────
  logSection('Scenario B: Complex Issue → Escalation');

  logStep('User reports a complex billing issue');
  await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: 'I was charged twice for my subscription last month, and my account shows an incorrect plan. I also cannot access premium features despite paying. This is very frustrating!',
    },
  );
  console.log('  ✅ User complaint sent');

  logStep('triage-bot classifies the complex issue');
  await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[triage-bot] 🏷️ Classification:\n- Category: billing + technical\n- Urgency: HIGH\n- Confidence: 88%\n- Recommended handler: escalation-bot\n- Reason: Billing discrepancy with access issues requires manual review\n- Escalation needed: YES',
    },
  );
  console.log('  ✅ Triage flagged for escalation');

  logStep('escalation-bot gathers context and prepares handoff');
  await api(
    'POST',
    `/v1/projects/${projectId}/sessions/${session.id}/messages`,
    token,
    {
      content: '[escalation-bot] 🚨 Escalation Case #ESC-2024-089\n\n📋 Summary:\n- Issue: Double charge + incorrect plan + access denial\n- Severity: HIGH\n- Customer sentiment: Frustrated\n\n📝 Context Gathered:\n- Last payment: Duplicate detected\n- Current plan: Shows basic (should be premium)\n- Feature access: Premium features locked\n\n👤 Handoff Notes for Human Agent:\n- Verify double charge in billing system\n- Correct plan assignment\n- Confirm premium feature access restored\n- Consider goodwill gesture for inconvenience\n\n⏳ Estimated response time: 15-30 minutes',
    },
  );
  console.log('  ✅ Escalation case prepared');

  // ─── Step 7: View Complete Conversation ────────────────────────────────
  logSection('Step 7: Complete Conversation History');

  const detailRes = await api(
    'GET',
    `/v1/projects/${projectId}/sessions/${session.id}`,
    token,
  );

  if (detailRes.status === 200) {
    const detail: SessionDetailResponse = detailRes.data;
    console.log(`\n  📨 Session: "${detail.title}" (${detail.messages.length} messages)`);
    console.log('  ──────────────────────────────────────────────────────────');

    for (const msg of detail.messages) {
      const time = new Date(msg.created_at).toLocaleTimeString();
      const preview = msg.content.substring(0, 100).replace(/\n/g, ' ');
      console.log(
        `  [${time}] ${msg.role.padEnd(6)} | ${preview}${msg.content.length > 100 ? '...' : ''}`,
      );
    }
  }

  // ─── Step 8: Agent Heartbeats ──────────────────────────────────────────
  logSection('Step 8: Agent Heartbeats');

  logStep('Sending heartbeats from all agents');
  for (const [name, apiKey, status] of [
    ['triage-bot', triageAgent.api_key, 'active'] as const,
    ['faq-bot', faqAgent.api_key, 'active'] as const,
    ['escalation-bot', escalationAgent.api_key, 'idle'] as const,
  ]) {
    const hbRes = await fetch(`${BASE_URL}/v1/agents/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({ status }),
    });
    const hbData = (await hbRes.json()) as any;
    console.log(`  ✅ ${name}: ok=${hbData.ok}`);
  }

  // ─── Step 9: SSE Event Stream ──────────────────────────────────────────
  logSection('Step 9: SSE Event Stream');

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
  Project:     support-demo (${projectId.substring(0, 8)}...)
  Agents:      3 (triage-bot, faq-bot, escalation-bot)
  Session:     "${session.title}"

  Scenario A:  Simple FAQ → triage → faq-bot answers ✅
  Scenario B:  Complex issue → triage → escalation-bot handles ✅

  Message flow:
    User Question → triage-bot (classify)
                   ├→ faq-bot (simple answers)
                   └→ escalation-bot (complex issues)

  ✅ All steps completed successfully!
  `);
}

main().catch((err) => {
  console.error('\n❌ Demo failed:', err);
  process.exit(1);
});
