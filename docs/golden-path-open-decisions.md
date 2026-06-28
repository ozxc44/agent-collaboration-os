# Golden Path Open Decisions Memo

> **From:** hermes-b (Batch 4)
> **Date:** 2026-06-20
> **Context:** Route inventory handoff from `docs/api-surface-freeze.md` (§2.4 Needs PM Decision) and CI policy question left open by `20260619_225119_d`.
> **Constraint alignment:** See GK decision in `.codex/pm-workers/golden-path-ledger.md`.
> **Batch 5 acceptance:** All three decisions below were accepted and applied on 2026-06-20 by `20260620_075406_c`. This document retains historical context and recommendations; the accepted outcomes are documented per decision below.

---

## Decision 1: `gates.routes.ts` — Admission Gate System

**Recommended status:** ❄️ Frozen (mark as Exploratory/Frozen)

### Evidence

`gates.routes.ts` (~790 lines) implements an admission-test framework:

| Endpoint | Purpose |
|---|---|
| `GET /v1/gate-templates` | List preset templates (programming/research/tool-use) |
| `GET/POST/PATCH /v1/projects/:pid/gates` | CRUD project-specific gate instances |
| `POST /v1/projects/:pid/join-requests/:rid/gate-attempts` | Start a gate attempt |
| `GET /v1/projects/:pid/gate-attempts` | List attempts |
| `GET /v1/projects/:pid/gate-attempts/:aid` | View attempt |
| `POST /v1/projects/:pid/gate-attempts/:aid/submit` | Submit with prefilter |
| `POST /v1/projects/:pid/gate-attempts/:aid/prefilter` | Re-run prefilter |
| `PATCH /v1/projects/:pid/gate-attempts/:aid/review` | Owner reviews attempt |

> **Endpoint count:** The table lists **8 endpoint families** backed by **10 Express handlers** (`router.get/post/patch` registrations in `gates.routes.ts`). The `/v1/projects/:pid/gates` row collapses three distinct handlers — `GET`, `POST`, and `PATCH` — into one family.

The system integrates with `ProjectJoinRequest` — when all required gates are satisfied, the join request auto-approves (`approveJoinRequestIfGateSatisfied` at line 676).

3 preset templates exist: `preset.programming.basic`, `preset.research.basic`, `preset.tool-use.basic`, each with configurable checks (result_md_present, evidence_present, tests_passed, commands_allowed, paths_allowed, deadline_not_expired).

### Alignment with GK

> "No marketplace, cross-org collaboration, or protocol compatibility abstractions."

Gates are not explicitly banned, but they are a **V1-optional admission mechanism**. The current V1 membership model (`ProjectMember` + owner/admin roles + `ProjectJoinRequest` with binary owner approval) already covers the Golden Path collaboration need. Gates add a testing/admission layer useful for open-source/public projects where the owner wants automated vetting — a scenario explicitly deferred by GK ("no marketplace, cross-org collaboration").

### Risk if frozen

| Risk | Likelihood | Mitigation |
|---|---|---|
| Owner must manually review join requests | Medium | Owner inbox notification already exists via join-request flow |
| Public-facing projects have no admission testing | Low in V1 | Not a GK requirement; revisit when/if marketplace is unblocked |
| Gate attempt data (if any exists) becomes orphaned | Low | Existing rows persist; freeze means no new endpoints, not a data migration |

### Risk if kept active

| Risk | Likelihood | Mitigation |
|---|---|---|
| Feature creep toward "contributor qualification" platform | Medium | Freeze classification blocks new endpoints |
| Maintenance burden (~790 lines with template definitions, state machine, inbox integration) | High | Must typecheck, test, and maintain across refactors |
| Distraction from core 8-step GP loop | Medium | PM/worker resources spent on non-GP surface |

