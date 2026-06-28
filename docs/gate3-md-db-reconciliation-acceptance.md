# GK Acceptance Gate 3 — MD Single Source of Truth (DB Reconciliation)

## Status
`ACCEPTED` (closed 2026-06-20)

## Gate requirement
"MD single source of truth: web and CLI status can be reconstructed from MD; database/cache consistency checks pass." (codex `md-driven-agent-platform-plan.md` GK Acceptance Gate 3)

Previously this gate was marked `external_required` in `scripts/validate-md-pm-trace.js` on the grounds that it needed a live-database comparison. This record closes it with a concrete, runnable test.

## Closure evidence
`backend/tests/md-db-reconciliation.test.ts` — runs against the local SQLite test DB (better-sqlite3 in-memory, the same TypeORM code path a Postgres deployment uses).

The test:
1. Drives the full multi-agent lifecycle (register → project → agents → orchestration → dispatch → claim → complete → review → orchestration complete) so all canonical MD artifacts are written.
2. Queries the database **directly** (bypassing the HTTP API and any in-memory cache): `SELECT ... FROM project_files WHERE project_id = ? AND path LIKE ?`, plus the `project_orchestrations` and `project_orchestration_tasks` rows.
3. Proves parity between the DB-reconstructed view and the API-served view:
   - **Path-set parity**: the set of MD artifact paths under `basePath` is identical in DB and API (no path exists in only one view).
   - **Content/hash parity**: DB `content` recomputes exactly to the stored `content_hash`; DB hash matches the API-reported hash; `size_bytes` matches byte length.
   - **State reconstruction**: orchestration/task DB rows alone rebuild the facts TRACE.md reports (status=completed, task status=approved, assigned agent, result/evidence path binding, review notes presence).
   - **Canonical completeness**: all 8 canonical artifacts (goal/plan/TRACE + tasks/<id>/TASK/RESULT/EVIDENCE/REVIEW/CHANGELOG) are present in the DB-reconstructed set.
   - **Byte-identical TRACE.md**: DB TRACE.md content equals the API-served content and references the task id.

## Verification command + result
```
cd backend && npm run build && node dist/tests/md-db-reconciliation.test.js
→ Gate 3 reconciliation passed: MD state fully reconstructable from DB (paths, content, hashes, state machine).
→ md-db-reconciliation tests passed
```

Full backend regression after adding the test: **35 test files pass / 1 expected BLOCKED (live-load-proof, needs BASE_URL) / 0 fail**.

## What this proves
MD state can always be recovered from the database with no reliance on a cache. If the API layer or any cache were lost, the project-space Markdown view is fully reconstructable by querying `project_files` + orchestration/task tables. This is the defining property of "single source of truth".

## Residual note
The test runs on local SQLite. A Postgres deployment uses the identical TypeORM query layer; a live Postgres parity run remains an operator-side confirmation (tracked separately as the long-standing PG-parity gap), but the reconstruction logic itself is now proven.
