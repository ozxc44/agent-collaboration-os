# Pre-Release Gate Runbook

> **Source of truth:** `.codex/pm-workers/golden-path-ledger.md`
> **Verification tooling:** `deploy/verify.sh`, `deploy/smoke.sh`
> **Status:** Accepted Golden Path verification chain (Batch 4, hermes-e)
> **Last updated:** 2026-06-20

---

## 1. Gate Order

All gates must pass **in order**. Stop on the first failure; do not proceed to a later gate until the current one exits 0.

| # | Gate | Command | Requires running server? |
|---|------|---------|--------------------------|
| 1 | Backend typecheck | `cd backend && npm run typecheck` | No |
| 2 | Backend unit tests | `cd backend && npm run test:unit` | No |
| 3 | Dashboard JS syntax | `node scripts/check-dashboard-syntax.js dashboard` | No |
| 3b | MD-driven PM trace fixture gate | `node scripts/validate-md-pm-trace.test.js` | No |
| 4 | SDK import check | `python3 -m pip install -q -e sdk/python && python3 -c "import zz_agent; print('ok')"` | No |
| 5 | CLI import check | `python3 -m pip install -q -e cli && python3 -c "import zz_cli; print('ok')"` | No |
| 6 | Local orchestration smoke | `bash deploy/verify.sh --orchestration-smoke` | Yes (localhost:3000) |
| 7 | Multi-worker E2E smoke | `ALLOW_REMOTE_VERIFY=1 BASE_URL=http://<your-platform-host>:18080/agent bash deploy/verify.sh --multiworker-smoke` | Yes (NAS LAN) |
| 8 | Lease/redelivery smoke | `INBOX_LEASE_TTL_MS=2000 RUN_LEASE_SMOKE=1 bash deploy/verify.sh --orchestration-smoke` | Yes (localhost:3000, short TTL) |
| 9 | TTFT measurement | `bash deploy/measure-ttft.sh` | Yes (localhost:3000, auto-started if missing) |

### 1.1 Prerequisites

```bash
# From repo root
export BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
```

The remote opt-in guard (`ALLOW_REMOTE_VERIFY=1`) is **not required** for local pre-release verification against `127.0.0.1:3000`. Verify.sh uses `is_local_base_url()` to detect this and allows all gates without opt-in.

> **Safety invariant:** `deploy/smoke.sh` independently runs `require_local_or_opt_in()` before any request, so a direct call with a production `BASE_URL` is refused unless `ALLOW_REMOTE_VERIFY=1` is set. This is a layered guard — both `verify.sh` (§5.7 of Golden Path ledger) and `smoke.sh` (§6 of Batch 3 result) enforce it.

---

## 2. Gate Details

### Gate 1: Backend Typecheck

```bash
cd backend && npm run typecheck
```

Expected: exit 0, no errors. This is `tsc --noEmit` over the full backend source.

### Gate 2: Backend Unit Tests

```bash
cd backend && npm run test:unit
```

Expected: exit 0. Test:unit compiles then runs the compiled test suite. All tests must pass.

### Gate 3: Dashboard JS Syntax

```bash
node scripts/check-dashboard-syntax.js dashboard
```

Expected: exit 0, "0 errors". Checks all inline `<script>` content in every `dashboard/*.html` file.

### Gate 3b: MD-Driven PM Trace Fixture Gate

```bash
node scripts/validate-md-pm-trace.test.js
```

Expected: exit 0, `validate-md-pm-trace fixture tests passed`.

This test runs the final local acceptance validator against:

- `fixtures/md-pm-trace/pass`: a fully accepted `GOAL.md` -> `PLAN.md` -> `TRACE.md` -> per-task `TASK.md`/`RESULT.md`/`EVIDENCE.md`/`REVIEW.md` package.
- `fixtures/md-pm-trace/fail-missing-evidence`: verifies that a missing required artifact exits non-zero.
- `fixtures/md-pm-trace/fail-bad-state`: verifies that invalid task transitions and inaccessible evidence block final acceptance.

