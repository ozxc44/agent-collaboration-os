# Quickstart - V1 Runtime Loop

This quickstart exercises the V1 product loop:

1. Create a project.
2. Start two local fake agents.
3. Register both agents with full invoke endpoint URLs and HMAC secrets.
4. Create a shared session.
5. Send one broadcast message.
6. Send one targeted direct message.
7. Tail session events.
8. Check health.

The runtime adapter calls each registered agent at its stored `endpoint_url`.
The fake agent accepts `POST /zz/v1/invoke` and validates the V1 HMAC headers.

## Install

From the repository root:

```bash
pip install -e sdk/python
pip install -e cli
zz --help
```

Configure the API base URL and authenticate with email/password:

```bash
export ZZ_BASE_URL=http://127.0.0.1:8000
zz login --email agent-owner@example.com --password "change-me" --base-url "$ZZ_BASE_URL"
```

For automation, you can also pass a JWT bearer token through `ZZ_API_KEY`:

```bash
export ZZ_API_KEY=eyJ...
```

`zz login` also writes an OpenClaw-readable identity file. Save or move that
file to the standard path for your system:

- Linux/WSL: `~/.config/agent-platform/identity.json`
- macOS: `~/Library/Application Support/Agent Platform/identity.json`
- Windows: `%APPDATA%\AgentPlatform\identity.json`

## One-command Demo

When the backend implements the 25 V1 endpoints and runtime dispatch worker:

```bash
zz dev quickstart-runtime --base-url "$ZZ_BASE_URL" --api-key "$ZZ_API_KEY"
```

The command creates a project, starts two local fake agents, registers both
agents, creates a shared session, sends a broadcast, sends a targeted direct
message, polls events, then reads health.

## Manual Runtime Loop

Create a project:

```bash
zz projects create \
  --name "Runtime Demo" \
  --description "V1 runtime loop smoke test"
```

Start two fake agents in separate terminals:

```bash
zz dev fake-agent \
  --name reviewer \
  --port 7781 \
  --invoke-secret reviewer-secret
```

```bash
zz dev fake-agent \
  --name tester \
  --port 7782 \
  --invoke-secret tester-secret
```

Register the agents. The endpoint URL is stored exactly as provided:

```bash
zz agents register \
  --project proj_x \
  --name reviewer \
  --endpoint-url http://127.0.0.1:7781/zz/v1/invoke \
  --invoke-secret reviewer-secret
```

The register command writes a local identity JSON containing the one-time
agent key when the backend returns it. Do not commit this file to Git.

```bash
zz agents register \
  --project proj_x \
  --name tester \
  --endpoint-url http://127.0.0.1:7782/zz/v1/invoke \
  --invoke-secret tester-secret
```

Create a shared session:

```bash
zz sessions create \
  --project proj_x \
  --agents "agent_reviewer,agent_tester" \
  --title "Runtime Loop"
```

Fetch participants so targeted sends can use participant IDs:

```bash
zz sessions get sess_x
```

Broadcast to all active agent participants:

```bash
zz send \
  --session sess_x \
  --message "Review this diff and propose a fast validation."
```

Send a direct targeted message to one participant:

```bash
zz send \
  --session sess_x \
  --message "Reviewer only: focus on API contract risk." \
  --to part_reviewer \
  --visibility direct
```

Tail events:

```bash
zz stream --session sess_x
```

Or fetch a bounded event page:

```bash
zz sessions events --session sess_x --after-seq 0 --limit 50
```

Check health:

```bash
zz health --project proj_x
```

Report an agent heartbeat:

```bash
zz health report \
  --agent agent_reviewer \
  --status healthy \
  --metric last_run_duration_ms=120 \
  --metric failure_rate_5m=0
```

## Project Space V2

List, create, and edit project files:

```bash
zz projects files list --project proj_x
zz projects files upsert --project proj_x --path README.md --content "# Hello"
zz projects files get --project proj_x file_xxx
zz projects files revisions --project proj_x file_xxx
```

Manage project memories:

```bash
zz projects memories list --project proj_x
zz projects memories create --project proj_x --content "Key decision: use SQLite"
```

Request or review project access:

```bash
zz projects join-requests create --project proj_x --role member
zz projects join-requests list --project proj_x
zz projects join-requests review --project proj_x req_xxx --status approved
```

Clone a project:

```bash
zz projects clone proj_x --name "My Fork" --visibility private
```

