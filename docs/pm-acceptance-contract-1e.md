# PM Acceptance Contract — Golden Path Batch 1E

> **Status:** Current for the 14-day sprint beginning ~2026-06-19.
> **Scope:** This doc is the PM-facing wedging contract. It supersedes the broader product surface for the duration of this sprint. Full platform docs (orchestration, versioning, quickstart) remain valid for reference but are **not** the sprint priority.

---

## 1. Primary Wedge

> **"Prove one reliable closed loop."**

**PM Agent** manages **Worker Agent** task delivery through:

1. Durable task dispatch (orchestration API)
2. Worker claim → evidence submission
3. PM review (approve / changes_requested)
4. Safe writeback into Project Space (changeset → merge)

Everything else is noise until this loop is **fast, reliable, and demoable**.

---

## 2. Golden Path

The single end-to-end flow that must work end-to-end, start to finish:

```
PM Agent                          Worker Agent                  Platform
───────                           ────────────                  ────────
   │                                  │                            │
   ├─ Create orchestration ──────────►│                            │
   │   (goal.md, tasks.json)          │                            │
   │                                  │                            │
   ├─ Dispatch task ─────────────────►│                            │
   │                                  ├─ Claim task                │
   │                                  ├─ Execute (read context,    │
   │                                  │   write code)              │
   │                                  ├─ Complete w/ result.md +   │
   │                                  │   evidence.json            │
   │◄────────── inbox notification ───┤                            │
   │                                  │                            │
   ├─ Review task ───────────────────►│                            │
   │   (approved / changes_requested) │                            │
   │                                  │                            │
   ├─ (If approved) Dispatch changeset│                            │
   │   → submit → merge               │                            │
   │                                  │                            │
   └─ Orchestration complete ─────────┘                            │
```

**End state:** A PM agent can describe a goal, split it into tasks, dispatch each to a worker agent, review the evidence, approve or request changes, and persist the accepted result to the project's versioned history.

---

## 3. North-Star Metric

### `Time to First Reviewed Task`

**Definition:** Wall-clock minutes from the moment a PM agent dispatches a task (`POST .../tasks`) to the moment that task receives a PM review decision (`approved` or `changes_requested`) via `PATCH .../tasks/{id}/review`.

**Why this metric:**
- It is the first end-to-end latency signal — everything else derives from it.
- It catches every systemic bottleneck: dispatch lag, worker startup, agent comprehension, evidence quality, and PM review latency.
- If it is fast, the loop works. If it is slow, nothing else matters.

**Two-week target:** < 5 minutes for a simple task (e.g. "add a comment to a file").

**Tracking:** Record each golden-path walkthrough with a timestamp per phase.

---

## 4. In Scope (Two Weeks)

Only work that directly reduces **Time to First Reviewed Task** or demonstrably improves the path's success rate.

### Must-Work

| Area | What | Why |
|------|------|-----|
| **Orchestration API reliability** | Fix bugs in task claim/complete/review flow. Address 401/403 auth mismatches. Add missing validation. | Each trip through the Golden Path must succeed without manual patches. |
| **Worker result format** | Ensure `result.md` + `evidence.json` are machine-parseable and render usefully in PM review. | A PM cannot review effectively if evidence is missing or unreadable. |
| **Inbox delivery** | `task_completed` inbox item must reach the PM agent promptly and reliably. | The PM cannot review what it never sees. |
| **Changeset writeback** | Worker-approved work must persist via changeset → merge (not direct file write). | This is the "safe writeback" half of the wedge. If merge fails, the loop is broken. |
| **Demo script** | One terminal recording that walks the Golden Path end-to-end. | Without a reproducible demo, the PM cannot verify the loop works. |

### Should-Work (if must-work is solid)

| Area | What | Why |
|------|------|-----|
| **Phase timing instrumentation** | Log timestamps at dispatch / claim / complete / review. | Needed to track `Time to First Reviewed Task` without manual stopwatch. |
| **Error recovery** | What happens when a worker crashes mid-task? PM should be able to retry/reassign. | Improves success rate of the path. |
| **PM review UI / output** | Even a simple `pm-review.md` template with structured verdict fields. | Makes PM review faster and more consistent. |

---

## 5. Explicitly Frozen

The following are **out of scope** for this sprint. Do not build, fix, or improve these unless they are blocking the Golden Path.

| Area | Rationale |
|------|-----------|
| **Agent OS / multi-agent platform vision** | Not disproven, but outside the wedge. Proving one loop first. |
| **Social chat / session messaging polish** | The durable inbox is the task queue, not chat. Session UI can remain rough. |
| **Capability gates** | Gates are a future addition. The wedge does not need them. |
| **Gitea sync** | Skipped/dry-run is fine. Sync is a deploy detail, not a wedge blocker. |
| **Dashboard / human-workspace UX** | PM agents review tasks. Human UI can be raw or absent. |
| **Multiple concurrent orchestrations** | One orchestration, one PM, one worker is the wedge. Scale after proving. |
| **Agent registration / key rotation flow** | Works currently. Not on the critical path. |
| **Runtime invoke protocol improvements** | The wedge uses orchestration API, not runtime dispatch. |
| **Versioning beyond changeset → merge** | Rollback, conflict rebase, branching — all frozen. |
| **Permission matrix expansion** | Current rules suffice. New roles/capabilities are out. |
| **Testing / CI improvements not on the path** | Only tests that directly verify Golden Path are in scope. |
| **Documentation beyond this acceptance contract** | Existing docs remain; do not expand them. |

---

## 6. Launch / Demo Blockers

These are ordered by criticality. A demo is not acceptable until **all** are resolved.

### Blocker 1: Orchestration Task Lifecycle Completes End-to-End

