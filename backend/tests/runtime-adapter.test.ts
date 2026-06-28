import assert from 'assert';
import { createHash, createHmac } from 'crypto';
import {
  buildSignedHeaders,
  invokeAgent,
  InvokeAgentWithRepositoryInput,
} from '../src/services/runtime-adapter.service';
import {
  RuntimeEventAppend,
  RuntimeEventRepository,
  RuntimeFetch,
  RuntimeHttpResponse,
} from '../src/services/runtime-types';

class MemoryEventRepository implements RuntimeEventRepository {
  readonly events: RuntimeEventAppend[] = [];

  async appendEvent(event: RuntimeEventAppend): Promise<void> {
    this.events.push(event);
  }
}

function jsonResponse(status: number, body: unknown): RuntimeHttpResponse {
  return {
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function baseInvokeInput(
  eventRepository: RuntimeEventRepository,
  fetchFn: RuntimeFetch,
): InvokeAgentWithRepositoryInput {
  return {
    projectId: 'proj_1',
    sessionId: 'sess_1',
    agentId: 'agent_1',
    runId: 'run_1',
    deliveryId: 'deliv_1',
    traceId: 'trace_1',
    correlationId: 'corr_1',
    endpointUrl: 'https://agent.example.test/zz/v1/invoke',
    invokeSecret: 'runtime-secret',
    trigger: {
      type: 'message.created',
      message_id: 'msg_1',
      sender_type: 'user',
      sender_id: 'user_1',
    },
    agent: {
      id: 'agent_1',
      name: 'reviewer',
      endpoint_url: 'https://agent.example.test/zz/v1/invoke',
    },
    session: {
      id: 'sess_1',
      project_id: 'proj_1',
      title: 'Demo',
      status: 'active',
    },
    recentMessages: [
      {
        id: 'msg_1',
        role: 'user',
        content: 'Review this diff',
        created_at: '2026-05-28T00:00:00.000Z',
      },
    ],
    eventRepository,
    fetchFn,
    timeoutMs: 20,
    now: () => new Date('2026-05-28T00:00:00.000Z'),
  };
}

async function runInvoke(
  response: RuntimeHttpResponse,
): Promise<{ repo: MemoryEventRepository; fetchBodies: string[] }> {
  const repo = new MemoryEventRepository();
  const fetchBodies: string[] = [];
  const fetchFn: RuntimeFetch = async (_url, init) => {
    fetchBodies.push(init.body);
    return response;
  };

  await invokeAgent(baseInvokeInput(repo, fetchFn));
  return { repo, fetchBodies };
}

async function testHmacHeaders(): Promise<void> {
  const rawBody = '{"hello":"world"}';
  const headers = buildSignedHeaders({
    rawBody,
    invokeSecret: 'secret',
    timestamp: 123,
    deliveryId: 'deliv_123',
    projectId: 'proj_123',
    sessionId: 'sess_123',
    agentId: 'agent_123',
    runId: 'run_123',
    traceId: 'trace_123',
  });

  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const expectedSignature = createHmac('sha256', 'secret')
    .update(`123.deliv_123.${bodyHash}`)
    .digest('hex');

  assert.equal(headers['X-ZZ-Signature'], `sha256=${expectedSignature}`);
  assert.equal(headers['X-ZZ-Attempt'], '1');
  assert.equal(headers['X-ZZ-Idempotency-Key'], 'run_123:attempt:1');
}

async function testCompleted(): Promise<void> {
  const repo = new MemoryEventRepository();
  const fetchFn: RuntimeFetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.protocol_version, 'runtime.v1');
    assert.equal(request.runtime.max_attempts, 1);
    assert.equal(request.runtime.supports_async, false);
    assert.equal(request.runtime.supports_streaming, false);
    assert.equal(init.headers['X-ZZ-Protocol-Version'], 'runtime.v1');

    return jsonResponse(200, {
      status: 'completed',
      messages: [
        {
          content: 'Looks good',
          sender_type: 'user',
          sender_id: 'evil_user',
          run_id: 'evil_run',
          caused_by_run_id: 'evil_parent',
        },
      ],
      metrics: [{ name: 'latency_ms', value: 42 }],
    });
  };

  const result = await invokeAgent(baseInvokeInput(repo, fetchFn));

  assert.equal(result.ok, true);
  assert.deepEqual(
    repo.events.map((event) => event.type),
    [
      'agent.run.queued',
      'agent.run.started',
      'message.created',
      'health.metric',
      'agent.run.completed',
    ],
  );
  const queued = repo.events.find((event) => event.type === 'agent.run.queued')?.payload;
  assert.equal(queued?.agent_id, 'agent_1');
  assert.equal(queued?.trigger_message_id, 'msg_1');
  assert.equal(queued?.endpoint_url, undefined);
  assert.equal(typeof queued?.endpoint_url_hash, 'string');
  const message = repo.events.find((event) => event.type === 'message.created')?.payload;
  assert.equal(typeof message?.message_id, 'string');
  assert.equal(message?.sender_type, 'agent');
  assert.equal(message?.sender_id, 'agent_1');
  assert.equal(message?.run_id, 'run_1');
  assert.equal(message?.caused_by_run_id, 'run_1');
  assert.equal(message?.visibility, 'session');
  assert.deepEqual(message?.recipient_participant_ids, []);

  const metric = repo.events.find((event) => event.type === 'health.metric')?.payload;
  assert.equal(metric?.name, 'latency_ms');
  assert.equal(metric?.value, 42);
  assert.equal(metric?.unit, 'count');

  const completed = repo.events.at(-1)?.payload;
  assert.equal(completed?.agent_id, 'agent_1');
  assert.ok(Array.isArray(completed?.output_message_ids));
}

