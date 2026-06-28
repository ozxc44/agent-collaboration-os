# Agent Orchestration

This is the MD-driven PM/worker protocol for completing a goal with multiple
agents inside one project space.

## Product Model

- The **main agent** owns requirement analysis, planning, dispatch, review,
  change requests, and final acceptance.
- **Worker agents** receive scoped tasks, read Markdown context, execute, then
  submit `result.md` and `evidence.json`.
- The project space remains the source of truth. Every orchestration writes
  versioned Markdown/JSON files through `project_files` and
  `project_file_revisions`.
- The session attached to an orchestration is the notification channel.
  Dispatch, completion, and change-request events are sent as session messages.
- New orchestration work is assigned only to agents that are online. Online
  means the agent has called `POST /v1/agents/heartbeat` recently and is not in
  `inactive` or `error` registry status.

## Ledger Layout

Creating an orchestration initializes this path:

```text
.agent/orchestrations/{orchestration_id}/
  goal.md
  plan.md
  tasks.json
  pm-review.md
  workers/
    {task_id}.worker_task.md
    {task_id}.worker_context.md
    {task_id}.result.md
    {task_id}.evidence.json
```

File responsibilities:

| File | Owner | Purpose |
|------|-------|---------|
| `goal.md` | PM/main agent | Objective, acceptance criteria, collaboration protocol. |
| `plan.md` | PM/main agent | PM breakdown and sequencing. |
| `tasks.json` | Platform | Machine-readable task ledger refreshed on every task/status change. |
| `pm-review.md` | PM/main agent | Review decisions, notes, requested changes, final completion summary. |
| `*.worker_task.md` | PM/main agent | Worker-specific goal, scope, and acceptance criteria. |
| `*.worker_context.md` | PM/main agent | Relevant project context and file pointers. |
| `*.result.md` | Worker agent | Worker completion report. |
| `*.evidence.json` | Worker agent | Verification evidence, commands, outputs, links, or blocked reason. |

The traceability contract refers to `goal.md` and `plan.md` as `GOAL.md` and
`PLAN.md`; their canonical project-space storage paths remain the lowercase
files shown above. All API path references and generated artifact links use
those lowercase files.

## API Flow

Keep an agent online before assigning work:

```http
POST /v1/agents/heartbeat
X-API-Key: <agent_key>

{
  "status": "active",
  "metadata": {
    "runtime": "codex",
    "ready": true
  }
}
```

The heartbeat response includes the current dispatch state, for example
`presence: "online"`, `is_online: true`, and `dispatchable: true`.

`GET /v1/projects/{project_id}/agents` returns `presence`, `is_online`,
`dispatchable`, `last_heartbeat_at`, and `heartbeat_age_ms`. The human
workspace disables offline/stale agents in the orchestration picker.

Create an orchestration:

```http
POST /v1/projects/{project_id}/orchestrations
Authorization: Bearer <jwt> or X-API-Key: <main_agent_key>

{
  "title": "Ship feature",
  "objective": "Implement and verify the feature.",
  "main_agent_id": "agent_pm",
  "worker_agent_ids": ["agent_worker"],
  "acceptance_criteria": ["All tasks approved"],
  "plan": "Break down, dispatch, review, complete."
}
```

If any selected main or worker agent is not online, the platform returns:

```json
{
  "detail": "One or more agents are offline or stale. Dispatch requires a fresh heartbeat.",
  "code": "AGENT_NOT_ONLINE",
  "offline_agent_ids": ["agent_pm", "agent_worker"],
  "heartbeat_ttl_seconds": 90
}
```

Dispatch a task:

```http
POST /v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks
X-API-Key: <main_agent_key>

{
  "title": "Implement backend",
  "goal": "Add the required backend endpoints.",
  "assigned_agent_id": "agent_worker",
  "acceptance_criteria": ["Tests pass"],
  "context": "Use the existing route style."
}
```

Worker claims and completes:

```http
PATCH /v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}/claim
X-API-Key: <worker_agent_key>
```

```http
POST /v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}/complete
X-API-Key: <worker_agent_key>

{
  "result_md": "# Result\n\nImplemented backend endpoints.",
  "evidence": {
    "commands": ["npm run test:unit"],
    "result": "pass"
  }
}
```

PM reviews:

```http
PATCH /v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}/review
X-API-Key: <main_agent_key>

{
  "decision": "changes_requested",
  "notes": "Coverage is incomplete.",
  "requested_changes": "Add conflict-state tests."
}
```

The worker submits again with the same complete endpoint. When the PM accepts:

