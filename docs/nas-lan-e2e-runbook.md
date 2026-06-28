# NAS LAN E2E Runbook: Publish → Worker Complete → Changeset → Merge

This runbook tests the full main-agent publish, worker completion, changeset
submit, and main-agent merge loop on the NAS LAN deployment.

**Platform:** `http://<your-platform-host>:18080/agent`
**Project:** `测试` (3e57c6e5-7c51-4aad-8a14-5e02b0257d60)
**Owner:** 高级 (457251027@qq.com) — owner approves agent membership

---

## Roles

| Role | Who | Notes |
|------|-----|-------|
| Human owner | You | Create project, approve agent join, create orchestration |
| Main agent | hermes-runtime | PM: plans, dispatches, reviews, merges |
| Worker agent | A second registered agent | Executes scoped task, writes result.md/evidence.json |

---

## Prerequisites

- NAS is running: `curl http://<your-platform-host>:18080/agent/v1/health`
- Docker logs accessible: `docker compose --env-file .env logs -f backend`
- JSONL debug logs: `sudo tail -f /data/zz-agent-platform/logs/zz-agent-debug.jsonl`

---

## Phase 0 — Baseline Health Check

```bash
# 1. Cloud health (from anywhere)
curl https://www.zhuzeyang.xyz/agent/v1/health

# 2. NAS LAN health (from LAN machine or WSL)
curl http://<your-platform-host>:18080/agent/v1/health

# 3. Running containers
docker compose --env-file .env ps

# 4. Backend errors in last 50 lines
docker compose --env-file .env logs --tail=50 backend | grep -i error
```

---

## Phase 1 — Human Owner: Create Project and Register Agents

Open **human-workspace-simple.html** on the LAN URL:

```
http://<your-platform-host>:18080/agent/human-workspace-simple.html
```

1. Login/register as the human owner (email + password)
2. Verify the project `测试` already exists, or create a new one
3. Note the **project ID** from the URL or API response

### Register the Main Agent

Open **agent-start.html** on the NAS URL:

```
http://<your-platform-host>:18080/agent/agent-start.html
```

1. Click **Copy skill** and save the skill JSON — this is the main agent's bootstrap
2. The skill contains: register/login endpoints, project discovery, heartbeat,
   durable inbox, workload, and orchestration claim/complete/review APIs
3. Run the agent bootstrap using the skill (agent runtime does this automatically)

### Register the Worker Agent

On a **second LAN machine** (or second browser context), open agent-start.html
and repeat the bootstrap. Each agent gets its own identity JSON and API key.

### Approve Agent Membership

The human owner submits join requests for each agent. As owner, approve them:

```
http://<your-platform-host>:18080/agent/human-workspace.html
 → Project → Members → Pending Join Requests → Approve
```

Approval sequence to treat as authoritative:

1. The owner sees the pending join request in the web UI.
2. The owner approves or rejects the request.
3. If approved, the resulting role is the requested role unless an authorized owner explicitly overrides it.
4. The `requested_role` value from the invite URL is user-controlled input only; it is not a signed permission grant.

Or via API (as owner/JWT):

```bash
# Get pending join requests
curl -s "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/join-requests" \
  -H "Authorization: Bearer ${OWNER_JWT}" | jq

# Approve (replace {request_id})
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/join-requests/{request_id}/approve" \
  -H "Authorization: Bearer ${OWNER_JWT}"
```

---

## Phase 2 — Main Agent: Publish Task / Create Orchestration

The main agent discovers the project and creates an orchestration:

```bash
# Main agent: discover projects
curl -s "http://<your-platform-host>:18080/agent/v1/agent/projects" \
  -H "X-API-Key: ${MAIN_AGENT_KEY}" | jq

# Main agent: create orchestration
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/orchestrations" \
  -H "X-API-Key: ${MAIN_AGENT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "E2E smoke orchestration",
    "objective": "Verify worker result submission and PM review end-to-end.",
    "main_agent_id": "'"${MAIN_AGENT_ID}"'",
    "worker_agent_ids": ["'"${WORKER_AGENT_ID}"'"],
    "acceptance_criteria": ["Worker result.md and evidence.json submitted", "PM approves"],
    "plan": "1. Dispatch 2. Worker completes 3. PM reviews 4. Changeset 5. Merge"
  }' | jq
```

Note the returned `orchestration_id`.

---

## Phase 3 — Worker: Watch / Complete Task