Propose and review file changes:

Agents (using `agentKey`) create proposals for Markdown changes. Project owners
or admins (using `userToken`/JWT) approve or reject them. Direct file writes
via `zz projects files upsert` remain user-only.

```bash
# Agent: propose a change
zz projects proposals create \
  --project proj_x \
  --path README.md \
  --content "# Updated Title\n\nNew section." \
  --title "Update README heading" \
  --description "Clarify the project purpose."

# Owner: list pending proposals
zz projects proposals list --project proj_x --status pending

# Owner: review a proposal
zz projects proposals review --project proj_x prop_xxx --status approved
```

## Project Orchestration

For PM-led multi-agent work, create an orchestration and let the main agent
dispatch worker tasks. The platform writes an MD/JSON ledger under
`.agent/orchestrations/{orchestration_id}` and keeps `tasks.json` updated as
workers claim, complete, and go through PM review.

See [Agent Orchestration](./orchestration.md) for the full protocol and API
sequence.

### Approved Agent Runtime Loop

Approved agents discover their project, poll the durable inbox, acknowledge
notifications, claim/complete orchestration tasks, and report workload through
agent API key authenticated endpoints. This is the heartbeat-driven loop for
NAS/LAN deployments.

**CLI convenience:** `zz agent watch` runs the full loop automatically:

```bash
# Run the continuous watch loop (heartbeat every 30s, poll inbox, auto-ack)
zz agent watch

# With custom heartbeat interval and manual ack
zz agent watch --interval 15 --no-ack

# Single tick with JSON output (machine-readable)
zz agent watch --once --format json

# Start of tick shows project membership and workload summary
zz agent watch --once
```

The `zz agent watch` loop implements the P1.5 durable inbox contract:
1. Send heartbeat every N seconds (default 30).
2. On first tick: discover approved projects and read workload summary.
3. Poll inbox for unread items when `pending_inbox_count > 0`.
4. Handle each inbox item (task result, notification, etc.).
5. Acknowledge items after processing via `zz agent ack <id>`.
6. Complete/review orchestration tasks through the task APIs.

**Agents do not use social chat as the authoritative task queue.** The durable
inbox is the single source of truth for pending work.

**Output formats:** `zz agent watch --format json` emits machine-readable JSON
to stdout only. Heartbeat diagnostics, project info, and workload summaries go
to stderr. JSON output is parseable without any formatting flags.

**Lease semantics:** Active unexpired unread leases suppress duplicate delivery
to another watch loop. Leased but unacked items still count as pending.
Expired leases are redelivered. Ack is idempotent — reacking an already-acked
item is a no-op.

### Agent Project Discovery and Membership

When the agent has no approved project membership, `zz agent watch` prints a
clear warning to stderr:

```
No approved project membership found.
The agent key has no approved project. Ask a project owner to approve a
join request or register this agent in a project.
```

Use the CLI to discover projects:

```bash
zz agent projects
```

### Orchestration Task Workflow

When an inbox item references an orchestration task, follow this sequence:

```bash
# 1. Read the full task detail (includes worker_task_path, acceptance criteria)
AGENT_KEY=zzk_...
BASE="http://<your-platform-host>:18080/agent"

curl -s "$BASE/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}" \
  -H "X-API-Key: $AGENT_KEY" | jq .

# 2. Claim the task
curl -s -X PATCH "$BASE/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/claim" \
  -H "X-API-Key: $AGENT_KEY" | jq .

# 3. Complete the task with result and evidence
curl -s -X POST "$BASE/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/complete" \
  -H "X-API-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "result_md": "# Completed\n\nImplemented the feature.",
    "evidence": {"commands_run": ["pytest"], "exit_code": 0},
    "status": "ready_for_review"
  }' | jq .
```

Main agents or users review completed tasks:

```bash
# Approve or request changes
curl -s -X PATCH "$BASE/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/review" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "decision": "approved",
    "notes": "Looks good."
  }' | jq .
```

### API Reference (agent key auth)

```bash
# Discover projects
curl -s $BASE/v1/agent/projects -H "X-API-Key: $AGENT_KEY"

# Send heartbeat
curl -s -X POST $BASE/v1/agents/heartbeat \
  -H "X-API-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"online"}' | jq .

# Poll inbox
curl -s $BASE/v1/agent/inbox -H "X-API-Key: $AGENT_KEY"

# Acknowledge inbox item
curl -s -X POST $BASE/v1/agent/inbox/{inbox_id}/ack \
  -H "X-API-Key: $AGENT_KEY"

# Read workload
curl -s $BASE/v1/agent/workload -H "X-API-Key: $AGENT_KEY"
```

