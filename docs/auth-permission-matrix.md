# Auth & Permission Matrix

> Single source of truth for which identity to use on every platform route.
> Product decision: **userToken** (JWT) is for human/admin actions; **agentKey** (`zzk_*`) is project-scoped for safe agent-native collaboration.

## Identity Quick Reference

| Identity | Format | How to obtain | Typical use |
|----------|--------|---------------|-------------|
| **userToken** | JWT Bearer token | `POST /v1/auth/token` with `email` + `password` | Human login, admin/owner actions, dashboard, CLI login |
| **agentKey** | `zzk_` prefix, 64+ chars | Returned once when an agent is created via `POST /v1/projects/{pid}/agents` | Agent runtime, heartbeat, metrics, sending messages, reading project files |
| **transitional fallback** | `api_key` SDK parameter | Paste JWT or agentKey into `ZZClient(api_key=...)` | SDK/CLI convenience — the SDK sends the value as `Authorization: Bearer <value>` or `X-API-Key: <value>` depending on prefix |

**Header rules**
- JWT: `Authorization: Bearer <jwt>`
- Agent key: `Authorization: Bearer zzk_...` **or** `X-API-Key: zzk_...`
- Webhook: `X-ZZ-Signature: sha256=...` + `X-ZZ-Timestamp: ...`

## Route / Capability Matrix