async function testNoReply(): Promise<void> {
  const { repo } = await runInvoke(jsonResponse(200, { status: 'no_reply' }));

  assert.deepEqual(
    repo.events.map((event) => event.type),
    ['agent.run.queued', 'agent.run.started', 'agent.run.completed'],
  );
  assert.equal(repo.events.at(-1)?.payload.status, 'no_reply');
}

async function testAgentFailed(): Promise<void> {
  const { repo } = await runInvoke(jsonResponse(200, {
    status: 'failed',
    error: { code: 'tool_error', message: 'Tool crashed' },
  }));

  const failed = repo.events.at(-1);
  assert.equal(failed?.type, 'agent.run.failed');
  assert.equal(failed?.payload.failure_type, 'agent_error');
  assert.equal(failed?.payload.error_code, 'tool_error');
  assert.deepEqual(failed?.payload.error, {
    code: 'tool_error',
    message: 'Tool crashed',
    retryable: false,
  });
}

async function testRejected(): Promise<void> {
  const { repo } = await runInvoke(jsonResponse(200, {
    status: 'rejected',
    error: { code: 'out_of_scope', message: 'Not mine' },
  }));

  const failed = repo.events.at(-1);
  assert.equal(failed?.type, 'agent.run.failed');
  assert.equal(failed?.payload.failure_type, 'agent_rejected');
}

async function testHttp500(): Promise<void> {
  const { repo } = await runInvoke(jsonResponse(500, { detail: 'boom' }));

  const failed = repo.events.at(-1);
  assert.equal(failed?.type, 'agent.run.failed');
  assert.equal(failed?.payload.failure_type, 'agent_error');
  assert.equal(failed?.payload.http_status, 500);
}

async function testUnsupportedAsyncResponse(): Promise<void> {
  const { repo } = await runInvoke(jsonResponse(202, { run_id: 'remote_async_run' }));

  const failed = repo.events.at(-1);
  assert.equal(failed?.type, 'agent.run.failed');
  assert.equal(failed?.payload.failure_type, 'unsupported_async_response');
  assert.equal(failed?.payload.http_status, 202);
}

async function testTimeout(): Promise<void> {
  const repo = new MemoryEventRepository();
  const fetchFn: RuntimeFetch = async (_url, init) => {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const result = await invokeAgent(baseInvokeInput(repo, fetchFn));
  assert.equal(result.ok, false);
  assert.equal(result.failureType, 'timeout');
  assert.equal(repo.events.at(-1)?.payload.failure_type, 'timeout');
}

async function testInvalidJson(): Promise<void> {
  const { repo } = await runInvoke(jsonResponse(200, '{not-json'));

  const failed = repo.events.at(-1);
  assert.equal(failed?.type, 'agent.run.failed');
  assert.equal(failed?.payload.failure_type, 'invalid_response');
}

async function main(): Promise<void> {
  await testHmacHeaders();
  await testCompleted();
  await testNoReply();
  await testAgentFailed();
  await testRejected();
  await testHttp500();
  await testUnsupportedAsyncResponse();
  await testTimeout();
  await testInvalidJson();

  console.log('runtime-adapter tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