To validate a real exported project-space package directly:

```bash
node scripts/validate-md-pm-trace.js <artifact-dir> --pretty
```

The command emits one JSON report with `ok`, `final_accepted`, `checks[]`,
`artifacts`, and `gk_gates[]`. Treat `ok: true` plus `final_accepted: true` as
the MD-package gate only. It does not replace live CLI, permission, claim-race,
or NAS deployment checks.

### Gate 4: SDK Import Check

```bash
python3 -m pip install -q -e sdk/python && \
python3 -c "import zz_agent; print('zz_agent', getattr(zz_agent, '__version__', 'ok'))"
```

Expected: exit 0. Requires Python >= 3.10.

### Gate 5: CLI Import Check

```bash
python3 -m pip install -q -e cli && \
python3 -c "import zz_cli; print('zz_cli', getattr(zz_cli, '__version__', 'ok'))"
```

Expected: exit 0. Requires Python >= 3.10.

### Gate 6: Local Orchestration Smoke

This is the **core Golden Path end-to-end verification**. It registers two agents (PM main + worker), creates an orchestration, dispatches a task, asserts the worker inbox item, claims the task, completes it, asserts the PM review inbox, approves the review, and verifies workload summaries.

```bash
# Boot a local server first (separate terminal):
#   cd backend && npm run build && NODE_ENV=test node dist/src/index.js
#
# Then, from a second terminal:
bash deploy/verify.sh --orchestration-smoke
```

Expected output excerpt:

```
  Results: N passed, 0 failed
```

The 8 gates exercised (when `--orchestration-smoke` is used without `--e2e`/`--dashboard-e2e`):
- Gate 0: prerequisites
- Gate 1: backend typecheck
- Gate 2: backend unit tests
- Gate 3: dashboard JS syntax
- Gate 3b: MD-driven PM trace validator fixtures
- Gate 4: SDK import check
- Gate 5: CLI import check
- Gate 6: health endpoint
- Gate 7: `deploy/smoke.sh` with `RUN_ORCHESTRATION_SMOKE=1`

> **Note:** Gates 1-5 are static checks and do not require a running server. Gates 6-7 require one. To skip gates 1-5 when they were already verified, run `bash deploy/verify.sh --orchestration-smoke` again — the static checks are fast, but if you are iterating on server-side changes only, you can run the smoke portion independently:
>
> ```bash
> RUN_ORCHESTRATION_SMOKE=1 BASE_URL="$BASE_URL" bash deploy/smoke.sh
> ```
>
> However, the full pre-release gate **must** include gates 1-5 at least once in the release candidate.

### Gate 7: Multi-Worker E2E Smoke

This is the **deliberate multi-worker collaboration gate**. It runs `scripts/nas-lan-multiworker-e2e.sh` through `deploy/verify.sh --multiworker-smoke`, exercising one PM/main agent plus three workers on a shared project/orchestration via the durable inbox. It verifies inbox isolation, claim/complete/review loops, changeset creation/merge, and content-aware project-space assertions.

```bash
# Against the NAS LAN deployment (requires ALLOW_REMOTE_VERIFY=1):
ALLOW_REMOTE_VERIFY=1 BASE_URL=http://<your-platform-host>:18080/agent \
  bash deploy/verify.sh --multiworker-smoke
```

Expected: exit 0, `Results: N passed, 0 failed` including `[gate 11] multi-worker E2E`.

> **When to skip:** If the release does not touch multi-agent orchestration, durable inbox, or project-space merge paths, Gate 7 is **recommended but not mandatory**. The core orchestration smoke (Gate 6) already covers the single-worker Golden Path.

### Gate 8: Lease/Redelivery Smoke

This exercises the durable-inbox lease mechanism: active-lease suppression (no duplicate delivery while leased), lease expiry, and redelivery with a new lease token and incremented `delivery_attempts`. Only relevant when the backend is configured with a short `INBOX_LEASE_TTL_MS`.