### Worker watches for dispatched tasks

```bash
# Worker: heartbeat (must be online before receiving work)
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/agents/heartbeat" \
  -H "X-API-Key: ${WORKER_AGENT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"status":"active"}' | jq '{ok, is_online, dispatchable, pending_inbox_count}'

# Worker: poll inbox for task_dispatched item
curl -s "http://<your-platform-host>:18080/agent/v1/agent/inbox?unread=true&event_type=task_dispatched" \
  -H "X-API-Key: ${WORKER_AGENT_KEY}" | jq
```

### Worker claims and completes

```bash
# Worker: claim task (replace orchestration_id and task_id)
curl -s -X PATCH "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/orchestrations/${ORCHESTRATION_ID}/tasks/${TASK_ID}/claim" \
  -H "X-API-Key: ${WORKER_AGENT_KEY}" | jq '{status}'

# Worker: complete with result.md and evidence.json
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/orchestrations/${ORCHESTRATION_ID}/tasks/${TASK_ID}/complete" \
  -H "X-API-Key: ${WORKER_AGENT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "result_md": "# Result\n\nE2E smoke task completed.\n",
    "evidence": {
      "commands_run": ["echo smoke-pass"],
      "files_changed": ["docs/smoke-output.md"],
      "test_passed": true
    },
    "status": "ready_for_review"
  }' | jq '{status}'
```

---

## Phase 4 — Main Agent: Review Task

```bash
# Main agent: poll inbox for task_ready_for_review
curl -s "http://<your-platform-host>:18080/agent/v1/agent/inbox?unread=true&event_type=task_ready_for_review" \
  -H "X-API-Key: ${MAIN_AGENT_KEY}" | jq

# Main agent: review (approve)
curl -s -X PATCH "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/orchestrations/${ORCHESTRATION_ID}/tasks/${TASK_ID}/review" \
  -H "X-API-Key: ${MAIN_AGENT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "decision": "approved",
    "notes": "E2E smoke approved."
  }' | jq '{status}'
```

---

## Phase 5 — Changeset: Create / Review / Merge

### Create changeset

```bash
# Main agent or owner: create changeset
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/changesets" \
  -H "X-API-Key: ${MAIN_AGENT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "E2E smoke result changeset",
    "orchestration_id": "'"${ORCHESTRATION_ID}"'",
    "task_id": "'"${TASK_ID}"'",
    "result_path": ".agent/orchestrations/'"${ORCHESTRATION_ID}"'/result.md",
    "evidence_path": ".agent/orchestrations/'"${ORCHESTRATION_ID}"'/evidence.json",
    "file_ops": [
      {
        "op": "upsert",
        "path": "docs/smoke-output.md",
        "content": "# E2E Smoke Output\n\nPhase 4 complete.\n",
        "content_type": "text/markdown",
        "base_revision_id": null
      }
    ]
  }' | jq '{id, status}'
```

Note the returned `changeset_id`.

### Review changeset

```bash
# Owner or main agent: review changeset
curl -s -X PATCH "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/changesets/${CHANGESET_ID}/review" \
  -H "Authorization: Bearer ${OWNER_JWT}" \
  -H "Content-Type: application/json" \
  -d '{"decision": "approved", "notes": "LGTM"}' | jq '{status}'
```

### Merge changeset

```bash
# Owner or main agent: merge approved changeset
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/changesets/${CHANGESET_ID}/merge" \
  -H "Authorization: Bearer ${OWNER_JWT}" | jq '{changeset: {status: .changeset.status}, commit: {id: .commit.id}}'
```

---

## Phase 6 — Verify Project Files / Commits

```bash
# List branches
curl -s "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/branches" \
  -H "Authorization: Bearer ${OWNER_JWT}" | jq

# List commits
curl -s "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/commits" \
  -H "Authorization: Bearer ${OWNER_JWT}" | jq '.[0:3]'

# Get specific commit
curl -s "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/commits/${COMMIT_ID}" \
  -H "Authorization: Bearer ${OWNER_JWT}" | jq '{id, message, changed_files}'
```

---

## Gitea Sync Gate

The platform may sync changesets to a Gitea instance. The gate is controlled by
the `GITEA_SYNC_ENABLED` environment variable on the backend.

### Dry-run mode (default in dev)

```bash
# No Gitea credentials needed. Changesets stay local.
# Verify sync is off:
docker compose --env-file .env exec backend env | grep GITEA
# Should show: GITEA_SYNC_ENABLED=false  (or unset)
```

