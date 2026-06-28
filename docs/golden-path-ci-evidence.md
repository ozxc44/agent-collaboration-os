# Golden Path CI Evidence

> **Source:** Batch 7 (hermes-e), 2026-06-20
> **Updated:** Batch 7 repair (hermes-c), 2026-06-20 — added CI-equivalent backend start env and repo-explicit live-CI commands.
> **Updated:** 2026-06-20 (hermes-b, P2 rationale correction) — clarified that `NODE_ENV=test` uses in-memory sqlite; local parity does not require Postgres.
> **Updated:** 2026-06-20 (Batch 12, hermes-c) — added a [PostgreSQL Parity](#postgresql-parity) section: reproducible Postgres blocker evidence + a reusable secret-free parity script (`backend/scripts/pg-parity-check.sh`). *(At Batch 12 the gap was sharpened, not closed — that framing is **superseded** by the Batch 13/14C line below. PostgreSQL is now **closed as local proof**; only the live-CI / production residual is still outstanding.)*
> **Updated:** 2026-06-20 (Batch 14B, hermes-b) — expanded [Live CI Observation](#live-ci-observation) with a full live-CI proof runbook: repo candidate inference, auth setup, query commands, record-back template, and enumerated refusal conditions.
> **Reconciled:** 2026-06-20 (Batch 14C, hermes-c) — folded in the accepted Batch 13 evidence: Live CI remains blocked (preconditions sharpened via `20260620_170835_d`); [PostgreSQL Parity](#postgresql-parity) **closed as local proof** via the accepted ephemeral PostgreSQL 16.14 transcript (`20260620_171530_c` + `20260620_173355_c`); Node 22 local build+test parity proven (`20260620_170136_d`). Local proof is distinguished from live-CI / production proof throughout; residual risk is not erased.
> **Purpose:** Record the current CI status of the `golden-path-smoke` job and available local parity.

## Live CI Observation

**Status: ❌ Not observed.**

Probed 2026-06-20 (hermes-b, Batch 12):

| Check | Result | Exit code |
|-------|--------|-----------|
| `git status --short` | `fatal: not a git repository (or any of the parent directories): .git` | 128 |
| `gh auth status` | `You are not logged into any GitHub hosts.` | 1 |

The `gh` CLI is not authenticated (no `GH_TOKEN` / `GITHUB_TOKEN` available), and this workspace is **not** a Git checkout — both conditions prevent reading GitHub Actions workflow runs for `golden-path-smoke`.

### Live CI Proof Runbook

The steps below form a complete, safe command path to close the Live CI gap once authentication and repo context are available. **Do not skip or reorder them.**

---

#### 1. Repo candidate

The inferred upstream repo is **`zhuzeyang/zz-agent`**, read from the `Source` field in `sdk/python/pyproject.toml`:

```text
Source = "https://github.com/zhuzeyang/zz-agent"
```

**Why this is a candidate only** — the inference is a single, unchecked data point:
- `pyproject.toml` references the author's GitHub handle `zhuzeyang` and a repo name `zz-agent`, but there is no `.git` remote to cross-check against.
- The CI workflow file lives at `.github/workflows/ci.yml` in this tree, which is compatible with `zhuzeyang/zz-agent`, but the tree could equally be a fork, a mirror, or a manually extracted copy under a different upstream slug.
- Until `gh` can verify the slug against GitHub's API (needs auth first), the candidate remains unvalidated.

**How to validate once authenticated:**

```bash
gh repo view zhuzeyang/zz-agent --json nameWithOwner,url,defaultBranchRef
```

If this returns an error, the slug is wrong — search for the real one from the candidate's owner page:

```bash
gh search repos --owner zhuzeyang --json nameWithOwner,url
```

---

#### 2. Auth setup (pick one)

**Option A — interactive browser login (recommended for first-time setup):**

```bash
gh auth login
# Follow the prompts: GitHub.com → HTTPS → Login with a web browser
# → paste the one-time code → authorize → done
```

**Option B — token-based (headless / CI / scripts):**

```bash
# 1. Create a GitHub personal access token (classic) with `repo` + `read:org` + `read:user` scopes
#    or a fine-grained token with `Actions: Read` and `Metadata: Read` repository permissions.
# 2. Export it:
export GH_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
# 3. Verify:
gh auth status
# → exit 0, "Logged in to github.com as <user>"
```

**Safety notes:**
- Never paste a token into a file that gets committed. Use environment variables or your OS keychain (the default for `gh auth login`).
- A classic PAT with `repo` scope grants full access to private repos — use a fine-grained token scoped only to this repo when possible.
- The `GH_TOKEN` env var takes precedence over `gh auth login`; if both are set and conflict, `gh auth status` will report the token's identity.

---

#### 3. Query latest workflow status

Once authenticated, use these commands with **explicit `--repo`** — without a `.git` checkout, `gh` has no remote to infer the repo from:

```bash
# List the 5 most recent CI workflow runs. databaseId is the run ID usable by gh run view.
gh run list --repo zhuzeyang/zz-agent --workflow ci.yml --limit 5 \
  --json databaseId,headBranch,headSha,status,conclusion,createdAt,url

# Inspect the run to find the numeric job ID for golden-path-smoke (replace <run-id> with databaseId from the list above)
gh run view <run-id> --repo zhuzeyang/zz-agent --json jobs

# View the full log of a specific job (replace <job-id> with the numeric databaseId of the golden-path-smoke job)
gh run view --repo zhuzeyang/zz-agent --log --job <job-id>

# Download logs for a specific job (useful for offline inspection or attaching to a review)
gh run view --repo zhuzeyang/zz-agent --log --job <job-id> > /tmp/ci-golden-path-smoke.log
```

`--job` accepts a **numeric job ID**, not a job name. The `gh run view --json jobs` output lists each job with its `databaseId` and `name`; use the `databaseId` of the job whose `name` is `golden-path-smoke`. Alternatively, use run-level logs/JSON without `--job` (`gh run view <run-id> --repo zhuzeyang/zz-agent --log` or `--json jobs`) — these do not require a per-job ID.

**What to look for:**
- The `golden-path-smoke` job (lines 122–172 of `.github/workflows/ci.yml`) has nine job steps: checkout → setup Node 22 → install backend deps → build backend → start backend + health wait → run Golden Path orchestration smoke → measure TTFT → API E2E → stop backend.
- Verify each step exited `0`. The TTFT, API E2E, and stop steps run via `if: always()`, so a failing earlier step does not abort the job — inspect the `conclusion` of each step, not just the overall job status.
- The CI uses Node 22, `ubuntu-latest`, and in-memory SQLite (`NODE_ENV=test`).

---

#### 4. Record the result back here

Once you have queried a passing run, update the status line at the top of this section and add an observation block:

**Status: ❌ Not observed.** → **Status: ✅ Observed — see below.**

Then paste a block like this:

```text
### CI Run <run-id>

Observed 2026-06-20 by <operator>:

| Step | Conclusion |
|------|-----------|
| Install backend deps | success |
| Build backend | success |
| Start backend + health wait | success |
| Golden Path orchestration smoke | success |
| Measure TTFT | success |
| API E2E | success |
| Stop backend | success |

**Run URL:** https://github.com/zhuzeyang/zz-agent/actions/runs/<run-id>

**Evidence recorded by:** manual `gh run view <run-id> --repo zhuzeyang/zz-agent --json jobs` followed by `gh run view --repo zhuzeyang/zz-agent --log --job <job-id>` (where `<job-id>` is the numeric `databaseId` of the `golden-path-smoke` job).
```

If the run failed, still record it — note the failing step(s) and any known non-determinism:

```text
### CI Run <run-id> — FAILED

Observed 2026-06-20 by <operator>. Failure in step(s): <step-name>.
```

---

#### 5. Refusal conditions — do NOT claim CI pass under these conditions

The Live CI gap MUST remain open if any of the following is true:

| # | Condition | How to detect | Action |
|---|-----------|---------------|--------|
| R1 | **No `.git` directory** | `git status --short` exits 128 | Cannot infer repo; do not query. Tell operator to `git clone` first. |
| R2 | **`gh` not authenticated** | `gh auth status` exits 1 | Cannot read Actions API. Tell operator to run `gh auth login` or set `GH_TOKEN`. |
| R3 | **No explicit `--repo` flag** | Command omits `--repo OWNER/REPO` | Without `.git`, `gh` has no default remote; queries silently fail against the wrong repo or return empty. |
| R4 | **Repo candidate unvalidated** | `gh repo view zhuzeyang/zz-agent` exits non-zero | The inferred slug is wrong; operator must discover the real upstream before querying. |
| R5 | **`gh run list` returns no runs** | `--json conclusion` returns `[]` | No CI runs exist yet, or the workflow name `ci.yml` does not match. Check `.github/workflows/ci.yml` name field. |
| R6 | **Queried off a fork / non-default branch** | `--branch` not specified; `headBranch` differs from `main` or `master` | A run on an unmerged fork branch does not prove CI passes on the default branch. Query with `--branch main` or `--branch master`. |

If any refusal condition is active: **write "❌ Not observed" in the status line and link the specific blocker(s) from the table above.** Do not write "CI passes" or "Live CI observed" — the gap is open until a human with full credentials closes it.

## CI `golden-path-smoke` Job Structure

As defined in `.github/workflows/ci.yml` (lines 122–172), the job runs on `ubuntu-latest` with Node 22 and performs these steps **in order**:

| Step | Command | `if: always()`? |
|------|---------|-----------------|
| Checkout | `uses: actions/checkout@v4` | No |
| Setup Node 22 | `uses: actions/setup-node@v4` with `node-version: "22"` | No |
| Install backend deps | `cd backend && npm ci` | No |
| Build backend | `cd backend && npm run build` | No |
| Start backend + health wait | `cd backend && npm start &` (env: `NODE_ENV=test PORT=3000 INBOX_LEASE_TTL_MS=2000`) then curl loop up to 30 s | No |
| Golden Path orchestration smoke | `RUN_LEASE_SMOKE=1 RUN_ORCHESTRATION_SMOKE=1 BASE_URL=http://127.0.0.1:3000 bash deploy/smoke.sh` | No |
| Measure TTFT | `bash deploy/measure-ttft.sh` (env: `TTFT_THRESHOLD_MS=300000`) | **Yes** |
| API E2E | `cd backend && node dist/tests/e2e-api.test.js` | **Yes** (runs even if smoke/TTFT fails) |
| Stop backend | `kill "$SERVER_PID"` | **Yes** (runs even if E2E fails) |

### Coverage

- **Golden Path orchestration:** user registration, project creation, agent registration (X-API-Key auth), agent runtime endpoints (heartbeat, inbox, workload), PM + worker orchestration lifecycle (dispatch, claim, complete, review)
- **API E2E:** auth, projects, members, agents, sessions, messages, SSE, health (backend/tests/e2e-api.test.ts)
- **Lease/redelivery** (via `RUN_LEASE_SMOKE=1`): active-lease suppression, expiry, redelivery with incremented delivery_attempts

## Local Parity

A durable local parity command is available at `scripts/golden-path-smoke.sh`. It mirrors the CI `golden-path-smoke` job's command sequence and the CI-equivalent backend start env (`NODE_ENV=test PORT=3000 INBOX_LEASE_TTL_MS=2000`). The remaining deltas are platform only (OS and Node version — see Platform Differences below), not backend env:

```bash
bash scripts/golden-path-smoke.sh
```

The script:
1. `npm ci` + `npm run build` in `backend/`
2. Starts the backend on `127.0.0.1:3000` with `NODE_ENV=test PORT=3000 INBOX_LEASE_TTL_MS=2000` and waits up to 30 s for `/v1/health`
3. Runs `RUN_LEASE_SMOKE=1 RUN_ORCHESTRATION_SMOKE=1 deploy/smoke.sh`
4. Runs `node dist/tests/e2e-api.test.js` (always, even if smoke fails)
5. Stops the backend (always)
6. Exits non-zero if either smoke or E2E fails

Note: `deploy/verify.sh` provides a more comprehensive local verification suite (typecheck, unit tests, dashboard JS syntax, SDK/CLI import checks, plus optional smoke/e2e) but requires a **separately started backend**. The parity script at `scripts/golden-path-smoke.sh` is a drop-in replacement for the CI job that owns the full lifecycle.

**Database backend:** `NODE_ENV=test` switches the backend to an in-memory SQLite database (`better-sqlite3`, configured in `backend/src/data-source.ts:105`). This means the full parity path — including smoke tests and API E2E — does **not** require a live PostgreSQL instance. The only genuine infrastructure dependencies that cannot be satisfied locally are the ones documented in [Live CI Observation](#live-ci-observation): `gh` authentication and read access to the GitHub repository's Actions API. The platform deltas (OS, Node version) are covered in [Platform Differences](#platform-differences).

## PostgreSQL Parity

> Added 2026-06-20 (Batch 12, hermes-c) — sharpened Remaining Proof Gap #2.
> **Reconciled 2026-06-20 (Batch 13/14C, hermes-c)** — the local Postgres gap is now **closed as local proof** via the accepted ephemeral PostgreSQL 16.14 transcript (`20260620_171530_c` + repair `20260620_173355_c`, verdict `accept`/`SURVIVED`). See [Accepted local proof](#accepted-local-proof) below. This is local parity on an ephemeral run, **not** live-CI or production parity — residual risk is preserved.

The SQLite-only local parity above intentionally does **not** exercise the production Postgres branch (`backend/src/data-source.ts:113-124`) or the `driver === 'postgres'` branches inside each migration. This section records the current state of Postgres parity and gives a reusable, secret-free way to reproduce it on a Postgres-capable machine.

**Status: ✅ Proven locally on an ephemeral PostgreSQL 16.14 run (accepted Batch 13). Persistently the machine still has no Postgres tooling, so `pg-parity` currently fails closed (exit 2) until re-provisioned.**

### Accepted local proof

The full sanitized transcript (1053 lines: every command, output line, exit code) is embedded in the acceptance artifact `.codex/pm-workers/tasks/20260620_171530_c/result.md` (re-homed and redacted by repair `20260620_173355_c`); `proof-transcript.log` is retained as the raw sidecar. Scope is exactly **PostgreSQL 16.14 on this host, for that one ephemeral run** (2026-06-20). All credentials were throwaway, scoped to `127.0.0.1:55432`, and destroyed with the ephemeral cluster.

| Phase | Command / check | Result | Exit |
|-------|-----------------|--------|------|
| Baseline (before provisioning) | `cd backend && npm run pg-parity` | `BLOCKED` (no provisioner) | **2** |
| Provision ephemeral cluster | Homebrew cached bottle `postgresql@16` 16.14 → `initdb` (scram-sha-256, superuser `pgparity`, temp PGDATA in `/tmp`, `127.0.0.1:55432`) → `pg_ctl start` → `pg_isready` | server started, accepting connections | **0** |
| Build | `cd backend && npm run build` (Gate 1 typecheck) | exit 0 | **0** |
| Migration show | `migration:show` (correct inline `DB_*` env) | 18 pending migrations listed | **0** |
| Migration run | `migration:run` against real PostgreSQL 16.14 | all 18 applied (`START TRANSACTION` … `COMMIT`) | **0** |
| DB-side count | rows in `migrations` table / applied timestamps / enum types / user-entity tables | **18** / **18** / **18** / **30** (31 incl. `migrations`) | — |
| Table sanity | `\d users` | expected columns + FKs present | — |
| Adversarial — correct cred | `psql` with right password | `ok` | **0** |
| Adversarial — WRONG cred | `psql` with wrong password | `FATAL: password authentication failed` | **2** (nonzero = server genuinely validated) |
| Golden Path on Postgres | backend on free port `61620` pointed at the ephemeral DB → `node dist/tests/e2e-api.test.js` | **21 passed / 0 failed** (health, register/login, project, member, agent, session, message, heartbeat, agent health, SSE) | **0** |
| Cleanup | `pg_ctl stop` (fast) → remove temp PGDATA/socket/logs/pwfile → `brew uninstall postgresql@16` → `brew autoremove` (`krb5`) | formula count back to baseline 80 | **0** |
| Final (after cleanup) | `cd backend && npm run pg-parity` | `BLOCKED` (tooling gone again) | **2** |

The compile-only check still holds too: `node scripts/ci-migration-check.js` → exit 0 ("18 migration(s) compiled and importable"). The accepted proof goes further: all 18 migrations are **applied** against a real PostgreSQL 16.14 and the Golden Path runs green against it.

### Current machine state (so the gap is never silently claimed persistent)

Post-provisioning cleanup is complete: `postgresql@16` is **uninstalled**; `psql`/`pg_isready`/`pg_ctl`/`initdb`/`postgres` are **MISSING**; ports 5432/55432 are closed; no postgres processes run; formula count is 80 (baseline). Therefore `bash backend/scripts/pg-parity-check.sh` **today** returns exit 2 (BLOCKED / fail-closed) — the local proof is reproducible-on-demand, not continuously running. Two benign Homebrew residuals remain (not data, processes, ports, or secrets): the bottle cache (~18.2 MB tarball + ~27 KB manifest) and a 1254 B post-install `initdb` log (`trust` auth, no password). "Full machine restoration" is explicitly **not** claimed.

**Reusable parity check (local-only, secret-free, fails closed):**

```bash
bash backend/scripts/pg-parity-check.sh      # = npm run pg-parity  (from backend/)
```

On a machine with `docker` or `podman`, this auto-provisions a throwaway `postgres:16` container (creds `pgparity`/`pgparity`/`pgparity`, bound to `127.0.0.1:55432`, torn down on exit), then runs `npm run build`, `migration:show`, `migration:run`, and (unless `PG_PARITY_SKIP_GP=1`) one Golden Path via `node dist/tests/e2e-api.test.js` with `NODE_ENV=pg-parity`. With `--local` it uses a Postgres you have already started (reads `DB_*` from your env). With **no** provisioner it prints the blocker and exits **2** so the gap is never silently closed — which is the current state on this machine. The accepted Batch 13 proof reproduced the same path by provisioning via Homebrew instead of a container, then tearing it down.

Exit codes: `0` proof passed · `1` proof failed against a reachable Postgres · `2` blocked (no provisioner) · `3` provisioner found but Postgres failed to start.

**Residual risk (preserved, not erased):**
- **Local proof only.** Migration application + the Golden-Path-vs-Postgres runtime path are proven on this macOS host against PostgreSQL 16.14 for one ephemeral run — **not** in live CI (`ubuntu-latest`) and **not** in production. The live-CI Postgres path (and CI's `postgres:16` service container intent in `docs/deployment.md`) remains unobserved (see [Live CI Observation](#live-ci-observation)).
- **Single host, single PG minor.** Proven against PostgreSQL 16.14 only; other PG majors/minors and other OSes are unverified.
- **Reproducible-on-demand, not continuous.** Postgres tooling is uninstalled post-cleanup; re-running requires `brew` + the cached bottle (or network) and re-provisions an ephemeral cluster. The fail-closed exit 2 is the safety net while no Postgres is present.
- **Homebrew cache/log residuals** remain (benign, documented above); the proof does not claim a pristine machine.

## Platform Differences

| Aspect | CI (`golden-path-smoke`) | Local (Darwin) |
|--------|--------------------------|----------------|
| OS | `ubuntu-latest` | Darwin (macOS) |
| Node | 22 | v24.14.0 (this session — probed 2026-06-20) |
| Backend lifecycle | Managed by job steps with `$GITHUB_ENV` | Managed by script with local variables |
| Dependencies | Fresh `npm ci` each run | Fresh `npm ci` each run (same as CI) |

The parity script runs `npm ci` (clean install, same as CI) rather than `npm install`, so dependency resolution matches CI exactly. The default local Node for this workspace is v24.14.0 (npm 11.9.0); CI uses Node 22. That OS/Node delta is a known platform difference, but the Node-version parity surface is now **closed as local proof** (see below).

**Node 22 parity — proven locally (accepted `20260620_170136_d`):** A temporary Node 22.14.0 binary (npm 10.9.2) was downloaded into the task ledger directory — **no global/persistent changes** — and the backend parity chain was run under it: `cd backend && npm ci` → exit 0 (255 packages installed); `npm run build` → exit 0 (Gate 1 typecheck passes); `npm test` → exit 0 (all suites passed). So local Node 22 build + unit-test parity is proven on this macOS host.

**Residual risk (preserved):** the Node 22 binary lives only in the task directory and was **not** made the local default (the default session remains v24.14.0; making Node 22 default needs a version manager or replacing the `~/.local/node/` symlink). The proof is **local macOS only** — a fresh `npm ci` + build + test on Linux / under the live CI `ubuntu-latest` GitHub Actions image was **not** reproduced, and the live-CI Node 22 run remains unobserved (blocked — see [Live CI Observation](#live-ci-observation)). Command/env parity, not binary-identical parity across OSes.

## Related

- `.github/workflows/ci.yml` (lines 122–172) — CI job definition
- `scripts/golden-path-smoke.sh` — Durable local parity command
- `deploy/smoke.sh` — Smoke test payload script
- `deploy/verify.sh` — Pre-release QA verification suite
- `docs/golden-path-open-decisions.md` — Decision record for API E2E CI policy (Option A)