```bash
# Start the backend with a short inbox lease TTL (separate terminal):
#   cd backend && npm run build && NODE_ENV=test INBOX_LEASE_TTL_MS=2000 node dist/src/index.js
#
# Then run the lease/redelivery smoke — RUN_LEASE_SMOKE=1 is REQUIRED:
INBOX_LEASE_TTL_MS=2000 RUN_LEASE_SMOKE=1 bash deploy/verify.sh --orchestration-smoke
```

`RUN_LEASE_SMOKE=1` is **required** to exercise the lease/redelivery branch. `deploy/verify.sh --orchestration-smoke` sets `RUN_ORCHESTRATION_SMOKE=1` for `deploy/smoke.sh`, but the lease branch (`deploy/smoke.sh` line 282) only runs when `smoke.sh` also sees `[[ "${RUN_LEASE_SMOKE:-0}" == "1" ]]`. The command above exports `RUN_LEASE_SMOKE=1` into `verify.sh`'s environment, which `smoke.sh` inherits. `INBOX_LEASE_TTL_MS=2000` alone is **not** sufficient — without `RUN_LEASE_SMOKE=1` the orchestration smoke still passes, but the lease/redelivery checks are silently skipped.

> **When to skip:** If the release does not change inbox-lease-related code, or if the production deployment uses the default (long) TTL, Gate 8 is **recommended but not mandatory**. The core orchestration smoke (Gate 6) already covers the happy path.

### Gate 9: TTFT Measurement

Measures **Time to First Reviewed Task** against the 300 000 ms (5 minute) SLA using `deploy/measure-ttft.sh`.

```bash
bash deploy/measure-ttft.sh
```

Expected: exit 0, final line `==> TTFT measurement PASSED`. The script prints a JSON measurement block that includes `time_to_first_reviewed_task_ms`, `threshold_ms`, and `pass: true`.

The script optionally auto-starts the backend if `START_BACKEND=1` is set. When running with an already-running backend (e.g. after Gate 6), no extra flags are needed — it reuses the existing server.

> **Threshold:** The script defaults to `TTFT_THRESHOLD_MS=300000`. See §5 for all environment variables and options.

---

## 3. Post-Gate: PM Ledger / Release Notes Evidence Template

After all gates pass, record the following evidence block in the PM ledger (`golden-path-ledger.md` entry for this release) and/or the release notes.

```markdown
### Pre-Release Gate Results

**Release:** `<release-tag-or-date>`  
**Verifier:** `<who ran the gates>`  
**Date:** `<date>`  
**BASE_URL:** `http://127.0.0.1:3000` (local)  

| Gate | Result |
|------|--------|
| 1. Backend typecheck | PASS / FAIL |
| 2. Backend unit tests | PASS / FAIL (`N passed, 0 failed`) |
| 3. Dashboard JS syntax | PASS / FAIL (`0 errors`) |
| 3b. MD-driven PM trace fixture gate | PASS / FAIL |
| 4. SDK import check | PASS / FAIL |
| 5. CLI import check | PASS / FAIL |
| 6. Local orchestration smoke | PASS / FAIL (`N passed, 0 failed`) |
| 7. Multi-worker E2E smoke | PASS / FAIL |
| 8. Lease/redelivery smoke | PASS / SKIP (reason) |
| 9. TTFT measurement | PASS / FAIL (`<time_to_first_reviewed_task_ms> ms` vs 300000 ms threshold) |

**Overall:** ALL GATES PASSED ❌ YES ✅

**Evidence command used:**
```bash
bash deploy/verify.sh --orchestration-smoke
```

