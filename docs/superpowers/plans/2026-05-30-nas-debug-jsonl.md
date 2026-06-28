# NAS Debug JSONL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NAS/LAN debugging practical by persisting structured JSONL logs to a host-visible path and exposing token-protected recent-log queries.

**Architecture:** Reuse the existing structured logger and debug routes, then close product gaps: richer query filters, API tests, OpenAPI documentation, and NAS bind-mounted logs. Keep the endpoint operator-only through `DEBUG_LOG_API_TOKEN`.

**Tech Stack:** Express, TypeScript, JSONL, Docker Compose, Nginx reverse proxy, OpenAPI YAML.

---

### Task 1: Confirm Existing Structure

**Files:**
- Read: `backend/src/services/logger.ts`
- Read: `backend/src/routes/debug.routes.ts`
- Read: `backend/src/app.ts`
- Read: `deploy/nas/docker-compose.yml`
- Read: `deploy/nas/nginx.conf`
- Read: `docs/nas-lan-debugging.md`

- [x] Confirm backend already emits structured stdout logs through `requestLog`.
- [x] Confirm file JSONL logging is controlled by `DEBUG_LOG_ENABLED`, `DEBUG_LOG_FILE`, `DEBUG_LOG_MAX_BYTES`, and `DEBUG_LOG_MAX_FILES`.
- [x] Confirm debug routes are mounted at `/v1/debug/logs` and proxied by NAS Nginx under `/agent/v1/debug/logs`.
- [x] Identify gaps: NAS compose uses a named volume instead of a host-visible log path, debug API lacks status/duration/path filters, and OpenAPI does not document debug endpoints.

### Task 2: Add Failing Debug API Test

**Files:**
- Create: `backend/tests/debug-log-api.test.ts`
- Modify: `backend/package.json`

- [x] Write an integration test that starts the Express app with a temporary `DEBUG_LOG_FILE`.
- [x] Assert missing `X-Debug-Token` is rejected.
- [x] Assert `status=409`, `status_class=5xx`, `min_duration_ms=1000`, and `path=/v1/debug-target` filters return only matching JSONL entries.
- [x] Run the test and confirm it fails before implementation because the route ignores these filters.

### Task 3: Implement Rich Log Query Filters

**Files:**
- Modify: `backend/src/services/logger.ts`
- Modify: `backend/src/routes/debug.routes.ts`

- [x] Extend `ReadLogQuery` with `status`, `statusMin`, `statusMax`, `statusClass`, `minDurationMs`, and `path`.
- [x] Parse and validate query parameters in the debug route.
- [x] Apply filters in `readRecentLogEntries`.
- [x] Preserve JSON and NDJSON output modes.

### Task 4: NAS Deploy And Docs

**Files:**
- Modify: `deploy/nas/docker-compose.yml`
- Modify: `deploy/nas/README.md`
- Modify: `docs/nas-lan-debugging.md`
- Modify: `openapi-v2.yaml`

- [x] Change NAS backend logs to a host-visible bind mount using `${DEBUG_LOG_HOST_DIR:-./logs}`.
- [x] Document `.env` variables including `DEBUG_LOG_HOST_DIR`, `DEBUG_LOG_API_TOKEN`, retention, and query examples.
- [x] Add OpenAPI schemas and paths for `/v1/debug/logs` and `/v1/debug/logs/config`.

### Task 5: Verify And Review

**Files:**
- All touched files

- [x] Run local backend unit tests.
- [x] Parse OpenAPI.
- [x] Validate NAS compose config.
- [x] Dispatch a read-only PM worker review.
- [x] Review worker `result.md` and `evidence.json`, request fixes if needed, then accept only after verification.
- [x] Deploy to NAS and smoke-test the JSONL file plus debug API through `/agent/v1/debug/logs`.
