# Online Agent Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure project orchestration work is assigned only to agents that are currently online.

**Architecture:** Add a shared backend presence service derived from agent heartbeat timestamps and registry status. Expose presence fields in agent/health APIs, enforce the rule in orchestration creation and task assignment, and reflect it in the human workspace and agent bootstrap skill.

**Tech Stack:** Express, TypeORM, TypeScript, static HTML dashboard, OpenAPI YAML.

---

### Task 1: Backend Presence Rule

**Files:**
- Create: `backend/src/services/agent-presence.service.ts`
- Modify: `backend/src/routes/agents.routes.ts`
- Modify: `backend/src/routes/health.routes.ts`
- Test: `backend/tests/orchestrations.test.ts`

- [x] Write a failing regression test proving agents without heartbeat are `offline` and orchestration creation returns `409 AGENT_NOT_ONLINE`.
- [x] Add shared presence calculation with `online`, `stale`, and `offline` states.
- [x] Serialize `presence`, `is_online`, `dispatchable`, `last_heartbeat_at`, and `heartbeat_age_ms` on agent list/detail responses.
- [x] Reuse the presence service in health snapshots so agents with no heartbeat are not reported as healthy.
- [x] Run the focused orchestration regression test.

### Task 2: Dispatch Gate

**Files:**
- Modify: `backend/src/routes/orchestrations.routes.ts`
- Test: `backend/tests/orchestrations.test.ts`

- [x] Reject orchestration creation when selected main/worker agents are missing or not dispatchable.
- [x] Reject new task creation when `assigned_agent_id` is not dispatchable.
- [x] Return actionable error JSON with `code`, `offline_agent_ids`, and `heartbeat_ttl_seconds`.
- [x] Verify a fresh `POST /v1/agents/heartbeat` permits orchestration creation and task dispatch.

### Task 3: Human Workspace And Agent Skill

**Files:**
- Modify: `dashboard/human-workspace.html`
- Modify: `dashboard/agent-start.html`
- Modify: `dashboard/agent-platform.skill.md`

- [x] Display online/offline/stale presence and last heartbeat in the agent list.
- [x] Disable offline/stale agents in the orchestration main/worker picker.
- [x] Add client-side validation before orchestration creation.
- [x] Teach agents to send heartbeat every 30 seconds while online.

### Task 4: API Docs And NAS Notes

**Files:**
- Modify: `openapi-v2.yaml`
- Modify: `docs/orchestration.md`
- Modify: `docs/auth-permission-matrix.md`
- Modify: `docs/nas-lan-debugging.md`
- Modify: `deploy/nas/README.md`

- [x] Document presence fields and heartbeat route.
- [x] Document the online-only orchestration/task assignment rule.
- [x] Document NAS/LAN test steps for heartbeat before task assignment.
- [x] Run full backend tests, OpenAPI parse, dashboard syntax check, worker review, NAS deploy, and NAS smoke.