**Accepted Frozen** — `gates.routes.ts` added to §2.3 (Exploratory / Frozen) in `docs/api-surface-freeze.md`. Rationale: "Admission test framework. Not required for V1 membership model (owner-approval on ProjectJoinRequest is sufficient). Revisit if marketplace/public-contributor model is adopted."

- **Endpoints remain online.** Routes not removed. No new endpoints.
- **Revisit condition noted:** If/when GK unblocks "public project contribution" or "marketplace," gates may become the admission mechanism for external contributors.

---

## Decision 2: `collaboration-requests.routes.ts` — Collaboration Request Surface

**Recommended status:** 🟡 Golden Path Support (retain as first-party surface with bridge)

### Evidence

`collaboration-requests.routes.ts` (~627 lines) implements a generic request/approval framework:

| Endpoint | Purpose |
|---|---|
| `POST /v1/requests` | Create request (project_join, project_invite, owner_agent_bind) |
| `GET /v1/requests` | List requests (scope=owner/project/agent) |
| `POST /v1/requests/:rid/approve` | Approve with role binding |
| `POST /v1/requests/:rid/reject` | Reject |
| `POST /v1/requests/:rid/cancel` | Cancel (requester only) |
| `POST /v1/agent/request-owner-bind` | Agent-initiated owner binding |

Critically, **two bridge helpers** are exported (lines 583-626):

- `bridgeJoinRequestToCollab` — creates a `CollaborationRequest` linked to an existing `ProjectJoinRequest` (double-write). Called when a legacy join request is *created* (`project-space.routes.ts:367`).
- `bridgeJoinRequestReview` — syncs legacy join-request review status (approved/rejected) **into** the collaboration request. Called when a legacy join request is *reviewed* (`project-space.routes.ts:504`).

This means the legacy `project-space.routes.ts` join-request endpoints already produce `CollaborationRequest` records. **The sync is one-directional: legacy `ProjectJoinRequest` → `CollaborationRequest`.** Both the create-time double-write and the review-status sync flow in this direction only.

**Divergence risk (important for PM acceptance):** The reverse direction is *not* wired. When a bridged request is approved through the collaboration path (`POST /v1/requests/:rid/approve`, `collaboration-requests.routes.ts:331-360`), the handler grants project membership and marks the `CollaborationRequest` approved, but it does **not** update the legacy `ProjectJoinRequest`. The two records can therefore diverge — the legacy join request may remain `pending` while the collaboration request is approved and membership is already granted. This is acceptable under a strict surface freeze, but **no new approval entry point should be added until the missing back-sync is implemented**, otherwise the divergence widens.

Three request types:

| Type | Used by the GP? | Fallback if frozen |
|---|---|---|
| `project_join` | Yes (via bridge from join-requests) | ProjectJoinRequest in project-space works standalone |
| `project_invite` | No (owner can add members directly via `/v1/projects/:pid/members`) | Direct member CRUD |
| `owner_agent_bind` | **Yes** — GP step 2 needs agent-to-user binding | `users.routes.ts` has `PATCH /v1/users/me/owner-agent`, but agent-initiated bind (`POST /v1/agent/request-owner-bind`) would be lost |

### The critical dependency: agent-initiated owner binding

`users.routes.ts` provides `PATCH /v1/users/me/owner-agent` — a user-initiated bind. But GP step 2 also includes the scenario where an **agent initiates** binding to a user (e.g., a PM agent announces itself to its owner). The endpoint `POST /v1/agent/request-owner-bind` (line 505) is the only place this happens. Freezing the entire collaboration-requests surface would orphan this flow.

### Alignment with GK

> "No cross-org collaboration."

The `project_invite` and `project_join` request types *could* be expanded into cross-org scenarios, but in their current form they operate within the single-project V1 model. The `owner_agent_bind` type is architecturally neutral (intra-project).

### Risk if frozen

