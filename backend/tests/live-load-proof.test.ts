import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Live / staging load proof entrypoint for Remaining Proof Gap #5.
 *
 * Targets a real deployed base URL supplied by the operator via BASE_URL.
 * It runs a bounded Golden-Path workload (register → project → agents →
 * orchestration → dispatch → claim → complete), measures poll/claim/complete/e2e
 * latencies, and writes a redacted JSON artifact.
 *
 * Safety invariants:
 *   - BASE_URL must be explicitly set (no implicit localhost fallback).
 *   - Non-localhost URLs require ALLOW_REMOTE_VERIFY=1 (layered opt-in guard).
 *   - Secrets are read from env only and never printed or written to artifacts.
 *   - Traffic is bounded by small defaults and can be further limited by env.
 *   - The script is NOT a destructive load test; it creates a small amount of
 *     throwaway test data and does not delete anything.
 *
 * Test hooks:
 *   LOAD_PROOF_FAIL_INBOX_GUARANTEES=1  Force inbox guarantee counters to zero
 *                                        so the probe exits non-zero with pass=false.
 *                                        Used by the negative regression test.
 *
 * Exit codes:
 *   0  load proof passed and artifact written with pass=true
 *   1  proof failed (runtime error, assertion failure, threshold exceeded,
 *      or inbox guarantees / latency conditions not met — artifact has pass=false)
 *   2  BLOCKED -- required env vars missing or remote opt-in not granted
 */

const E_OK = 0;
const E_PROOF_FAIL = 1;
const E_BLOCKED = 2;

interface ApiResponse {
  status: number;
  data: any;
}

interface TimedResponse extends ApiResponse {
  durationMs: number;
}

interface LatencySummary {
  p50: number;
  p95: number;
  p99: number;
}

interface LoadProofArtifact {
  schema_version: string;
  generated_at: string;
  target_base_url: string;
  target_host_redacted: string;
  environment: string;
  worker_count: number;
  tasks_per_worker: number;
  total_tasks: number;
  iterations: number;
  total_duration_ms: number;
  durations_ms: {
    poll: LatencySummary;
    claim: LatencySummary;
    complete: LatencySummary;
    e2e: LatencySummary;
  };
  inbox_guarantees: {
    every_task_ready_for_review: boolean;
    every_dispatched_item_leased: boolean;
  };
  pass: boolean;
  note: string;
}

function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.log('[live-load-proof]', ...args);
}

function err(...args: unknown[]) {
  // eslint-disable-next-line no-console
  console.error('[live-load-proof][ERROR]', ...args);
}