| Route | Method | userToken | agentKey | Role / Scope | Product Rationale |
|-------|--------|-----------|----------|--------------|-------------------|
| **Auth** |  |  |  |  |  |
| `/v1/auth/register` | POST | N/A | N/A | Public | Create a human account. No auth required. |
| `/v1/auth/token` | POST | N/A | N/A | Public | Exchange `email` + `password` for a JWT. No `api_key` path on current backend. |
| `/v1/auth/me` | GET | Yes | No | JWT only | Read own user profile. Agent keys represent agents, not users. |
| `/v1/users/search` | GET | Yes | No | Any authenticated user | Search registered humans by email/display name for owner/admin member invitation. Returns only safe public identity fields. |
| **Projects** |  |  |  |  |  |
| `/v1/projects` | GET | Yes | No | Member of each listed project | List projects the authenticated user belongs to. Agents belong to exactly one project and discover it through their key scope. |
| `/v1/projects` | POST | Yes | No | Any authenticated user | Create a new project; creator becomes Owner. |
| `/v1/projects/{pid}` | GET | Yes | Yes | `ViewProject` | Read project metadata. Agent key allowed only for its own project. |
| `/v1/projects/{pid}` | PATCH | Yes | No | `EditProject` (Owner/Admin) | Update name, description, visibility, webhooks. Agents must not mutate project config. |
| `/v1/projects/{pid}` | DELETE | Yes | No | `DeleteProject` (Owner only) | Hard delete. Irreversible admin action. |
| `/v1/projects/{pid}/members` | GET | Yes | No | `ViewProject` | List human members and roles. Agent key does not manage membership. |
| `/v1/projects/{pid}/members` | POST | Yes | No | `ManageMembers` (Owner/Admin) | Invite a user by `user_id`. |
| `/v1/projects/{pid}/members/{uid}` | PATCH | Yes | No | `ManageMembers` (Owner/Admin) | Change a member's role. |
| `/v1/projects/{pid}/members/{uid}` | DELETE | Yes | No | `ManageMembers` (Owner/Admin) | Remove a member. |
| **Agents** |  |  |  |  |  |
| `/v1/projects/{pid}/agents` | GET | Yes | No | `ViewProject` | List agents in the project. |
| `/v1/projects/{pid}/agents` | POST | Yes | No | `CreateAgent` (Owner/Admin/Member) | Register a new agent. Returns the one-time `agentKey`. |
| `/v1/projects/{pid}/agents/{aid}` | GET | Yes | Yes | `ViewProject` + self-only for agentKey | Read agent profile. Agent key may read **only its own** profile. |
| `/v1/projects/{pid}/agents/{aid}` | PATCH | Yes | No | `EditAgent` (Owner/Admin, or Member if creator) | Update agent config. |
| `/v1/agents/{aid}` | GET | Yes | No | `ViewProject` | Root alias for agent details. JWT only. |
| `/v1/agents/{aid}` | PATCH | Yes | No | `EditAgent` | Root alias for agent update. JWT only. |
| `/v1/agents/{aid}` | DELETE | Yes | No | `EditAgent` | Soft-delete (mark inactive). JWT only. |
| `/v1/projects/{pid}/agents/{aid}/rotate-key` | POST | Yes | No | `EditAgent` | Generate a new agentKey, invalidate the old one. Owner/admin lifecycle action. |
| `/v1/projects/{pid}/agents/{aid}/revoke-key` | POST | Yes | No | `EditAgent` | Immediately nullify the agentKey. Agent cannot auth until rotated. |
| `/v1/projects/{pid}/agents/{aid}/send` | POST | Yes | No | `SendMessage` | Send a message to an agent (legacy V1 send path). |
| `/v1/projects/{pid}/agents/{aid}/runs` | GET | Yes | No | `ViewProject` | List agent run/message history. |
| **Sessions** |  |  |  |  |  |
| `/v1/projects/{pid}/sessions` | GET | Yes | Yes | `ViewSession` + participant filter for agentKey | List sessions. Agent sees only sessions where it is a participant. |
| `/v1/projects/{pid}/sessions` | POST | Yes | No | `CreateSession` (Owner/Admin/Member) | Create a new session with specified agents. |
| `/v1/projects/{pid}/sessions/{sid}` | GET | Yes | Yes | `ViewSession` + participant check for agentKey | Read session details and messages. Agent must be a participant. |
| `/v1/projects/{pid}/sessions/{sid}` | PATCH | Yes | No | `ViewSession` | Update session title/status. JWT only. |
| `/v1/sessions/{sid}` | GET | Yes | Yes | `ViewSession` + participant check for agentKey | Root alias. Same rules as nested path. |
| `/v1/sessions/{sid}` | PATCH | Yes | No | `ViewSession` | Root alias. JWT only. |
| **Messages** |  |  |  |  |  |
| `/v1/projects/{pid}/sessions/{sid}/messages` | GET | Yes | Yes | `ViewSession` + participant check for agentKey | List messages. Agent must be a participant. |
| `/v1/projects/{pid}/sessions/{sid}/messages` | POST | Yes | Yes | `SendMessage` + participant check for agentKey | Send a message. Agent sender ref must match itself; `dispatch_ttl` clamped to 1. |
| `/v1/sessions/{sid}/messages` | GET | Yes | Yes | `ViewSession` + participant check for agentKey | Root alias. Same rules. |
| `/v1/sessions/{sid}/messages` | POST | Yes | Yes | `SendMessage` + participant check for agentKey | Root alias. Same rules. |
| **Events** |  |  |  |  |  |
| `/v1/sessions/{sid}/events` | GET | Yes | Yes | Participant check for agentKey; project membership for JWT | Paginated event history. Agent must be a participant. |
| `/v1/sessions/{sid}/stream` | GET | Yes | Yes | Participant check for agentKey; project membership for JWT | SSE real-time event stream. Agent must be a participant. |
| `/v1/projects/{pid}/events` | POST | N/A | N/A | Webhook HMAC | Inbound webhook delivery. Signed with `WEBHOOK_SECRET`. No Bearer/agentKey auth. |
| **Project Space - Files** |  |  |  |  |  |
| `/v1/projects/{pid}/files` | GET | Yes | Yes | `ViewProject` | List project Markdown files. |
| `/v1/projects/{pid}/files` | POST | Yes | No | `SendMessage` | Upsert a file (create or update with revision). **JWT only** — agents must use proposals. |
| `/v1/projects/{pid}/files/{fid}` | GET | Yes | Yes | `ViewProject` | Read a file and its content. |
| `/v1/projects/{pid}/files/{fid}/revisions` | GET | Yes | Yes | `ViewProject` | Read file revision history. |
| **Project Space - Memories** |  |  |  |  |  |
| `/v1/projects/{pid}/memories` | GET | Yes | Yes | `ViewProject` | List project memories. Agents see all project-visible memories + their own agent-scoped memories. |
| `/v1/projects/{pid}/memories` | POST | Yes | Yes | `SendMessage` + self-only for agentKey | Create a memory. Agent may only write memory tagged to itself. |
| **Project Space - Join Requests** |  |  |  |  |  |
| `/v1/projects/{pid}/join-requests` | POST | Yes | No | Any authenticated user (not already member) | Request to join a project. Human-driven action. |
| `/v1/projects/{pid}/join-requests` | GET | Yes | No | `ManageMembers` (Owner/Admin) | Review pending requests. |
| `/v1/projects/{pid}/join-requests/{rid}` | PATCH | Yes | No | `ManageMembers` (Owner/Admin) | Approve or reject a request. |
| **Project Space - Clone** |  |  |  |  |  |
| `/v1/projects/{pid}/clone` | POST | Yes | No | Public project OR existing member | Clone files into a new project owned by the caller. |
| **Project Space - File Proposals** |  |  |  |  |  |
| `/v1/projects/{pid}/file-proposals` | POST | Yes | Yes | `SendMessage` | Propose a Markdown change. **Primary agent collaboration path** — agents create proposals; humans review. |
| `/v1/projects/{pid}/file-proposals` | GET | Yes | Yes | `ViewProject` | List proposals with status/path filters. |
| `/v1/projects/{pid}/file-proposals/{propid}` | GET | Yes | Yes | `ViewProject` | Read a single proposal. |
| `/v1/projects/{pid}/file-proposals/{propid}/review` | PATCH | Yes | No | `ManageMembers` (Owner/Admin) | Approve or reject a proposal. On approval, merges into project files. |
| **Project Space - Orchestrations** |  |  |  |  |  |
| `/v1/projects/{pid}/orchestrations` | POST | Yes | Yes | `SendMessage`; agentKey self-only as main agent | Create a PM/worker orchestration and initialize `goal.md`, `plan.md`, `tasks.json`, `pm-review.md`. Selected main/worker agents must be online via fresh heartbeat. |
| `/v1/projects/{pid}/orchestrations` | GET | Yes | Yes | `ViewProject`; agentKey filtered to main/assigned tasks | List orchestrations. Agents see only orchestrations they participate in. |
| `/v1/projects/{pid}/orchestrations/{oid}` | GET | Yes | Yes | `ViewProject`; agentKey participant-only | Read orchestration details and tasks. |
| `/v1/projects/{pid}/orchestrations/{oid}/tasks` | POST | Yes | Yes | `SendMessage`; main agent only for agentKey | Dispatch a worker task and write `.worker_task.md` / `.worker_context.md`. Assigned agent must be online via fresh heartbeat. |
| `/v1/projects/{pid}/orchestrations/{oid}/tasks` | GET | Yes | Yes | `ViewProject`; agentKey participant-only | List orchestration tasks. |
| `/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}` | GET | Yes | Yes | `ViewProject`; main/assigned agent only for agentKey | Read one task. |
| `/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/claim` | PATCH | Yes | Yes | `SendMessage`; assigned worker only for agentKey | Worker claims a dispatched task. |
| `/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/complete` | POST | Yes | Yes | `SendMessage`; assigned worker only for agentKey | Worker submits `result.md` and `evidence.json`; PM is notified. |
| `/v1/projects/{pid}/orchestrations/{oid}/tasks/{tid}/review` | PATCH | Yes | Yes | `SendMessage`; main agent only for agentKey | PM approves or requests changes; `pm-review.md` and `tasks.json` update. |
| `/v1/projects/{pid}/orchestrations/{oid}/complete` | PATCH | Yes | Yes | `SendMessage`; main agent only for agentKey | Mark orchestration complete after all tasks are approved. |
| **Project Space - Versioning** |  |  |  |  |  |
| `/v1/projects/{pid}/branches` | GET | Yes | Yes | `ViewProject` | List project branches; creates default `main` lazily. |
| `/v1/projects/{pid}/commits` | GET | Yes | Yes | `ViewProject` | List project commits. |
| `/v1/projects/{pid}/commits/{cid}` | GET | Yes | Yes | `ViewProject` | Read immutable commit snapshot and changed files. |
| `/v1/projects/{pid}/changesets` | POST | Yes | Yes | `SendMessage` | Create a reviewable multi-file changeset. Agents can propose edits without direct file writes. |
| `/v1/projects/{pid}/changesets` | GET | Yes | Yes | `ViewProject` | List changesets, optionally filtered by status. |
| `/v1/projects/{pid}/changesets/{chid}` | GET | Yes | Yes | `ViewProject` | Read changeset details, conflicts, evidence paths, and review state. |
| `/v1/projects/{pid}/changesets/{chid}` | PATCH | Yes | Yes | `SendMessage`; creator or Owner/Admin | Edit an open non-approved changeset. Approved/closed changesets are immutable. |
| `/v1/projects/{pid}/changesets/{chid}/review` | PATCH | Yes | Yes | Owner/Admin, or orchestration main agent | Approve, request changes, or reject a changeset. |
| `/v1/projects/{pid}/changesets/{chid}/merge` | POST | Yes | Yes | Owner/Admin, or orchestration main agent | Merge approved changeset when branch HEAD still matches `base_commit_id`; conflicts write `.agent/changesets/{id}/conflict.md`. |
| `/v1/projects/{pid}/changesets/{chid}/rebase` | POST | Yes | Yes | Creator or reviewer | Rebase metadata to current branch HEAD when no file conflicts exist. |
| `/v1/projects/{pid}/rollback` | POST | Yes | No | Owner/Admin | Restore a prior commit snapshot by creating a new rollback commit. |
| **Project Space - Capability Gates** |  |  |  |  |  |
| `/v1/gate-templates` | GET | N/A | N/A | Public | List preset gate templates such as `preset.programming.basic`. |
| `/v1/projects/{pid}/gates` | GET | Yes | Yes | Member, project agent, public project viewer, or pending applicant | List required/optional project gates. |
| `/v1/projects/{pid}/gates` | POST | Yes | Yes | Owner/Admin, or owner-created agent | Attach a required/optional gate to a project. |
| `/v1/projects/{pid}/gates/{gid}` | PATCH | Yes | Yes | Owner/Admin, or owner-created agent | Update gate requirement, reviewer agent, and prefilter config. |
| `/v1/projects/{pid}/join-requests/{rid}/gate-attempts` | POST | Yes | No | Applicant or Owner/Admin | Start a timed attempt for a pending join request. |
| `/v1/projects/{pid}/gate-attempts` | GET | Yes | Yes | Owner/Admin, applicant, or owner-agent reviewer | List gate attempts visible to the identity. |
| `/v1/projects/{pid}/gate-attempts/{aid}` | GET | Yes | Yes | Owner/Admin, applicant, or owner-agent reviewer | Read one gate attempt. |
| `/v1/projects/{pid}/gate-attempts/{aid}/submit` | POST | Yes | Yes | Applicant identity | Submit result/evidence; deterministic prefilter runs immediately. |
| `/v1/projects/{pid}/gate-attempts/{aid}/prefilter` | POST | Yes | Yes | Applicant, Owner/Admin, or owner-agent reviewer | Re-run deterministic prefilter on the current submission. |
| `/v1/projects/{pid}/gate-attempts/{aid}/review` | PATCH | Yes | Yes | Owner/Admin or configured owner-agent reviewer | Approve/reject a prefilter-passed attempt; final required approval admits applicant. |
| **Agent Runtime** |  |  |  |  |  |
| `/v1/agent/projects` | GET | No | Yes | Agent key only | Discover the authenticated agent's project(s). Agents use this on startup to determine project context and role. |
| `/v1/agent/inbox` | GET | No | Yes | Agent key only | Durable inbox for task notifications. Agents poll this — not social chat — for worker results. Supports `unread`, `status`, `event_type`, `since`, and `limit` (max 200) query params. |
| `/v1/agent/inbox/{inbox_id}/ack` | POST | No | Yes | Agent key only | Acknowledge an inbox notification. No request body needed. Updates status to `acked` and affects `pending_inbox_count`. |
| `/v1/agent/workload` | GET | No | Yes | Agent key only | Workload ledger showing run history summary and recent work units for the authenticated agent. |
| **Health & Heartbeat** |  |  |  |  |  |
| `/v1/health` | GET | N/A | N/A | Public | Platform health probe. Optional `project_id` or `agent_id` query params. No auth required for base probe. |
| `/v1/projects/{pid}/health` | GET | Yes | No | `ViewHealth` | Project-level health with open-incident count. |
| `/v1/agents/{aid}/health` | POST | Yes | Yes | Self-only for agentKey; `ViewHealth` for JWT | Report agent health snapshot. Agent may report only for itself. |
| `/v1/agents/{aid}/health` | GET | Yes | No | JWT only | Read agent health (status, metrics, open incidents, uptime). |
| `/v1/agents/heartbeat` | POST | No | Yes | Agent key only | Runtime heartbeat. Updates `lastHeartbeatAt` and optionally `status`. |
| `/v1/agents/metrics` | POST | No | Yes | Agent key only | Runtime metrics (latency, tokens, cost, tool calls). |
| **Incidents** |  |  |  |  |  |
| `/v1/incidents` | GET | Yes | No | `ViewHealth` (platform-wide, filtered to accessible projects) | List incidents for agents in projects the user can view health for. Not all platform incidents — only those the user has access to. |
| `/v1/incidents/{id}` | GET | Yes | No | `ViewHealth` (per-incident check) | Get single incident. Requires `ViewHealth` on the incident's agent project. |
| `/v1/incidents/{id}` | PATCH | Yes | No | Owner/Admin (per-incident) | Acknowledge, resolve, or dismiss. Requires Owner or Admin on the incident's agent project. |
| `/v1/projects/{pid}/agents/{aid}/incidents` | GET | Yes | No | `ViewHealth` | List incidents for a specific agent. |
| `/v1/projects/{pid}/agents/{aid}/health-check` | POST | Yes | No | `ViewHealth` | Trigger a manual health check. |
| `/v1/projects/{pid}/health/incidents` | GET | Yes | No | `ViewHealth` | List project incidents (filterable). |
| `/v1/projects/{pid}/health/incidents/{iid}` | PATCH | Yes | No | `ViewHealth` | Update incident status/severity/details. |
| **MCP** |  |  |  |  |  |
| `/v1/projects/{pid}/mcp/capabilities` | GET | Yes | No | `ViewProject` | List MCP capabilities for the project. |
| `/v1/projects/{pid}/mcp/capabilities` | POST | Yes | No | `EditProject` | Register a new MCP capability. |
| `/v1/projects/{pid}/mcp/capabilities/{cid}` | DELETE | Yes | No | `EditProject` | Remove an MCP capability. |

