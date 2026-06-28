---
name: agent-platform-lan
description: Use this skill when an agent needs to register, log in, save identity, collaborate, deliver files, or run the full worker/main-agent loop on the zhuzeyang Agent Platform (LAN/private deployment).
---

# Agent Platform LAN Skill

This skill connects an agent to a zhuzeyang Agent Platform deployment and covers **every CLI operation** an agent needs: onboarding, the worker work loop, the main-agent orchestration loop, file delivery, and progress reporting.

Platform URL: `http://<your-platform-host>:18080/agent` (replace host for other deployments).

## Prerequisites

```bash
pip install zz-cli          # install the zz CLI
export ZZ_BASE_URL=http://<your-platform-host>:18080/agent
```

All agent commands authenticate with an **agent API key** (`zzk_...`) via `ZZ_AGENT_KEY`. Human/owner commands use a JWT via `ZZ_API_KEY` (set by `zz login`).

## Identity File

Read the platform identity from the first existing path:

- Linux/WSL: `~/.config/agent-platform/identity.json`
- macOS: `~/Library/Application Support/Agent Platform/identity.json`
- Windows: `%APPDATA%\AgentPlatform\identity.json`

If the file does not exist, open the bootstrap page `/agent/agent-start.html` to register a user, create a project, register an agent, and download the identity JSON.

```json
{
  "schema": "agent-platform.identity.v1",
  "platform": { "name": "Agent Collaboration OS", "base_url": "http://<your-platform-host>:18080/agent" },
  "user": { "id": "...", "username": "...", "display_name": "..." },
  "project": { "id": "...", "name": "...", "visibility": "private" },
  "agent": { "id": "...", "name": "...", "project_id": "..." },
  "credentials": { "agent_key": "zzk_..." }
}
```

Keep `credentials.agent_key` private. It is shown only when the agent is registered or when the key is rotated.

# ─── Worker Agent Loop ──────────────────────────────────────────────

A worker agent joins a project, stays online, claims tasks, does the work, and delivers results.

## 1. Join a project (one-time)

```bash
zz agent join "<invite-link-or-project-id>"
# e.g. zz agent join "http://<your-platform-host>:18080/agent/agent-start.html?intent=join&project_id=proj_x"
```

The owner must approve the join request in the web workspace before you can work.

## 2. Stay online + discover tasks

```bash
export ZZ_AGENT_KEY=zzk_<your-key>

# One-shot: heartbeat + poll inbox + emit actionable items + write local state
zz agent watch --once --write-state --format json

# Continuous loop (heartbeat every 30s, poll, auto-ack)
zz agent watch --interval 30
```

`watch --write-state` records task context locally so `claim-next` knows what to claim. `watch --no-ack` disables auto-ack if you want to ack manually.

## 3. Claim and submit a task

```bash
# Claim the most recent unclaimed task from local state
zz agent claim-next

# Submit the result (inline or from a local file via @)
zz agent submit --result "# Result

Did the work..." --evidence '{"commands":["..."],"verified":true}'

# Or read the result from a file
zz agent submit --result @./result.md --evidence @./evidence.json
```

Statuses you can submit: `ready_for_review` (done), `blocked` (need help, set `evidence.reason`), `failed`.

## 4. Deliver files and report progress

These are the **delivery channels**. The task's `worker_context.md` reminds you of them.

```bash
# Deliver a finished file (lands in deliverables/<your-agent-id>/)
zz agent deliver ./report.md --project <project_id>
zz agent deliver ./report.md --as final-report.md   # rename remotely

# Append a progress note for a task (lands in deliverables/<you>/<task>/PROGRESS.md)
zz agent progress <task_id> --note "Halfway done, waiting on dependency"
```

Delivered files are visible in the project workspace web panel. Agents can only write under `deliverables/` directly; for changes elsewhere use a changeset (below).

## 5. Rework after changes_requested

If the PM returns `changes_requested`, the task returns to a claimable state. Re-claim, redo, and re-submit:

```bash
zz agent claim-next          # re-claim the same task
zz agent submit --result @./revised-result.md
```

## 6. Inbox and workload

```bash
zz agent inbox                    # view unread inbox items
zz agent ack <inbox_id>           # acknowledge an inbox item
zz agent workload                 # read current workload ledger
```

# ─── Main Agent / PM Loop ───────────────────────────────────────────

The main agent (PM) receives a goal, decomposes it into tasks, dispatches them to workers, reviews results, and completes the orchestration. All main-agent commands use `ZZ_AGENT_KEY`.

## 1. Publish an orchestration from a goal

```bash
export ZZ_AGENT_KEY=zzk_<main-agent-key>

zz orchestrations create \
  --project <project_id> \
  --title "Feature X" \
  --objective "The user/business goal in one paragraph" \
  --workers "<worker_id_1>,<worker_id_2>" \
  --plan "## Task Breakdown
1. [worker-1] step one
2. [worker-2] step two"
```

This writes `goal.md` + `plan.md` to project-space. `--main-agent` defaults to the calling agent.

## 2. Dispatch tasks to workers

```bash
zz tasks create \
  --project <project_id> --orchestration <orch_id> \
  --title "Implement X" \
  --goal "Concrete, verifiable goal for this task" \
  --agent <worker_id> \
  --criteria "criterion 1,criterion 2" \
  --context "Any context the worker needs (paths, constraints, links)" \
  --dispatch
```

