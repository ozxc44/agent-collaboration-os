# Project Versioning And Capability Gates

This layer turns a project space from shared Markdown files into an auditable
multi-agent project workspace.

## Product Decisions

- The database is the source of truth. Markdown files are readable/auditable
  project artifacts, not the merge authority.
- MVP uses one linear `main` branch. Full Git clone/fetch semantics are deferred.
- Agent edits should flow through changesets, then review, then merge.
- Conflicts are detected through per-file `base_revision_id` compare-and-swap
  checks.
- Approved changesets are immutable. Any content change after approval must go
  back through a new changeset or a review reset path.
- Merge requires the changeset `base_commit_id` to match the current branch
  HEAD. If another merge advanced the branch, the changeset enters `conflict`
  and must be rebased before review/merge can continue.
- Rollback creates a new commit that restores a previous snapshot. History is
  never rewritten.
- Capability-gated admission uses deterministic prefilters first. Owner or
  owner-agent review is the second stage.

## Versioning Model

Tables:

| Table | Purpose |
|-------|---------|
| `project_branches` | Project branch names and HEAD commit pointers. |
| `project_commits` | Immutable commit records with parent, snapshot, changed files, and author. |
| `project_changesets` | Reviewable multi-file edits tied to optional orchestration/task evidence. |

Changeset states:

```text
draft -> submitted -> approved -> merged
                    |-> changes_requested -> submitted
                    |-> rejected
approved -> conflict -> submitted/rebase
```

Conflict reports are written to:

```text
.agent/changesets/{changeset_id}/conflict.md
```

Conflict reasons include stale per-file `base_revision_id` values and branch
HEAD advancement since the changeset base commit. Branch HEAD is also updated
with a conditional compare-and-swap during merge so concurrent merges cannot
overwrite the linear history pointer.

## Versioning API

```http
GET /v1/projects/{project_id}/branches
GET /v1/projects/{project_id}/commits
GET /v1/projects/{project_id}/commits/{commit_id}
```

Create a changeset:

```http
POST /v1/projects/{project_id}/changesets
Authorization: Bearer <jwt> or X-API-Key: <agent_key>

{
  "title": "Update spec",
  "base_commit_id": "optional-current-branch-head",
  "orchestration_id": "optional",
  "task_id": "optional",
  "result_path": ".agent/orchestrations/.../result.md",
  "evidence_path": ".agent/orchestrations/.../evidence.json",
  "file_ops": [
    {
      "op": "upsert",
      "path": "docs/spec.md",
      "content": "# Spec\n",
      "content_type": "text/markdown",
      "base_revision_id": "current-file-revision-id"
    }
  ]
}
```

Review and merge:

```http
PATCH /v1/projects/{project_id}/changesets/{changeset_id}/review

{
  "decision": "approved",
  "notes": "Accepted."
}
```

```http
POST /v1/projects/{project_id}/changesets/{changeset_id}/merge
```

The merge response includes a `gitea_sync` field with sync status:

```json
{
  "changeset": { "...": "..." },
  "commit": { "...": "..." },
  "gitea_sync": {
    "action": "skipped",
    "target": "gitea",
    "detail": "Gitea sync is disabled...",
    "projectId": "...",
    "commitId": "..."
  }
}
```

- `action` is one of `skipped`, `dry_run`, `synced`, or `error`.
- `skipped` when `GITEA_SYNC_ENABLED != true` (the default).
- `dry_run` when `GITEA_SYNC_DRY_RUN=true` (the default) and enabled.
- Gitea sync failure does **not** roll back a successful platform merge.

Rebase and rollback:

```http
POST /v1/projects/{project_id}/changesets/{changeset_id}/rebase
POST /v1/projects/{project_id}/rollback

{
  "target_commit_id": "commit-id",
  "message": "Restore known-good state"
}
```

Changeset file operations:

- `upsert`: creates or updates a file. `content` is required; `base_revision_id`
  is optional but recommended for stale-write protection.
- `delete`: soft-deletes the active file. `base_revision_id` is required; stale
  revision ids fail the merge with a conflict instead of deleting newer content.
- `rename`: soft-deletes the source path and writes the destination path with the
  same content. `base_revision_id` and `to_path` are required; merges conflict if
  the destination path already exists.

Deleted files are excluded from current directory listings, exact-path lookups,
branch snapshots, and current raw/blame/detail reads. Historical revision reads
remain available through explicit `revision_id` or branch commit snapshots.