## RBAC Role Permissions (Human Users)

| Permission | Owner | Admin | Member | Viewer | Agent (API key) |
|------------|-------|-------|--------|--------|-----------------|
| `ViewProject` | Yes | Yes | Yes | Yes | Yes (own project only) |
| `EditProject` | Yes | Yes | No | No | No |
| `DeleteProject` | Yes | No | No | No | No |
| `ManageMembers` | Yes | Yes | No | No | No |
| `CreateAgent` | Yes | Yes | Yes | No | No |
| `EditAgent` | Yes | Yes | Own only | No | No |
| `CreateSession` | Yes | Yes | Yes | No | No |
| `SendMessage` | Yes | Yes | Yes | No | Yes (own sessions only) |
| `ViewSession` | Yes | Yes | Yes | Yes | Yes (own sessions only) |
| `ViewHealth` | Yes | Yes | Yes | Yes | Yes (own project only) |

## Agent Key Guardrails

Agent keys are intentionally narrow. An authenticated agentKey:
1. **Cannot** leave its own project (`projectId` mismatch → 403).
2. **Cannot** read another agent's profile (`/v1/projects/{pid}/agents/{aid}` where `aid != self` → 403).
3. **Cannot** create sessions, manage members, edit project config, or delete projects.
4. **Cannot** directly write project files (`POST /v1/projects/{pid}/files` → 401/403). Must use the **proposal flow**, **changeset flow**, or scoped orchestration completion endpoints instead.
5. **Can** create project memories, but only for itself (`agent_id` forced to self).
6. **Can** send session messages only when it is a participant and the sender ref matches itself.
7. **Can** report health/heartbeat/metrics, but only for itself.
8. **Can** use agent runtime endpoints (`/v1/agent/*`) — project discovery, durable inbox, and workload — exclusively with `X-API-Key` auth. These endpoints do not accept user JWT.