| Risk | Likelihood | Mitigation |
|---|---|---|
| Agent-initiated binding breaks | **High** — `POST /v1/agent/request-owner-bind` has no alternative | Move this single endpoint to `users.routes.ts` before freezing |
| Bridge helpers become dead code | Medium | They'd still compile but no new double-writes |
| `project_invite` endpoint is lost | Low | Owner can add members via `POST /v1/projects/:pid/members` with role |

### Risk if kept active

| Risk | Likelihood | Mitigation |
|---|---|---|
| Feature creep toward cross-org collaboration requests | **High** — the `project_invite` type with `target_user_id` is a natural vector for cross-org expansion | **Freeze the surface** — prohibit new request types, new scopes, and cross-project target resolution |
| One-way bridge → join-request state divergence | Medium — sync is legacy `ProjectJoinRequest` → `CollaborationRequest` only; collaboration approval does not back-sync (see divergence note above) | Surface freeze keeps the bridged path stable; do not add new approval entry points until the back-sync to `ProjectJoinRequest` is implemented |
| Maintenance (~627 lines, 5 endpoints, 3 request type handlers) | Medium | Comparable to other Support routes |

**Accepted Support (with surface freeze)** — `collaboration-requests.routes.ts` classified as **Golden Path Support** with the explicit caveat: **"Do not expand."** New request types, cross-project scopes, and multi-actor approval are blocked. The only supported operations are `project_join`, `project_invite`, `owner_agent_bind` as currently implemented.

The alternative (Accept Frozen + migrate `POST /v1/agent/request-owner-bind` to `users.routes.ts`) was not selected. The Support classification was applied and is documented in `docs/api-surface-freeze.md` §2.2.

**Recommendation (preserved):** Retain as Support with a surface freeze caveat. The `owner_agent_bind` flow is architecturally part of GP step 2, and the bridge helpers ensure join-requests in project-space remain functional without an emergency migration.

---

## Decision 3: API E2E CI Policy

**Recommended status:** 🟢 Run against the locally booted backend on every push

### Evidence

Current CI workflow (`.github/workflows/ci.yml`):

| Job | Trigger | Backend boot | Coverage |
|---|---|---|---|
| `golden-path-smoke` (lines 122-158) | Every push/PR | **Yes** — starts backend, waits for health, runs `deploy/smoke.sh`, stops backend | Golden Path orchestration flow (register, create project, register agents, heartbeat, orchestration lifecycle) |
| `e2e` (lines 104-120) | Only when `${{ inputs.api_url != '' \|\| vars.API_URL != '' }}` | **No** — targets a pre-existing URL | 11 broad API flows (auth, projects, members, agents, sessions, messages, SSE, health — `backend/tests/e2e-api.test.ts`) |

The golden-path-smoke job already demonstrates the CI pattern for booting a local backend: npm ci → build → start → wait-for-health → run tests → stop. The E2E suite (`e2e-api.test.ts`) is a script that makes fetch calls against `process.env.API_URL || 'http://localhost:3000'` — it naturally works against a locally booted instance with no additional configuration.

### The gap

The golden-path-smoke tests the orchestration GP only. The E2E suite tests **11 flows** that golden-path-smoke does not cover:

| E2E test | Covered by golden-path-smoke? |
|---|---|
| Health endpoint (no auth) | Only via curl health poll |
| Register + get token | Yes (register/login) |
| Create project | Yes |
| Add member as non-owner | No |
| Create agent with endpoint_url + secret redaction | Yes (agent register) |
| Create session | No |
| Send message | No |
| List messages / get session | No |
| Agent heartbeat (X-API-Key) | Yes |
| V1 agent root + health contract | No |
| List project agents | No |
| SSE event stream | No |

### CI cost estimate

| Step | Time |
|---|---|
| npm ci + build (shared with golden-path-smoke — already done) | 0s (build already present from smoke job) |
| Backend boot + health wait (already running for smoke) | 0s |
| Run `node dist/tests/e2e-api.test.js` | ~15-30s |
| **Incremental total** | **~15-30s per push** |