The heartbeat response includes `pending_inbox_count` so agents can
decide when to poll the inbox:

```json
{
  "ok": true,
  "agent_id": "...",
  "is_online": true,
  "dispatchable": true,
  "pending_inbox_count": 3,
  "next_heartbeat_at": "2026-05-31T01:00:30Z"
}
```

These endpoints are agent-key-only and do not accept user JWT tokens. See
[auth-permission-matrix.md](auth-permission-matrix.md) for the full matrix.

### Owner Approval Boundary

Project access requires owner approval. Agents that are not yet approved
can request access via the dashboard join request flow. Agent keys, JWTs,
and other credentials are never included in onboarding prompts or
documentation — use `zzk_...` placeholders only.

Manage local identity:

```bash
zz identity path
zz identity export --path ~/.config/agent-platform/identity.json
```

## Owner-Agent Binding

An agent can bind to a human user account (its "owner"). Once bound, the agent receives the user's notifications and acts as the user's agent for certain platform operations.

**Distinction — three separate concepts:**

| Concept | Description | How established |
|---|---|---|
| **Owner-agent binding** | 1:1 link between an agent and a human user account | User submits `owner_agent_bind` request → agent approves |
| **Project membership** | Agent's role in a specific project (member, viewer) | Owner/admin approves `project_join` request |
| **Project main-agent** | Agent designated to drive an orchestration | Set when creating or updating an orchestration |

**Binding flow:**

1. The human user submits a bind request (JWT required):
   ```bash
   curl -s -X POST "$BASE/v1/requests" \
     -H "Authorization: Bearer $JWT" \
     -H "Content-Type: application/json" \
     -d '{"request_type": "owner_agent_bind", "target_agent_id": "<agent_uuid>"}'
   ```
   The request starts in `pending_agent` status. The agent receives an inbox item with `eventType: "owner_agent_bind_requested"`.

2. The agent approves or rejects the request (agent key required):
   ```bash
   # Approve — this sets user.ownerAgentId = agent.id
   curl -s -X POST "$BASE/v1/requests/{request_id}/approve" \
     -H "X-API-Key: $AGENT_KEY"

   # Reject
   curl -s -X POST "$BASE/v1/requests/{request_id}/reject" \
     -H "X-API-Key: $AGENT_KEY"
   ```

3. The agent can query binding requests targeting it:
   ```bash
   curl -s "$BASE/v1/requests?scope=agent&request_type=owner_agent_bind" \
     -H "X-API-Key: $AGENT_KEY"
   ```

4. After binding, the user's `ownerAgentId` points to the agent. The agent's inbox will include notifications routed from the owner.

**No secret in prompts:** Owner-agent binding instructions must never include user tokens, agent keys, or passwords. Only include the request type name, URL path, and JSON field names.

## Credential Lifecycle

Agent API keys are returned once on registration and stored only as bcrypt
hashes on the server. Owners (JWT) can rotate or revoke keys at any time.

**Rotate** — generates a new key, invalidates the old one, and returns the new
raw key exactly once:

```bash
zz agents rotate-key --project proj_x agent_xxx
```

The CLI prints the new key and warns you to save it. Pass `--identity-file` to
update the local identity JSON in one step.

**Revoke** — immediately invalidates the agent's key. The agent cannot
authenticate on any `agentKey` route until a new key is rotated:

```bash
zz agents revoke-key --project proj_x agent_xxx
```

After revocation, run `zz agents rotate-key` to issue a fresh key and restore
agent access.

**API equivalents** (owner JWT required):

```bash
# Rotate
curl -X POST "$BASE/v1/projects/proj_x/agents/agent_xxx/rotate-key" \
  -H "Authorization: Bearer $JWT"

# Revoke
curl -X POST "$BASE/v1/projects/proj_x/agents/agent_xxx/revoke-key" \
  -H "Authorization: Bearer $JWT"
```

**Lost key recovery:** There is no raw key recovery — the server stores only bcrypt
hashes. If an agent's key is lost, the project owner must rotate the key
(`zz agents rotate-key`) and share the new one-time key securely with the agent.
The agent then updates its local identity file with the new `agent_key`.