- [ ] PM agent can create orchestration (`POST /v1/projects/{pid}/orchestrations`)
- [ ] PM agent can dispatch a task with goal + context + acceptance criteria
- [ ] Worker agent can claim the task
- [ ] Worker agent can complete with `result.md` and `evidence.json`
- [ ] PM agent receives `task_completed` inbox notification
- [ ] PM agent can review and `approve`
- [ ] Approved result can be written back as a changeset → merge

### Blocker 2: Golden Path Works on Both NAS LAN and Production

- [ ] NAS LAN: full walkthrough with real agents
- [ ] Production: full walkthrough (or documented blocker with workaround)

### Blocker 3: Demo Script Exists and Is Repeatable

- [ ] One-command or single-page script that walks the Golden Path
- [ ] Script captures output at each phase for audit
- [ ] Script handles error cases gracefully (or documents them)

---

## 7. PM Verification Checklist

Use this checklist to decide whether a demo is acceptable.

### Structural Checks

- [ ] **Golden Path runs** — did the PM agent dispatch, worker claim/complete, PM review, and changeset merge all complete without manual intervention?
- [ ] **Inbox delivery** — did the completion notification arrive in the PM agent's durable inbox, not just a session message?
- [ ] **Evidence present** — does the worker's `evidence.json` contain verifiable output (commands run, exit codes, changed files)?
- [ ] **Writeback is safe** — was the approved work written through changeset → merge, not a direct file write?
- [ ] **Review loop works** — if the PM requests changes, can the worker re-submit and the PM re-review?

### Performance Checks

- [ ] **Time to First Reviewed Task** — measured and recorded. For a simple task, target < 5 min.
- [ ] **No silent failures** — are all errors surfaced to the PM agent (timeout, auth failure, worker crash)?

### Quality Checks

- [ ] **Result is readable** — `result.md` is comprehensible to a PM (not raw agent output).
- [ ] **Evidence is verifiable** — a reviewer can confirm the evidence matches the claimed result.
- [ ] **Changeset is clean** — the merged changeset contains only the intended files.

### Exclusion Checks

- [ ] **No frozen work leaked** — the demo does not require or showcase capability gates, Gitea sync, social chat polish, or any other frozen area to succeed.

---

## 8. Existing Doc Compatibility Notes

The following docs document a broader surface area than this sprint targets. If you encounter a contradiction between this contract and an existing doc, **this contract takes precedence** for the sprint duration.

| Existing Doc | Contradiction | Action |
|---|---|---|
| [orchestration.md](./orchestration.md) | Documents the full orchestration API including some endpoints/rules not yet hardened. | Use this contract for sprint priorities. The doc itself is not wrong — it just describes a superset. |
| [versioning-and-gates.md](./versioning-and-gates.md) | Documents capability gates and Gitea sync, both frozen. | Ignore the gates/sync sections for this sprint. The changeset section is in scope. |
| [quickstart.md](./quickstart.md) | Focuses on V1 runtime loop and social chat. | The wedge uses orchestration API, not V1 runtime dispatch. Quickstart remains valid for agent registration/health but not for task delivery. |
| [auth-permission-matrix.md](./auth-permission-matrix.md) | Documents every route's auth rules. | Route behavior is unchanged, but only the subset on the Golden Path needs to work reliably for the demo. |

---

## 9. Quick Reference: Key API Endpoints for the Golden Path

See [orchestration.md](./orchestration.md) for request/response details. This section lists only the endpoints on the critical path.

| Step | Method | Endpoint | Auth |
|------|--------|----------|------|
| Create orchestration | `POST` | `/v1/projects/{pid}/orchestrations` | JWT or main agent key |
| Dispatch task | `POST` | `/v1/projects/{pid}/orchestrations/{oid}/tasks` | Main agent key |
| Claim task | `PATCH` | `.../tasks/{tid}/claim` | Worker agent key |
| Complete task | `POST` | `.../tasks/{tid}/complete` | Worker agent key |
| Review task | `PATCH` | `.../tasks/{tid}/review` | Main agent key |
| Create changeset | `POST` | `/v1/projects/{pid}/changesets` | JWT or agent key |
| Merge changeset | `POST` | `.../changesets/{csid}/merge` | JWT or agent key |
| Complete orchestration | `PATCH` | `.../orchestrations/{oid}/complete` | Main agent key |

**Ledger layout** (written by the platform under `.agent/orchestrations/{oid}/`):
```
goal.md          — Objective and acceptance criteria
plan.md          — PM breakdown and sequencing
tasks.json       — Machine-readable task ledger
pm-review.md     — Review decisions and final acceptance
workers/
  {tid}.worker_task.md   — Worker-specific goal
  {tid}.worker_context.md — Relevant project context
  {tid}.result.md         — Worker completion report
  {tid}.evidence.json     — Verification evidence
```

---

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Auth misconfig: agent key rejected on review/merge | Medium | High — blocks entire review loop | Validate each endpoint in isolation before demo run |
| Inbox delivery unreliable under load | Low | High — PM never sees completion | Load test with 2–3 sequential task dispatches |
| Changeset merge fails on conflict | Medium | Medium — code written but not persisted | Ensure worker works on distinct files; document conflict recovery |
| Agent misreads task context | Medium | Medium — wrong output | Add structured context template; PM reviews before dispatch |
| NAS LAN DNS/cert breaks demo | Low | High — unrepeatable demo | Have production fallback ready |

---

## 11. Definition of Done (Sprint End)

- [ ] Golden Path walkthrough recorded (timestamped phases, < 5 min simple task)
- [ ] Demo script checked into repo under `demos/` or `scripts/`
- [ ] All blockers in §6 resolved
- [ ] PM can run the checklist (§7) and declare the demo acceptable
- [ ] No frozen work was touched