### Real-sync mode

```bash
# Set on backend before deployment or in .env:
GITEA_URL=https://your-gitea.example.com
GITEA_TOKEN=<gitea-personal-access-token>
GITEA_SYNC_ENABLED=true
GITEA_REPO=owner/repo

# Redeploy:
docker compose --env-file .env up -d --build backend

# After merge, verify Gitea commit appears:
# GET /v1/projects/{project_id}/commits — commit.gitea_sync_status field
```

---

## Troubleshooting

### Agent not showing as online

```bash
# 1. Check heartbeat
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/agents/heartbeat" \
  -H "X-API-Key: ${AGENT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"status":"active"}' | jq '{is_online, dispatchable, pending_inbox_count}'

# 2. Check API key is correct (prefix zzk_c792...)
# 3. Verify JWT not expired for owner operations
# 4. Check backend logs:
docker compose --env-file .env logs --tail=20 backend
```

### task_dispatched not appearing in inbox

```bash
# Retry polling with event_type filter
curl -s "http://<your-platform-host>:18080/agent/v1/agent/inbox?unread=true&event_type=task_dispatched" \
  -H "X-API-Key: ${WORKER_AGENT_KEY}" | jq '.data | length'

# If 0, main agent may not have dispatched yet, or worker is not dispatchable
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/agents/heartbeat" \
  -H "X-API-Key: ${WORKER_AGENT_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"status":"active"}' | jq '.dispatchable'
```

### Changeset stuck in submitted state

```bash
# Check base_commit_id matches current branch HEAD
curl -s "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/branches" \
  -H "Authorization: Bearer ${OWNER_JWT}" | jq

# If another merge advanced HEAD, changeset enters 'conflict' state.
# Rebase it:
curl -s -X POST "http://<your-platform-host>:18080/agent/v1/projects/${PROJECT_ID}/changesets/${CHANGESET_ID}/rebase" \
  -H "Authorization: Bearer ${OWNER_JWT}" | jq '{status}'
```

### NAS JSONL debug log locations

| Location | Command |
|----------|---------|
| Inside container | `docker compose --env-file .env exec backend tail -f /var/log/zz-agent/zz-agent-debug.jsonl` |
| On NAS host | `sudo tail -f /data/zz-agent-platform/logs/zz-agent-debug.jsonl` |
| Via debug API | `curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" "http://<your-platform-host>:18080/agent/v1/debug/logs?lines=200"` |

Filter debug logs by:

```bash
# By agent
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<your-platform-host>:18080/agent/v1/debug/logs?agent_id=${AGENT_ID}&lines=100"

# By project
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<your-platform-host>:18080/agent/v1/debug/logs?project_id=${PROJECT_ID}&lines=100"

# By status class (5xx errors)
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<your-platform-host>:18080/agent/v1/debug/logs?status_class=5xx&lines=50"

# Slow requests (>1000ms)
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<your-platform-host>:18080/agent/v1/debug/logs?min_duration_ms=1000&lines=50"
```

### Gitea sync issues

```bash
# Check if Gitea sync is enabled in backend env
docker compose --env-file .env exec backend env | grep GITEA

# Check for Gitea-related errors in backend logs
docker compose --env-file .env logs --tail=50 backend | grep -i gitea

# Verify Gitea token has repo:write scope
# If sync is failing, set GITEA_SYNC_ENABLED=false to bypass
# and handle merge manually via dashboard
```

---

## Smoke Verification Checklist

Run after any deployment or configuration change:

- [ ] `curl http://<your-platform-host>:18080/agent/v1/health` returns 200
- [ ] `BASE_URL=http://<your-platform-host>:18080/agent bash deploy/smoke.sh` passes
- [ ] `BASE_URL=http://<your-platform-host>:18080/agent RUN_ORCHESTRATION_SMOKE=1 bash deploy/smoke.sh` passes
- [ ] `ALLOW_REMOTE_VERIFY=1 BASE_URL=http://<your-platform-host>:18080/agent bash deploy/verify.sh --multiworker-smoke` passes
- [ ] Two agents can register and show online after heartbeat
- [ ] Main agent creates orchestration, worker receives task_dispatched
- [ ] Worker completes, main agent reviews and approves
- [ ] Changeset creates, reviews to approved, merges
- [ ] `GET /v1/projects/{id}/commits` shows new merge commit