function blocked(...args: unknown[]): never {
  console.error('[live-load-proof][BLOCKED]', ...args);
  process.exit(E_BLOCKED);
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    // Keep host for artifact provenance, but drop credentials, path, query, hash.
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/`;
  } catch {
    return '[redacted]';
  }
}

function redactHostForDisplay(raw: string): string {
  try {
    const url = new URL(raw);
    return url.hostname;
  } catch {
    return '[invalid-url]';
  }
}

function isLocalBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1' ||
      /^127\.\d+\.\d+\.\d+$/.test(host)
    );
  } catch {
    return false;
  }
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    blocked(`missing required environment variable: ${name}`);
  }
  return value;
}

function getEnvInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    blocked(`invalid integer value for ${name}: ${value}`);
  }
  return parsed;
}

function redactTokenPrefix(token: string): string {
  if (!token) return '[none]';
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function redactApiKeyPrefix(apiKey: string): string {
  if (!apiKey) return '[none]';
  if (apiKey.length <= 12) return '***';
  return `${apiKey.slice(0, 8)}...`;
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
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

async function requestTimed(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<TimedResponse> {
  const start = performance.now();
  const result = await request(baseUrl, method, path, token, body);
  return { ...result, durationMs: performance.now() - start };
}

async function requestAgent(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-Key': apiKey,
  };
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
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

async function requestAgentTimed(
  baseUrl: string,
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<TimedResponse> {
  const start = performance.now();
  const result = await requestAgent(baseUrl, method, path, apiKey, body);
  return { ...result, durationMs: performance.now() - start };
}

async function getOwnerToken(baseUrl: string): Promise<{ token: string; userId: string }> {
  const existingToken = process.env.LOAD_PROOF_OWNER_TOKEN;
  if (existingToken) {
    log('using supplied owner token (redacted):', redactTokenPrefix(existingToken));
    // Resolve user id for the artifact without exposing the token.
    const me = await request(baseUrl, 'GET', '/v1/auth/me', existingToken);
    if (me.status !== 200) {
      err('supplied LOAD_PROOF_OWNER_TOKEN failed /v1/auth/me');
      process.exit(E_PROOF_FAIL);
    }
    return { token: existingToken, userId: me.data.id as string };
  }

  const email = process.env.LOAD_PROOF_EMAIL;
  const password = process.env.LOAD_PROOF_PASSWORD;
  if (!email || !password) {
    blocked(
      'auth not configured. Set LOAD_PROOF_OWNER_TOKEN, or both LOAD_PROOF_EMAIL and LOAD_PROOF_PASSWORD.',
    );
  }

  const registerBody = {
    email,
    password,
    display_name: 'Live Load Proof Operator',
  };
  const registerResponse = await request(baseUrl, 'POST', '/v1/auth/register', undefined, registerBody);

  if (registerResponse.status === 201) {
    log('registered new test user');
    return {
      token: registerResponse.data.access_token as string,
      userId: registerResponse.data.user.id as string,
    };
  }

  if (registerResponse.status === 409) {
    log('user already exists; logging in');
    const loginResponse = await request(baseUrl, 'POST', '/v1/auth/token', undefined, {
      email,
      password,
    });
    if (loginResponse.status !== 200) {
      err('login failed for existing user');
      process.exit(E_PROOF_FAIL);
    }
    return {
      token: loginResponse.data.access_token as string,
      userId: loginResponse.data.user.id as string,
    };
  }

  err('registration failed:', registerResponse.status, registerResponse.data);
  process.exit(E_PROOF_FAIL);
}

async function registerAgent(
  baseUrl: string,
  token: string,
  projectId: string,
  name: string,
): Promise<{ id: string; apiKey: string }> {
  const response = await request(baseUrl, 'POST', `/v1/projects/${projectId}/agents`, token, {
    name,
  });
  if (response.status !== 201) {
    err(`failed to register agent ${name}:`, response.status, response.data);
    process.exit(E_PROOF_FAIL);
  }
  return { id: response.data.id as string, apiKey: response.data.api_key as string };
}

async function heartbeatAgent(baseUrl: string, apiKey: string): Promise<void> {
  const response = await requestAgent(baseUrl, 'POST', '/v1/agents/heartbeat', apiKey, {
    status: 'healthy',
    metrics: { load: 0 },
  });
  if (response.status !== 200) {
    err('agent heartbeat failed:', response.status, response.data);
    process.exit(E_PROOF_FAIL);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const k = (sorted.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return sorted[f];
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

function summarize(values: number[]): LatencySummary {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

async function runOneIteration(
  baseUrl: string,
  token: string,
  workerCount: number,
  tasksPerWorker: number,
): Promise<{
  totalTasks: number;
  pollLatencies: number[];
  claimLatencies: number[];
  completeLatencies: number[];
  e2eLatencies: number[];
  leasedItemCount: number;
  readyForReviewCount: number;
}> {
  const timestamp = Date.now();
  const projectName = `Live Load Proof ${timestamp}`;

  const projectResponse = await request(baseUrl, 'POST', '/v1/projects', token, {
    name: projectName,
    description: 'Bounded live/staging load proof project. Safe to archive.',
  });
  if (projectResponse.status !== 201) {
    err('failed to create project:', projectResponse.status, projectResponse.data);
    process.exit(E_PROOF_FAIL);
  }
  const projectId = projectResponse.data.id as string;
  log(`created project ${projectId}`);

  const mainAgent = await registerAgent(baseUrl, token, projectId, `LLP Main ${timestamp}`);
  await heartbeatAgent(baseUrl, mainAgent.apiKey);

  const bindResponse = await request(baseUrl, 'PATCH', '/v1/users/me/owner-agent', token, {
    agent_id: mainAgent.id,
  });
  if (bindResponse.status !== 200) {
    err('failed to bind owner-agent:', bindResponse.status, bindResponse.data);
    process.exit(E_PROOF_FAIL);
  }

  const workers: { id: string; apiKey: string }[] = [];
  for (let i = 0; i < workerCount; i++) {
    const agent = await registerAgent(baseUrl, token, projectId, `LLP Worker ${timestamp}-${i}`);
    await heartbeatAgent(baseUrl, agent.apiKey);
    workers.push(agent);
    log(`registered worker ${i + 1}/${workerCount} (key prefix ${redactApiKeyPrefix(agent.apiKey)})`);
  }

  const orchestrationResponse = await request(
    baseUrl,
    'POST',
    `/v1/projects/${projectId}/orchestrations`,
    token,
    {
      title: 'Live Load Proof Orchestration',
      objective: 'Measure live/staging poll/claim/complete latency',
      main_agent_id: mainAgent.id,
      worker_agent_ids: workers.map((w) => w.id),
    },
  );
  if (orchestrationResponse.status !== 201) {
    err('failed to create orchestration:', orchestrationResponse.status, orchestrationResponse.data);
    process.exit(E_PROOF_FAIL);
  }
  const orchestrationId = orchestrationResponse.data.id as string;

  const tasks: { id: string; workerId: string; workerKey: string }[] = [];
  for (const worker of workers) {
    for (let j = 0; j < tasksPerWorker; j++) {
      const taskResponse = await requestAgent(
        baseUrl,
        'POST',
        `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks`,
        mainAgent.apiKey,
        {
          title: `LLP task ${worker.id.slice(0, 8)}-${j}`,
          goal: 'Measure live claim/complete latency',
          assigned_agent_id: worker.id,
        },
      );
      if (taskResponse.status !== 201) {
        err('failed to dispatch task:', taskResponse.status, taskResponse.data);
        process.exit(E_PROOF_FAIL);
      }
      tasks.push({ id: taskResponse.data.id as string, workerId: worker.id, workerKey: worker.apiKey });
    }
  }

  const pollLatencies: number[] = [];
  const claimLatencies: number[] = [];
  const completeLatencies: number[] = [];
  const e2eLatencies: number[] = [];
  let leasedItemCount = 0;

  await Promise.all(
    workers.map(async (worker) => {
      const assigned = tasks.filter((t) => t.workerId === worker.id);

      const pollStart = performance.now();
      const inbox = await requestAgent(
        baseUrl,
        'GET',
        '/v1/agent/inbox?event_type=task_dispatched',
        worker.apiKey,
      );
      pollLatencies.push(performance.now() - pollStart);

      if (inbox.status !== 200) {
        err(`worker ${redactApiKeyPrefix(worker.apiKey)} inbox poll failed:`, inbox.status);
        process.exit(E_PROOF_FAIL);
      }

      const items = (inbox.data.data || []).filter((item: any) =>
        assigned.some((t) => t.id === item.task_id),
      );
      for (const item of items) {
        if (item.lease_token) leasedItemCount += 1;
      }

      await Promise.all(
        assigned.map(async (task) => {
          const taskStart = performance.now();
          const claim = await requestAgentTimed(
            baseUrl,
            'PATCH',
            `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${task.id}/claim`,
            task.workerKey,
          );
          if (claim.status !== 200) {
            err(`task ${task.id} claim failed:`, claim.status, claim.data);
            process.exit(E_PROOF_FAIL);
          }
          claimLatencies.push(claim.durationMs);

          const complete = await requestAgentTimed(
            baseUrl,
            'POST',
            `/v1/projects/${projectId}/orchestrations/${orchestrationId}/tasks/${task.id}/complete`,
            task.workerKey,
            {
              result_md: '# Result\n\nLive load proof completion.',
              evidence: { live_load_proof: true },
              status: 'ready_for_review',
            },
          );
          if (complete.status !== 200) {
            err(`task ${task.id} complete failed:`, complete.status, complete.data);
            process.exit(E_PROOF_FAIL);
          }
          completeLatencies.push(complete.durationMs);
          e2eLatencies.push(performance.now() - taskStart);
        }),
      );
    }),
  );

  const mainInbox = await requestAgent(
    baseUrl,
    'GET',
    '/v1/agent/inbox?event_type=task_ready_for_review',
    mainAgent.apiKey,
  );
  if (mainInbox.status !== 200) {
    err('main agent review inbox poll failed:', mainInbox.status);
    process.exit(E_PROOF_FAIL);
  }
  const readyItems = (mainInbox.data.data || []).filter((item: any) =>
    tasks.some((t) => t.id === item.task_id),
  );
  const uniqueReadyTasks = new Set(readyItems.map((item: any) => item.task_id));

  return {
    totalTasks: tasks.length,
    pollLatencies,
    claimLatencies,
    completeLatencies,
    e2eLatencies,
    leasedItemCount,
    readyForReviewCount: uniqueReadyTasks.size,
  };
}

async function main(): Promise<void> {
  const baseUrl = getRequiredEnv('BASE_URL');

  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    blocked('BASE_URL must be a valid http(s) URL');
  }

  const allowRemote = process.env.ALLOW_REMOTE_VERIFY;
  if (!isLocalBaseUrl(baseUrl) && allowRemote !== '1') {
    blocked(
      `BASE_URL ${redactHostForDisplay(baseUrl)} is not localhost. ` +
        'Set ALLOW_REMOTE_VERIFY=1 to opt in to live/staging load proof.',
    );
  }

  log('target:', redactUrl(baseUrl));

  const health = await request(baseUrl, 'GET', '/v1/health');
  if (health.status !== 200) {
    err('health check failed:', health.status);
    process.exit(E_PROOF_FAIL);
  }
  log('health OK');

  const { token } = await getOwnerToken(baseUrl);

  const workerCount = getEnvInt('LOAD_PROOF_WORKERS', 2);
  const tasksPerWorker = getEnvInt('LOAD_PROOF_TASKS_PER_WORKER', 2);
  const iterations = getEnvInt('LOAD_PROOF_ITERATIONS', 1);

  if (workerCount === 0 || tasksPerWorker === 0 || iterations === 0) {
    blocked('LOAD_PROOF_WORKERS, LOAD_PROOF_TASKS_PER_WORKER, and LOAD_PROOF_ITERATIONS must be > 0');
  }

  const maxTasks = getEnvInt('LOAD_PROOF_MAX_TOTAL_TASKS', 50);
  const requestedTotal = workerCount * tasksPerWorker * iterations;
  if (requestedTotal > maxTasks) {
    blocked(
      `requested ${requestedTotal} total tasks exceeds LOAD_PROOF_MAX_TOTAL_TASKS=${maxTasks}. ` +
        'Raise the cap only after deliberate review.',
    );
  }

  log(`configuration: workers=${workerCount} tasks_per_worker=${tasksPerWorker} iterations=${iterations}`);

  const allPoll: number[] = [];
  const allClaim: number[] = [];
  const allComplete: number[] = [];
  const allE2e: number[] = [];
  let totalTasks = 0;
  let totalLeased = 0;
  let totalReady = 0;

  const startAll = performance.now();
  for (let i = 0; i < iterations; i++) {
    log(`iteration ${i + 1}/${iterations}`);
    const iteration = await runOneIteration(baseUrl, token, workerCount, tasksPerWorker);
    allPoll.push(...iteration.pollLatencies);
    allClaim.push(...iteration.claimLatencies);
    allComplete.push(...iteration.completeLatencies);
    allE2e.push(...iteration.e2eLatencies);
    totalTasks += iteration.totalTasks;
    totalLeased += iteration.leasedItemCount;
    totalReady += iteration.readyForReviewCount;
  }
  const totalDurationMs = performance.now() - startAll;

  // Deterministic test hook: set LOAD_PROOF_FAIL_INBOX_GUARANTEES=1 to force
  // inbox guarantee counters to zero, proving the probe fails closed.
  const forceInboxFail = process.env.LOAD_PROOF_FAIL_INBOX_GUARANTEES === '1';

  const everyTaskReadyForReview = forceInboxFail ? false : totalReady === totalTasks;
  const everyDispatchedItemLeased = forceInboxFail ? false : totalLeased === totalTasks;

  const latencyArraysPopulated =
    allPoll.length > 0 &&
    allClaim.length > 0 &&
    allComplete.length > 0 &&
    allE2e.length > 0;

  const proofPass = everyTaskReadyForReview && everyDispatchedItemLeased && latencyArraysPopulated;

  const artifact: LoadProofArtifact = {
    schema_version: 'live-load-proof/v1',
    generated_at: new Date().toISOString(),
    target_base_url: redactUrl(baseUrl),
    target_host_redacted: redactHostForDisplay(baseUrl),
    environment: process.env.NODE_ENV || 'live',
    worker_count: workerCount,
    tasks_per_worker: tasksPerWorker,
    total_tasks: totalTasks,
    iterations,
    total_duration_ms: totalDurationMs,
    durations_ms: {
      poll: summarize(allPoll),
      claim: summarize(allClaim),
      complete: summarize(allComplete),
      e2e: summarize(allE2e),
    },
    inbox_guarantees: {
      every_task_ready_for_review: everyTaskReadyForReview,
      every_dispatched_item_leased: everyDispatchedItemLeased,
    },
    pass: proofPass,
    note:
      'Live/staging load proof against an explicitly supplied target. ' +
      'This measures real network + deployed-backend latency, but it is NOT a production SLO guarantee ' +
      'unless the target is the production environment and the test ran during representative traffic. ' +
      'Local SQLite load proof remains the only local parity evidence.',
  };

  const artifactDir = process.env.LOAD_PROOF_ARTIFACT_DIR || path.resolve(process.cwd(), 'load-proof-artifacts');
  mkdirSync(artifactDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactPath = path.join(artifactDir, `live-load-proof-${timestamp}.json`);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

  if (!proofPass) {
    err('live load proof FAILED — artifact written but pass=false');
    err(`  every_task_ready_for_review: ${everyTaskReadyForReview} (got ${totalReady}/${totalTasks})`);
    err(`  every_dispatched_item_leased: ${everyDispatchedItemLeased} (got ${totalLeased}/${totalTasks})`);
    err(`  latency_arrays_populated: ${latencyArraysPopulated}`);
    err(`  artifact: ${artifactPath}`);
    process.exit(E_PROOF_FAIL);
  }

  log(`live load proof passed — artifact: ${artifactPath}`);
  log('latencies (ms):');
  log(`  poll    p50=${artifact.durations_ms.poll.p50.toFixed(2)} p95=${artifact.durations_ms.poll.p95.toFixed(2)} p99=${artifact.durations_ms.poll.p99.toFixed(2)}`);
  log(`  claim   p50=${artifact.durations_ms.claim.p50.toFixed(2)} p95=${artifact.durations_ms.claim.p95.toFixed(2)} p99=${artifact.durations_ms.claim.p99.toFixed(2)}`);
  log(`  complete p50=${artifact.durations_ms.complete.p50.toFixed(2)} p95=${artifact.durations_ms.complete.p95.toFixed(2)} p99=${artifact.durations_ms.complete.p99.toFixed(2)}`);
  log(`  e2e     p50=${artifact.durations_ms.e2e.p50.toFixed(2)} p95=${artifact.durations_ms.e2e.p95.toFixed(2)} p99=${artifact.durations_ms.e2e.p99.toFixed(2)}`);

  process.exit(E_OK);
}

main().catch((error) => {
  err(error);
  process.exit(E_PROOF_FAIL);
});