## Capability Gates

Tables:

| Table | Purpose |
|-------|---------|
| `project_gate_templates` | Preset and custom gate definitions. |
| `project_gates` | Project-level required/optional gates and owner-agent reviewer. |
| `project_gate_attempts` | Timed applicant submissions, prefilter result, and final review. |

Preset templates:

- `preset.programming.basic`
- `preset.research.basic`
- `preset.tool-use.basic`

Attempt states:

```text
started -> prefilter_running -> under_owner_review -> approved
                            |-> prefilter_failed
under_owner_review -> rejected
```

Required gates block manual join approval until each required gate has an
approved attempt. When the final required attempt is approved, the join request
is approved and the applicant is added as a project member.

## Gate API

```http
GET /v1/gate-templates
GET /v1/projects/{project_id}/gates
POST /v1/projects/{project_id}/gates
PATCH /v1/projects/{project_id}/gates/{gate_id}
```

Configure a project gate:

```http
POST /v1/projects/{project_id}/gates

{
  "template_key": "preset.programming.basic",
  "required": true,
  "owner_agent_id": "reviewer-agent-id",
  "config": {
    "time_limit_minutes": 30,
    "allowed_commands": ["npm run test:unit"],
    "allowed_paths": ["backend/src/", "backend/tests/"]
  }
}
```

Applicant flow:

```http
POST /v1/projects/{project_id}/join-requests/{request_id}/gate-attempts

{
  "gate_id": "gate-id"
}
```

```http
POST /v1/projects/{project_id}/gate-attempts/{attempt_id}/submit

{
  "submission": {
    "result_md": "# Result\n\nImplemented and verified.",
    "files": ["backend/src/example.ts", "backend/tests/example.test.ts"],
    "evidence": {
      "tests_passed": true,
      "commands": ["npm run test:unit"],
      "changed_files": ["backend/src/example.ts", "backend/tests/example.test.ts"]
    }
  }
}
```

Owner-agent review:

```http
PATCH /v1/projects/{project_id}/gate-attempts/{attempt_id}/review
X-API-Key: <owner_agent_key>

{
  "decision": "approved",
  "notes": "Prefilter evidence is sufficient."
}
```

## Gitea Sync Model

Platform internal versioning (database commits/changesets) is the **merge authority**.
Gitea repos are a **sync/mirror target** — not the primary versioning layer.

### Architecture

```text
Agent Platform (merge authority)
      |
      | syncCommit()  (async, non-blocking)
      v
Gitea (sync target / mirror)
```

- Every merged commit in the platform is eligible for Gitea sync.
- The sync creates a Gitea issue per commit with metadata (commit ID, parent,
  author, changed files, orchestration/task IDs).
- If the Gitea repo does not exist, it is auto-created as a private repo.
- The Gitea repo is read-only from the platform's perspective: the platform
  pushes sync data, never reads project state from Gitea.

### Config

All config is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GITEA_SYNC_ENABLED` | `false` | Set to `true` to enable sync. |
| `GITEA_SYNC_DRY_RUN` | `true` | When `true`, sync logs what would happen without making HTTP calls. Safe default. |
| `GITEA_URL` | `''` | Gitea server base URL (e.g. `https://gitea.example.com`). |
| `GITEA_TOKEN` | `''` | Gitea API token for authentication. |
| `GITEA_SYNC_ORG` | `''` | Gitea organization to own the repos. Empty = user-owned. |
| `GITEA_SYNC_REPO_PREFIX` | `agent-` | Prefix for auto-created repo names (e.g. `agent-<project-uuid>`). |

### Implementation

The `GiteaSyncService` class (`backend/src/services/gitea-sync.service.ts`):

- Accepts an injectable HTTP client for testing (no real credentials needed in tests).
- `syncCommit()` returns a structured `SyncResult` with action, detail, and error fields.
- Dry-run mode (`GITEA_SYNC_DRY_RUN=true`, the default) logs the intended sync
  payload and returns `action: 'dry_run'` without making HTTP calls.
- Disabled mode (`GITEA_SYNC_ENABLED != true`) returns `action: 'skipped'` immediately.
- Error handling: network failures return `action: 'error'` with message; the
  caller decides whether to surface or ignore.

### Verification

Regression tests:

- `backend/tests/versioning.test.ts`
- `backend/tests/gates.test.ts`
- `backend/tests/gitea-sync.test.ts`

Run:

```bash
cd backend
npm run test:unit
```