**Notable deviations:** `<any gate skipped or non-default config>`
```

### 3.1 Final MD Gate Composition

The final MD acceptance gate is local and artifact-first:

```bash
node scripts/validate-md-pm-trace.js <exported-project-space-orchestration-dir> --pretty
```

It maps the `GK Acceptance Gate` list to machine-readable `gk_gates[]` entries.
Gates 1, 2, 7, 8, and 12 are covered directly by the Markdown package
validator. Gates 3, 4, 9, and 10 are partially covered because live database,
permission, replay, and tamper-resistance checks still need runtime evidence.
Gates 5, 6, and 11 remain external runtime gates.

Use it with the live checks in this order:

1. Run the MD validator against the exported package to prove the durable trace
   is internally complete and final acceptance is not bypassing evidence.
2. Run CLI-only multiworker verification (`bash deploy/verify.sh --multiworker-smoke`)
   to prove real agents can join, claim, submit, review, and recover through the CLI/runtime loop.
3. Run NAS smoke/E2E with explicit remote opt-in to prove the same behavior on
   the deployed LAN surface.

Do not accept the platform from the MD report alone when CLI-only multiworker or
NAS E2E evidence is required by the release scope.

### 3.2 Ledger Entry Convention

When adding to the "Must Verify" table in `golden-path-ledger.md`:

| Task ID | Worker | Scope | Status |
|---|---|---|---|
| `YYYYMMDD_HHMMSS_e` | hermes-e | Pre-release gate YYYY-MM-DD | accepted |

And in a "Manual PM Verification Notes" entry:

> `YYYYMMDD_HHMMSS_e`: Pre-release gate runbook executed. Gates 1-9 all passed, TTFT recorded at `<N> ms` (< 5000 ms target: YES/NO). See `docs/pre-release-gate-runbook.md` for the gate protocol.

---

## 4. Remote Opt-In Guard Reference

The verification chain **must not weaken** the existing remote opt-in guard:

| Location | Guard | Behavior |
|----------|-------|----------|
| `deploy/verify.sh` | `require_local_or_opt_in()` | Refuses write-like checks (`--smoke`, `--orchestration-smoke`, `--multiworker-smoke`, `--e2e`, `--dashboard-e2e`, `--onboarding-smoke`) against non-localhost URL unless `ALLOW_REMOTE_VERIFY=1` |
| `deploy/smoke.sh` | `require_local_or_opt_in()` | Same guard, independently enforced before any API call |
| Both scripts | `BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"` | Defaults to localhost |

The layered guard ensures that a direct `BASE_URL=https://production.example.com bash deploy/smoke.sh` is refused even if `verify.sh` is bypassed.

Health checks (`GET /v1/health`) are read-only and do not trigger the guard.

---

## 5. TTFT Measurement — Live

### 5.1 Canonical Script

Measurement is enacted by `deploy/measure-ttft.sh` — the single source of truth for live TTFT measurement. The script:

1. Checks the remote-opt-in guard (refuses non-local `BASE_URL` unless `ALLOW_REMOTE_VERIFY=1`).
2. Optionally builds and starts a local backend (`START_BACKEND=1`).
3. Runs the Golden Path orchestration smoke via `deploy/smoke.sh`.
4. Extracts the created `project_id` and `task_id` from the smoke output.
5. Logs in as the smoke owner and reads `GET /v1/projects/{project_id}/notification-metrics`.
6. Extracts `time_to_first_reviewed_task_ms` and the `ttft_phases` breakdown.
7. Asserts the value is below `TTFT_THRESHOLD_MS` (default **300 000** ms).
8. Writes a structured JSON artifact to `TTFT_ARTIFACT_PATH` if configured.

### 5.2 Usage

```bash
# From repo root, against an already-running backend (e.g. after Gate 6):
bash deploy/measure-ttft.sh

# With an explicit threshold and artifact output:
TTFT_THRESHOLD_MS=300000 TTFT_ARTIFACT_PATH=ttft.json bash deploy/measure-ttft.sh

# Auto-start the backend (ephemeral, in-memory SQLite):
START_BACKEND=1 bash deploy/measure-ttft.sh
```