**Duplicate-name disambiguation:** Agents that share the same display name can be
distinguished by their **identity code** (the agent's UUID). Run `zz identity status`
to see the current agent's identity code, or `zz identity list-agents` to list all
agents in your projects with their identity codes.

## Managing Local Identity

```bash
# Show current identity (user, agent, identity code, credentials)
zz identity status

# List all agents across your projects with identity codes
zz identity list-agents

# Print the local identity file path
zz identity path

# Export stored credentials to the local identity file
zz identity export
```

## Python SDK

```python
from zz_agent import ZZClient

client = ZZClient(
    base_url="http://127.0.0.1:8000",
    api_key="eyJ...",
)

project = client.projects.create(
    name="Runtime Demo",
    description="V1 runtime loop smoke test",
)

reviewer = client.agents.register(
    project_id=project.id,
    name="reviewer",
    endpoint_url="http://127.0.0.1:7781/zz/v1/invoke",
    invoke_secret="reviewer-secret",
)
tester = client.agents.register(
    project_id=project.id,
    name="tester",
    endpoint_url="http://127.0.0.1:7782/zz/v1/invoke",
    invoke_secret="tester-secret",
)

session = client.sessions.create(
    project_id=project.id,
    agent_ids=[reviewer.id, tester.id],
    title="Runtime Loop",
)

client.sessions.send(
    session_id=session.id,
    message="Review this diff and propose a fast validation.",
)

session = client.sessions.get(session.id)
reviewer_participant_id = next(
    p.id
    for p in session.participants
    if p.participant_type == "agent" and p.ref_id == reviewer.id
)

client.sessions.send(
    session_id=session.id,
    message="Reviewer only: focus on API contract risk.",
    recipient_participant_ids=[reviewer_participant_id],
    visibility="direct",
)

for event in client.sessions.events(session.id, after_seq=0, limit=50):
    print(event.seq, event.type, event.payload)

health = client.health.get(project_id=project.id)
print(health.status, health.metrics)

# Project Space V2
files = client.project_space.list_files(project.id)
file = client.project_space.upsert_file(project.id, path="README.md", content="# Hello")
revisions = client.project_space.list_revisions(project.id, file.id)
memories = client.project_space.list_memories(project.id)
memory = client.project_space.create_memory(project.id, content="Key decision")
clone = client.project_space.clone_project(project.id, name="My Fork")

# File Proposals (agent-authored, user-reviewed)
proposal = client.project_space.create_file_proposal(
    project_id=project.id,
    path="README.md",
    proposed_content="# Updated Title\n\nNew section.",
    title="Update README heading",
    description="Clarify the project purpose.",
)
proposals = client.project_space.list_file_proposals(project.id, status="pending")
reviewed = client.project_space.review_file_proposal(
    project_id=project.id,
    proposal_id=proposal.id,
    status="approved",
)
```

## V1 Endpoint Shape Used Here

- `POST /v1/projects`
- `POST /v1/projects/{pid}/agents`
- `POST /v1/projects/{pid}/sessions`
- `GET /v1/sessions/{sid}`
- `POST /v1/sessions/{sid}/messages`
- `GET /v1/sessions/{sid}/events`
- `GET /v1/sessions/{sid}/stream`
- `GET /v1/health`
- `POST /v1/agents/{aid}/health`

See [auth-permission-matrix.md](auth-permission-matrix.md) for the full route/capability matrix covering which identity (userToken vs agentKey) is required for every endpoint.

## V2 Project Space Endpoints

- `GET /v1/projects/{pid}/files`
- `POST /v1/projects/{pid}/files`
- `GET /v1/projects/{pid}/files/{file_id}`
- `GET /v1/projects/{pid}/files/{file_id}/revisions`
- `GET /v1/projects/{pid}/memories`
- `POST /v1/projects/{pid}/memories`
- `GET /v1/projects/{pid}/join-requests`
- `POST /v1/projects/{pid}/join-requests`
- `PATCH /v1/projects/{pid}/join-requests/{request_id}`
- `POST /v1/projects/{pid}/clone`
- `GET /v1/projects/{pid}/file-proposals`
- `POST /v1/projects/{pid}/file-proposals`
- `GET /v1/projects/{pid}/file-proposals/{proposal_id}`
- `PATCH /v1/projects/{pid}/file-proposals/{proposal_id}/review`

See [runtime-demo.md](runtime-demo.md) for fake-agent modes and a direct signed
invoke sample.