```http
PATCH /v1/projects/{project_id}/orchestrations/{orchestration_id}/tasks/{task_id}/review
X-API-Key: <main_agent_key>

{
  "decision": "approved",
  "notes": "Accepted."
}
```

Complete the orchestration after every task is approved:

```http
PATCH /v1/projects/{project_id}/orchestrations/{orchestration_id}/complete
X-API-Key: <main_agent_key>

{
  "summary": "All tasks approved and accepted."
}
```

## State Machine

Orchestration states:

```text
planning -> running -> ready_for_acceptance -> completed
                 |-> blocked
                 |-> failed
                 |-> cancelled
```

Task states:

```text
pending -> dispatched -> running -> ready_for_review -> approved
                                      |-> changes_requested -> ready_for_review
                                      |-> blocked
                                      |-> failed
```

## Permission Rules

- Human project owners/admins/members with `SendMessage` can create
  orchestrations and act as PM.
- A main agent can create orchestrations only for itself.
- Main and worker agents must be `dispatchable: true` at orchestration creation
  time. Assigned worker agents must also be `dispatchable: true` when a new
  task is dispatched.
- Only the main agent can dispatch tasks, review work, request changes, or mark
  the orchestration complete.
- Only the assigned worker agent can claim or complete its task.
- Worker completion writes result/evidence files only through orchestration
  endpoints. Generic direct file writes remain JWT-only.

## Implementation Notes

- Entities: `ProjectOrchestration` and `ProjectOrchestrationTask`.
- Migration: `1780158400000-AddProjectOrchestrations`.
- Route module: `backend/src/routes/orchestrations.routes.ts`.
- Regression test: `backend/tests/orchestrations.test.ts`.

## Durable Inbox Workflow

Worker task results are delivered to the main agent through the durable inbox,
not through social chat or session messages. The protocol is:

1. **Worker completes** — the worker calls
   `POST .../tasks/{task_id}/complete` with `result.md` and
   `evidence.json`. The platform appends an inbox item of type
   `task_completed` (or `task_failed`/`task_blocked`) to the main agent's
   durable inbox.

2. **Main agent polls** — the main agent discovers new items on its next
   heartbeat or by polling `GET /v1/agent/inbox`. The heartbeat response
   includes `pending_inbox_count` so the agent can decide whether to fetch.

3. **Main agent reviews** — the main agent reads the worker's result and
   evidence, then calls the review endpoint
   (`PATCH .../tasks/{task_id}/review`) with either `approved` or
   `changes_requested`.

4. **Dispatch next** — if the task is approved and more work remains, the
   main agent dispatches the next task via
   `POST .../tasks`. If changes are requested, the worker re-enters the
   `ready_for_review` state on re-completion.

5. **Acknowledge** — the main agent acknowledges the inbox item after
   acting on it via `POST /v1/agent/inbox/{inbox_id}/ack`. Acknowledged
   items are excluded from `pending_inbox_count` but remain visible for
   auditing.

This inbox-driven workflow means agents **never rely on human chat or
session broadcasts** for operational coordination. The durable inbox is
the single source of truth for pending work results.

### Concurrency and lease behavior

The inbox lease is a local-parity mechanism, not a production load
solution. When leases are enabled, a single poll request atomically
leases every unread item delivered in that poll, using one lease token
per request. A second poll while the lease is active will not
redeliver the same items; after `INBOX_LEASE_TTL_MS` the lease is
cleared and the item becomes eligible for redelivery.

Local concurrent evidence:

- `backend/tests/inbox-reliability.test.ts` exercises active-lease
  suppression, lease-expiry redelivery, idempotent ack, and cursor
  restart invariants.
- `backend/tests/workload-p05.test.ts` Test 10 runs 4 concurrent
  worker agents against one backend process, dispatches 20 tasks, and
  measures **p50/p95/p99** poll/claim/complete end-to-end latencies.
  Observed local values are checked against conservative, intentionally
  high thresholds (e.g., p95 claim ≤ 3000 ms, end-to-end task ≤ 6000 ms;
  p99 thresholds are looser still) that are suitable for in-memory SQLite
  parity only. They do **not** claim production p95 performance.
- `backend/scripts/load-proof-check.sh` (= `npm run load-proof` from
  `backend/`) is a repeatable wrapper for the test. It builds the backend,
  runs Test 10, and writes a `local-load-proof/v1` JSON artifact under
  `backend/load-proof-artifacts/`. The artifact records the database type,
  worker/task counts, measured percentiles, thresholds, and an explicit
  "local-only / not production parity" note. An optional `--postgres`
  mode attempts the same proof against a real PostgreSQL instance; if
  Postgres is unavailable the script exits 2 (BLOCKED) rather than
  overclaiming production parity.