### 5.3 Environment Reference

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:3000` | Target API base URL |
| `ALLOW_REMOTE_VERIFY` | `0` | Set to `1` to allow non-local `BASE_URL` |
| `TTFT_THRESHOLD_MS` | `300000` | TTFT SLA in milliseconds |
| `TTFT_ARTIFACT_PATH` | *(empty)* | Optional path for machine-readable JSON artifact |
| `START_BACKEND` | `0` | If `1`, build and auto-start backend; stop on exit |
| `PORT` | `3000` | Port for auto-started backend |
| `NODE_BIN` | `node` | Node.js interpreter path |
| `SMOKE_EMAIL` | `ttft+<timestamp>@example.invalid` | Owner email for the measurement project |
| `SMOKE_PASSWORD` | auto-generated | Owner password for the measurement project |

### 5.4 Expected Output

On success the script emits a JSON measurement block and exits 0:

```json
{
  "schema_version": "ttft-measurement/v1",
  "pass": true,
  "time_to_first_reviewed_task_ms": 4231,
  "threshold_ms": 300000,
  "ttft_phases": { "dispatched_at": "...", "reviewed_at": "..." }
}
==> TTFT measurement PASSED
```

On failure (value exceeds threshold, metric missing, or smoke failed) the script prints diagnostics to stderr and exits non-zero.

### 5.5 Gate Integration

Gate 9 (`bash deploy/measure-ttft.sh`) is designed to run **after** Gate 6, 7, or 8 while the backend is still healthy on `localhost:3000`. The script reuses the same backend — there is no need to wait for a fresh backend if one is already running with in-memory state from the smoke run.

When running gates 1–9 as a linear sequence:

```bash
# (Gates 1–5)
cd backend && npm run typecheck              # Gate 1
cd backend && npm run test:unit              # Gate 2
node scripts/check-dashboard-syntax.js dashboard  # Gate 3
python3 -m pip install -q -e sdk/python && python3 -c "import zz_agent; print('ok')"  # Gate 4
python3 -m pip install -q -e cli && python3 -c "import zz_cli; print('ok')"          # Gate 5

# Start backend (shared by Gates 6–9):
cd backend && npm run build && NODE_ENV=test node dist/src/index.js

# (Gates 6–8 — in a second terminal or after backend is healthy)
bash deploy/verify.sh --orchestration-smoke                    # Gate 6
ALLOW_REMOTE_VERIFY=1 BASE_URL=http://<your-platform-host>:18080/agent \
  bash deploy/verify.sh --multiworker-smoke                    # Gate 7 (optional, NAS LAN)
INBOX_LEASE_TTL_MS=2000 RUN_LEASE_SMOKE=1 bash deploy/verify.sh --orchestration-smoke  # Gate 8 (optional)

# Gate 9 — TTFT measurement against the same backend:
bash deploy/measure-ttft.sh
```

---

## 6. Verification Against Constraints

| Constraint | Status |
|---|---|
| No product runtime changes | ✅ This document only |
| No duplication of long worker logs | ✅ |
| No weakening of remote opt-in guard | ✅ Layered guard documented as invariant (§4) |
| No edits to `docs/api-surface-freeze.md` | ✅ Separate scope, no overlap with router policy |

---

## 7. Related Documents

| Document | Relationship |
|----------|-------------|
| `.codex/pm-workers/golden-path-ledger.md` | Accepted task ledger; source of truth for gate acceptance |
| `deploy/verify.sh` | The script that implements gates 0-7 |
| `deploy/smoke.sh` | The orchestration and lease smoke payload script |
| `docs/pm-acceptance-contract-1e.md` | PM output contract that task results must satisfy |
| `docs/deployment.md` | Production deployment notes (build, install, database) |
| `docs/api-surface-freeze.md` | Router freeze inventory (separate scope from this runbook) |
| `scripts/validate-pm-result-contract.js` | Machine-checker for PM result file structure |