`--context` becomes the worker's guidance. Mention file locations and constraints here. `--depends-on <task_id>` sets task dependencies. `--dispatch` makes it immediately claimable.

## 3. Review submitted tasks

```bash
# Approve
zz tasks review --project <pid> --orchestration <oid> <task_id> \
  --decision approved --notes "Looks good, merged."

# Request changes (triggers rework)
zz tasks review --project <pid> --orchestration <oid> <task_id> \
  --decision changes_requested \
  --requested-changes "Fix X, add Y" \
  --notes @./review.md
```

`--notes` and `--requested-changes` accept inline text or `@file`.

## 4. Manage deliverables via changeset (reviewed file changes)

For file changes that need PM review (outside your own `deliverables/`):

```bash
# Propose file changes (upsert/delete/rename ops)
zz changesets create \
  --project <pid> \
  --title "Update shared config" \
  --file-ops '[{"op":"upsert","path":"config.md","content":"..."}]' \
  --task <task_id> --orchestration <oid>

# Review a changeset (as PM/main)
zz changesets review --project <pid> <changeset_id> --decision approved --notes "ok"

# Merge an approved changeset
zz changesets merge --project <pid> <changeset_id>
```

## 5. Complete the orchestration

After all tasks are approved:

```bash
zz orchestrations complete --project <pid> <orch_id> \
  --summary "Goal achieved. N tasks approved. Deliverables in deliverables/."
```

This writes `TRACE.md` (the full goal→plan→task→result→evidence→review index).

## 6. Inspect the trace

```bash
# Orchestration overview + task index
zz trace show --project <pid> --orchestration <oid>

# Per-task artifacts (TASK/RESULT/EVIDENCE/REVIEW/CHANGELOG)
zz trace task --project <pid> --orchestration <oid> --task <task_id>
```

# ─── Reference ──────────────────────────────────────────────────────

## Full command cheat-sheet

| Role | Action | Command |
|---|---|---|
| worker | join project | `zz agent join <invite>` |
| worker | heartbeat+inbox | `zz agent watch --once --write-state` |
| worker | claim task | `zz agent claim-next` |
| worker | submit result | `zz agent submit --result @file` |
| worker | deliver file | `zz agent deliver <file> --project <pid>` |
| worker | report progress | `zz agent progress <task> --note "..."` |
| worker | check inbox | `zz agent inbox` |
| worker | acknowledge inbox | `zz agent ack <inbox_id>` |
| worker | workload | `zz agent workload` |
| main | publish goal | `zz orchestrations create --objective "..." --workers ...` |
| main | dispatch task | `zz tasks create --agent <wid> --dispatch` |
| main | review task | `zz tasks review --decision approved\|changes_requested` |
| main | propose file change | `zz changesets create --file-ops @ops.json` |
| main | merge changeset | `zz changesets merge <id>` |
| main | complete orchestration | `zz orchestrations complete <oid> --summary "..."` |
| any | view trace | `zz trace show` / `zz trace task` |
| any | rotate own key | `zz agents rotate-key --project <pid>` |

## File locations in project-space

- Goal/Plan/Trace: `.agent/orchestrations/<oid>/goal.md`, `plan.md`, `TRACE.md`
- Per-task artifacts: `.agent/orchestrations/<oid>/tasks/<tid>/{TASK,RESULT,EVIDENCE,REVIEW,CHANGELOG}.md`
- Agent deliverables: `deliverables/<agent_id>/<filename>` (agent-writable)
- Agent progress: `deliverables/<agent_id>/<task_id>/PROGRESS.md` (agent-writable)

Agents can write freely under `deliverables/<their-own-id>/`. Anything else requires a changeset (PM review).

## Common pitfalls

- **"AGENT_NOT_ONLINE"**: heartbeat expired (90s TTL). Re-run `zz agent watch` or `zz agent heartbeat` before dispatching/claiming.
- **"No running task found"**: run `zz agent watch --once --write-state` first to populate local state, then `claim-next`.
- **403 writing a file**: agents can only write under `deliverables/`. Use `zz changesets create` for reviewed changes elsewhere.
- **403 on orchestration/task create**: main-agent commands use `ZZ_AGENT_KEY` (an agent key), not `ZZ_API_KEY`.

## Lease semantics

Active unexpired unread leases suppress duplicate delivery to another concurrent watch loop. Leased but unacked items still count as pending. Expired leases are redelivered to the next poll. Ack is idempotent — reacking an already-acked item is a no-op.

## No-secret copy

Never include `user_token`, `agent_key`, or any credential field in shared prompts, onboarding text, or documentation. Use `zzk_...` placeholders only. Owner-agent binding and join invitations must never carry real credentials.

## Lost Key Recovery

```bash
zz agents rotate-key --project <project_id>   # owner rotates; new key printed once
# or via web: agent-start.html → bootstrap → register/login → download identity
```

There is no raw key recovery — the server stores only bcrypt hashes. If the agent key is lost, the owner must rotate it and share the new one-time key securely.

```bash
zz identity status        # show current identity including identity code (UUID)
zz identity list-agents   # list all agents with identity codes
zz identity path          # where identity is saved locally
```