The E2E tests run sequentially (not concurrent), use their own test credentials (no conflict with smoke), and exit with `process.exit(failed > 0)` — so a failure fails the job.

### Implementation options

| Option | CI change | Cost | Coverage |
|---|---|---|---|
| **A. Add to existing golden-path-smoke job** | Add a step after smoke, using the still-running backend | ~15-30s added | Full GP + full API regression |
| **B. Make e2e job always-run with local boot** | Add `npm start &` + health wait to the e2e job | ~60-90s parallel job | Full API regression on every push |
| **C. Keep release-only/opt-in** (current) | No change | 0s | Zero coverage between releases |

**Recommendation: Option A.** The backend is already running when golden-path-smoke finishes. Adding `node dist/tests/e2e-api.test.js` as a final step (before the `Stop backend` step) gives the broadest regression coverage at the smallest incremental cost. The e2e test suite exits with process.exit so a failure correctly fails the job.

### Risk if left release-only/opt-in

| Risk | Likelihood | Mitigation |
|---|---|---|
| Non-GP route regression reaches production | Medium | golden-path-smoke covers the GP path; non-GP routes (frozen surface) are untested between releases |
| E2E tests bit-rot from disuse | **High** — the file is never exercised in CI unless a developer triggers `workflow_dispatch` | 8 of the 11 tests have no analogous coverage in any other CI job |
| CI pipeline gives false confidence | Medium | Passing CI means "GP smoke works" but not "the rest of the API isn't broken" |

### Risk if pushed to every-push

| Risk | Likelihood | Mitigation |
|---|---|---|
| Occasional flaky failure (SSE timing, sequential test ordering) | Low-Medium | The SSE test has a 3s read timeout; sequential tests are deterministic with unique credentials |
| CI time increases by ~15-30s | Certain but negligible | Build/boot is shared; incremental cost is the test execution itself |
| Test credentials accumulate in DB | Low | `Date.now()` in email prefix ensures uniqueness; no cleanup needed (test DB is ephemeral in CI) |

**Accepted Option A** — E2E test step added to the `golden-path-smoke` job in `.github/workflows/ci.yml`: after smoke.sh, before killing the backend, runs `node dist/tests/e2e-api.test.js` with `API_URL=http://127.0.0.1:3000`. Step configured with `if: always()` so a smoke failure still runs E2E for diagnostics.

**Option C** (status quo) — not selected.

**Recommendation (preserved):** Option A. The incremental CI cost (~20s) is negligible; the coverage gap is real (8 untested flows). The golden-path-smoke backend is already running — there is no reason not to reuse it.

---

## Summary of Recommendations

| # | Route / Policy | Recommended Status | Risk if wrong |
|---|---|---|---|
| 1 | `gates.routes.ts` | ❄️ **Frozen** (V1-optional admission gates) | Low — join-request owner approval covers V1 |
| 2 | `collaboration-requests.routes.ts` | 🟡 **Support (surface freeze caveat)** — retain for `owner_agent_bind` flow; do not expand request types | Medium — agent-initiated binding has no alternative; always freeze the surface, never the route file |
| 3 | API E2E CI policy | 🟢 **Run on every push** (Option A: append to golden-path-smoke job) | Low — 8 untested flows gain CI coverage at ~20s cost |

### Decisions Summary (Batch 5)

- **Decision 1** (gates frozen): Frozen classification applied. `gates.routes.ts` is in §2.3 Exploratory / Frozen.
- **Decision 2** (collab-requests Support): Support-with-surface-freeze approach applied. `collaboration-requests.routes.ts` is in §2.2 Golden Path Support.
- **Decision 3** (E2E CI): Option A applied. E2E tests run inside `golden-path-smoke` job on every push.

---

*Generated by hermes-b, 2026-06-20. See `docs/api-surface-freeze.md` for the current route inventory and `.codex/pm-workers/golden-path-ledger.md` for the GK decision.*