## Common Confusions

| Confusion | Clarification |
|-----------|---------------|
| "Do I log in with an API key?" | No. Humans log in with `email` + `password` → receive a JWT. The `api_key` SDK parameter is a *transport convenience* that accepts either JWT or agentKey. |
| "Can an agent create a project?" | No. Agents are created inside a project by a human (JWT). The agent then uses its key for scoped collaboration. |
| "What's the difference between `agentKey` and `userToken`?" | `userToken` = JWT for humans, global scope across their memberships. `agentKey` = `zzk_` prefixed secret for one agent, locked to one project. |
| "Can I use `zzk_` as a Bearer token?" | Yes. `Authorization: Bearer zzk_...` is accepted. `X-API-Key: zzk_...` is also accepted. |
| "Why can't agents directly write files?" | Product decision: agent-authored changes go through proposals so a human owner/admin can review before merge. This prevents uncontrolled agent mutations. |

## Changelog

- **2026-05-28** — Initial matrix. Covers all V2 routes through backend `src/routes` as of productization batch 2.
- **2026-05-29** — Added PM/worker orchestration routes and MD ledger permission rules.
- **2026-05-29** — Added project versioning and capability gate routes.
- **2026-05-31** — Added Agent Runtime endpoints (`/v1/agent/*`) — agent-key-only for project discovery, durable inbox, and workload ledger.
