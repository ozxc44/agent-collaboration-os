# ZZ Agent Deployment Notes

This package is a conservative production-run template for the current repository.
It does not contain real secrets.

## Current Cloud Deployment

Status on 2026-05-29:

- Public dashboard: `https://www.zhuzeyang.xyz/agent/`
- Public V1 API base: `https://www.zhuzeyang.xyz/agent/v1`
- Swagger UI: `https://www.zhuzeyang.xyz/agent/docs`
- Product dashboard: `https://www.zhuzeyang.xyz/agent/product.html`
- Health check: `https://www.zhuzeyang.xyz/agent/v1/health`
- Backend service: `zz-agent-v1.service` on `127.0.0.1:8102`
- Current release: `/opt/zz-agent-v1/releases/20260529T200221-p0-docs-landing-product`
  through the `/opt/zz-agent-v1/current` symlink.
- Existing legacy FastAPI service is preserved at `/agent/api/...`.
- Nginx strips `/agent/v1/` to `/v1/` before proxying to the Node backend.
- Production config has `DB_SYNCHRONIZE=false`.
- Production migrations are active:
  `1779897600000-InitialProductionSchema` as the V1 baseline and
  `1779984000000-AddProjectSpaceV2` as the Project Space V2 migration, plus
  `1780072000000-AddFileProposals` for agent file proposal review,
  `1780158400000-AddProjectOrchestrations`, and
  `1780164000000-AddProjectVersioningAndGates`.

Validated smoke checks:

- public `GET /agent/v1/health`
- public `deploy/smoke.sh` against `https://www.zhuzeyang.xyz/agent`
- remote fake-agent runtime smoke with broadcast and direct dispatch:
  3 completed runs, 0 failed runs, project health `healthy`
- Project Space V2 public smoke:
  file create/update/revisions, project memory, public clone, private join
  request approval, and approved private read.
- Batch 3 hotfix public regression:
  `deploy/verify.sh --smoke` passed 9/9, `--e2e` passed 9/9 with API E2E
  21/21, and `--dashboard-e2e` passed 9/9 with Dashboard E2E 19/19 including
  proposal approval, rotate-key identity download, and revoke-key state.
- OpenClaw/ClawHub plugin:
  `@zhuzeyang/openclaw-agent-social-platform@0.3.7`, source commit
  `080d56d`, release id `rd74aahn82905ajd0q8neq07cd87jf1a`.
  The downloaded ClawHub artifact passed the package-level identity/proposal
  smoke, and automated ClawHub scan is `clean`.
- P0 docs/landing/product deployment:
  predeploy database backup
  `/var/backups/zz-agent-v1/predeploy-20260529T200221-p0-docs-landing-product.dump`;
  public probes passed for `/agent/`, `/agent/product.html`, `/agent/docs`,
  `/agent/api/openapi.json`, `/agent/v1/health`, `/agent/v1/gate-templates`;
  `ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --smoke`
  passed 9/9.

## Current Production Requirements

- Backend: Node.js with TypeScript compiled by `npm run build` in `backend/`.
  The production entrypoint is `node dist/src/index.js`.
- Database: PostgreSQL is required outside `NODE_ENV=test`. Configure
  `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, and `DB_DATABASE`.
- Secrets: set a long random `JWT_SECRET` before production. Do not rely on the
  development fallback. Set `WEBHOOK_SECRET` if outbound webhook signing is used.
- Schema: `DB_SYNCHRONIZE=false` for production. Apply TypeORM migrations with
  `npm run migration:run` before starting a release against a new schema.
- Dashboard: the dashboard is a static site. Serve it through nginx under
  `/agent/`. The current host serves it from the existing
  `/var/www/agent-platform/frontend/dist/` document root.
- CLI and SDK: install with `pip install -e sdk/python` and `pip install -e cli`
  on operator machines or CI smoke hosts. Both packages declare
  `requires-python = ">=3.10"`. `deploy/verify.sh` creates a local `.venv` for
  SDK/CLI import checks so it does not depend on the system Python.
- Auth compatibility: the current backend token endpoint accepts
  `email`/`password`. The CLI and dashboard should guide users to sign in with
  email/password or paste a JWT, then save an identity file for OpenClaw/agent
  runtime use.

## Build And Install

From a clean checkout on the server:

```bash
cd /opt/zhuzeyang-agent/backend
npm ci
npm run build
```

Create a locked-down runtime user and install config:

```bash
sudo useradd --system --home /opt/zhuzeyang-agent --shell /usr/sbin/nologin zzagent
sudo mkdir -p /etc/zhuzeyang-agent
sudo cp deploy/zz-agent.env.example /etc/zhuzeyang-agent/backend.env
sudo editor /etc/zhuzeyang-agent/backend.env
sudo chown root:zzagent /etc/zhuzeyang-agent/backend.env
sudo chmod 0640 /etc/zhuzeyang-agent/backend.env
```

Apply pending database migrations with the same environment variables used by
the backend service:

```bash
cd /opt/zhuzeyang-agent/backend
set -a
. /etc/zhuzeyang-agent/backend.env
set +a
DB_SYNCHRONIZE=false npm run migration:run
```

Install systemd for a fresh server template:

```bash
sudo cp deploy/zz-agent-backend.service /etc/systemd/system/zz-agent-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now zz-agent-backend
sudo systemctl status zz-agent-backend
```

The current cloud host uses `zz-agent-v1.service`, the release symlink under
`/opt/zz-agent-v1/current`, and `/etc/zz-agent-v1/backend.env`. Keep
`SERVICE_NAME=zz-agent-v1` for current-host release and rollback scripts unless
the unit is deliberately renamed.

Install nginx:

```bash
sudo cp deploy/nginx.agent.conf /etc/nginx/sites-available/zz-agent.conf
sudo ln -s /etc/nginx/sites-available/zz-agent.conf /etc/nginx/sites-enabled/zz-agent.conf
sudo nginx -t
sudo systemctl reload nginx
```

## `/agent` Reverse Proxy Behavior

The Express app registers routes directly at `/v1/...`; it does not know about
`/agent`. For the public base URL `https://www.zhuzeyang.xyz/agent`, nginx must
strip the `/agent` prefix for API traffic:

- public request: `/agent/v1/health`
- upstream request to Express: `/v1/health`

The provided `deploy/nginx.agent.conf` does this with:

```nginx
location /agent/v1/ {
    proxy_pass http://zz_agent_backend/v1/;
}
```

Do not proxy `/agent/v1/` to `http://backend/agent/v1/`; that will 404 with the
current Express route table. Root-path API deployment can also work with the
optional `/v1/` location, but CLI users should keep the public base URL at
`https://www.zhuzeyang.xyz/agent`.

## Smoke Checks

Run the smoke script against the local backend or public URL:

```bash
BASE_URL=http://127.0.0.1:3000 bash deploy/smoke.sh
# Direct production smoke requires explicit opt-in (write-like, registers users/projects/agents):
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/smoke.sh
```

The script verifies:

- `GET /v1/health`
- `POST /v1/auth/register`, with login fallback if the smoke user already exists
- `POST /v1/projects`
- `POST /v1/projects/{project_id}/agents` with a fake runtime endpoint URL

For agent collaboration changes (orchestration/inbox/workload), run the full
orchestration smoke loop:

```bash
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent RUN_ORCHESTRATION_SMOKE=1 bash deploy/smoke.sh
# Or via the verify gate (same guard applies):
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --orchestration-smoke
```

This exercises: main+worker agent registration, heartbeat dispatchability, task
create/dispatch/claim/complete/review, inbox notifications, and workload ledger.

Current public evidence (requires opt-in for production target):

```bash
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/smoke.sh
```

This passed after the service was restarted with `DB_SYNCHRONIZE=false`.

For the fuller runtime path, install the CLI and run:

```bash
pip install -e sdk/python
pip install -e cli
export ZZ_BASE_URL=https://www.zhuzeyang.xyz/agent
export ZZ_API_KEY="<jwt-from-smoke-output-or-login-flow>"
zz dev quickstart-runtime --base-url "$ZZ_BASE_URL"
```

`zz dev quickstart-runtime` starts two local fake agents, registers both, creates
a session, sends messages, tails events, and checks project health. If run from a
remote operator machine, make sure the backend can reach the fake-agent endpoint
URLs that the command registers.

See [auth-permission-matrix.md](auth-permission-matrix.md) for the full route/capability matrix (userToken vs agentKey, RBAC roles, and product rationale).

## NAS / LAN Debugging

For NAS deployments where multiple local agents collaborate on the same LAN,
enable file-backed JSONL debug logs and the operator-only recent-log endpoint.
See [nas-lan-debugging.md](nas-lan-debugging.md) for the exact environment
variables, curl commands, and multi-agent test checklist.

## Release Gates

Before cutting a new release or deploying to production, run the verification gate:

```bash
# Local build + typecheck + unit tests + syntax checks
bash deploy/verify.sh

# Check the configured public or local health endpoint (read-only, no opt-in)
BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --health

# Against the production staging URL (smoke) — requires explicit opt-in
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --smoke

# Full orchestration smoke (agent collaboration changes: inbox, workload, dispatch, review)
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --orchestration-smoke

# Full API E2E against BASE_URL with throwaway test users
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --e2e

# Browser-level dashboard E2E against BASE_URL
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --dashboard-e2e
```

`BASE_URL` defaults to `http://127.0.0.1:3000`. `--health` can target any explicit URL, but `--smoke`, `--orchestration-smoke`, `--e2e`, `--dashboard-e2e`, and `--onboarding-smoke` require `ALLOW_REMOTE_VERIFY=1` when `BASE_URL` is not localhost/127.0.0.1.

The gate checks, in order:

| Gate | Check | Fails if |
|------|-------|----------|
| 0 | Prerequisites | node, npm, Python 3.10+, or curl are missing |
| 1 | Backend typecheck | `tsc --noEmit` reports type errors |
| 2 | Backend unit tests | Any of the compiled test scripts fail; better-sqlite3 in-memory test database is used; no sqlite3 native rebuild required |
| 3 | Dashboard JS syntax | Inline `<script>` blocks contain syntax errors |
| 4 | SDK import | Editable install of `sdk/python/` into the local `.venv` fails, or `import zz_agent` fails |
| 5 | CLI import | Editable install of `cli/` into the local `.venv` fails, or `import zz_cli` fails |
| 6 (--health/--smoke/--e2e) | Health endpoint | `GET /v1/health` does not return 200 |
| 7 (--smoke) | deploy/smoke.sh | Registration, project, or agent creation fails |
| 7b (--orchestration-smoke) | deploy/smoke.sh + orchestration loop | Agent dispatch/claim/complete/review or inbox/workload fails |
| 8 (--e2e) | API E2E | Full register→project→agent→session→message→event flow fails |
| 9 (--dashboard-e2e) | Dashboard E2E | Browser login/project/agent/session/file/memory/proposal flow fails |

After the local gates pass, run Python tests with the venv created by `verify.sh`:

```bash
.venv/bin/python -m pip install pytest
.venv/bin/python -m pytest cli/tests test_watch_smoke.py -q
```

## CI Pipeline

`.github/workflows/ci.yml` runs the same gates automatically on every push and pull request:

| Job | Gate | Fails if |
|-----|------|----------|
| `backend` | Typecheck + unit tests | `npm run typecheck` or `npm run test:unit` fails |
| `dashboard` | JS syntax | Inline `<script>` blocks contain syntax errors |
| `sdk-cli` | SDK/CLI compile + import | `python3 -m compileall` or `pip install -e` + `import` fails |
| `migration-dry-run` | Migration compile + run | A migration is missing its compiled JS, or `migration:run` against a fresh PostgreSQL container fails |
| `e2e` (optional) | API E2E | Full register→project→agent→session→message→event flow fails against the provided `API_URL` |

Trigger the workflow manually with the **Run workflow** button and supply an `api_url` to enable the optional E2E job. The E2E job also runs automatically when the repository variable `API_URL` is set.

The migration job uses a temporary PostgreSQL service container (`postgres:16`) and does **not** require production secrets:

```bash
# Local equivalent of the CI migration gate (requires local PostgreSQL)
cd backend
npm run build
DB_HOST=localhost DB_PORT=5432 DB_USERNAME=... DB_PASSWORD=... \
  DB_DATABASE=... DB_SYNCHRONIZE=false npx typeorm migration:show -d dist/src/data-source.js
```

Or validate that migrations compile without a database:

```bash
cd backend
npm run build
node scripts/ci-migration-check.js
```

### Release Workflow

```bash
# 1. Gate
cd /opt/zhuzeyang-agent
bash deploy/verify.sh --smoke

# 2. Build
cd backend
npm ci
npm run build

# 3. Deploy release directory
RELEASE="$(date +%Y%m%d-%H%M%S)-$(git describe --always --dirty)"
mkdir -p "/opt/zz-agent-v1/releases/$RELEASE"
cp -a /opt/zhuzeyang-agent "/opt/zz-agent-v1/releases/$RELEASE/"
ln -sfn "/opt/zz-agent-v1/releases/$RELEASE" /opt/zz-agent-v1/current

# 4. Apply pending migrations
cd /opt/zz-agent-v1/current/backend
set -a
. /etc/zz-agent-v1/backend.env
set +a
DB_SYNCHRONIZE=false npm run migration:run

# 5. Restart
SERVICE_NAME="${SERVICE_NAME:-zz-agent-v1}"
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager

# 6. Post-deploy smoke
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --smoke
```

## Rollback

If a release causes errors, performance regression, or migration issues, roll back with the provided script:

```bash
# Interactive — lists releases, picks previous by default.
# Current cloud default SERVICE_NAME is zz-agent-v1.
sudo bash deploy/rollback.sh

# Roll back to a specific release by name
sudo bash deploy/rollback.sh 20260527-patch-1

# Roll back AND revert the last TypeORM migration (use only if the forward
# migration is known to be safe to undo — data written after the forward
# migration will be orphaned)
sudo bash deploy/rollback.sh --revert-migration

# List available releases without rolling back
bash deploy/rollback.sh --list
```

### Rollback Steps (Manual Equivalent)

If the script is unavailable:

```bash
# 1. List releases
ls -1 /opt/zz-agent-v1/releases/

# 2. Switch symlink
ln -sfn /opt/zz-agent-v1/releases/<target-release> /opt/zz-agent-v1/current

# 3. Optionally revert the last forward migration
cd /opt/zz-agent-v1/current/backend
set -a
. /etc/zz-agent-v1/backend.env
set +a
npm run migration:revert

# 4. Restart
SERVICE_NAME="${SERVICE_NAME:-zz-agent-v1}"
systemctl restart "$SERVICE_NAME"

# 5. Verify
curl -f https://www.zhuzeyang.xyz/agent/v1/health
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/smoke.sh
```

### When to Revert a Migration

- **Do revert** if the forward migration added a table, column, or constraint that the previous release does not support — the service will fail to start without the revert.
- **Do NOT revert** if user data was written using the new schema — reverting drops the column or table and loses that data.
- When in doubt, roll back the code only and leave the schema as-is. A read-only extra column is harmless; a missing column that the old code never references is fine.

## Migration And Data Risk

Production should keep `DB_SYNCHRONIZE=false`. The backend now loads migrations
from `backend/src/migrations` in TypeScript development and from
`backend/dist/src/migrations` after `npm run build`.

For a brand-new PostgreSQL database:

1. Create the database and install or permit the `uuid-ossp` extension.
2. Export `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, and `DB_DATABASE`.
3. Run `DB_SYNCHRONIZE=false npm run migration:run`.
4. Start or restart the backend service.

For an existing production database that was previously created by one
controlled `DB_SYNCHRONIZE=true` launch, do not run the initial migration
directly against the populated schema. First verify that the live schema matches
the V1 baseline represented by `1779897600000-InitialProductionSchema`; if it
does, record only that baseline migration, then run the V2 forward migration.
Do not use `migration:run -- --fake` while multiple pending migrations are on
disk, because it can mark all pending migrations as applied.

```bash
PGPASSWORD="$DB_PASSWORD" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USERNAME" \
  -d "$DB_DATABASE" <<'SQL'
CREATE TABLE IF NOT EXISTS "migrations" (
  "id" SERIAL PRIMARY KEY,
  "timestamp" bigint NOT NULL,
  "name" character varying NOT NULL
);

INSERT INTO "migrations"("timestamp", "name")
SELECT 1779897600000, 'InitialProductionSchema1779897600000'
WHERE NOT EXISTS (
  SELECT 1
  FROM "migrations"
  WHERE "timestamp" = 1779897600000
    AND "name" = 'InitialProductionSchema1779897600000'
);
SQL

DB_SYNCHRONIZE=false npm run migration:run
```

The current V2 migration is `1779984000000-AddProjectSpaceV2`; it adds project
visibility, clone source tracking, markdown project files, file revisions,
project memory, and join request tables. If the live schema differs from the V1
baseline, create and review a forward migration instead of baselining blindly.

Future schema changes should follow this loop:

```bash
npm run migration:generate -- src/migrations/DescriptiveChangeName
npm run build
DB_SYNCHRONIZE=false npm run migration:show
DB_SYNCHRONIZE=false npm run migration:run
```

Do not use synchronize against an existing production database with user data.

## Production Operations

### Service Management

The production backend runs as a systemd unit. All commands assume `root` or `sudo` on the host `139.199.2.76`:

```bash
# Status
systemctl status zz-agent-v1

# View the last 50 log lines
journalctl -u zz-agent-v1 -n 50 --no-pager

# Tail logs in real time
journalctl -u zz-agent-v1 -f

# Restart
systemctl restart zz-agent-v1

# Stop
systemctl stop zz-agent-v1

# Start
systemctl start zz-agent-v1

# Reload unit after editing /etc/systemd/system/zz-agent-backend.service
systemctl daemon-reload
systemctl restart zz-agent-v1
```

### Log Conventions

Starting with the request-id middleware, the backend emits structured JSON logs to stdout/stderr:

```
{"ts":"2026-05-28T14:00:00.000Z","level":"info","msg":"GET /v1/health -> 200","request_id":"abc-123","method":"GET","path":"/v1/health","status":200,"duration_ms":12}
{"ts":"2026-05-28T14:00:01.000Z","level":"error","msg":"Database connection failed","err":"..."}
```

View structured logs with `journalctl` (see above) or pipe to `jq` for filtering:

```bash
# Error-level events only
journalctl -u zz-agent-v1 --since "5 min ago" --no-pager | jq -R 'fromjson? | select(.level=="error")'

# Filter by request-id
journalctl -u zz-agent-v1 --since "1 hour ago" | jq -R 'fromjson? | select(.request_id=="<uuid>")'

# Slow requests (>1s)
journalctl -u zz-agent-v1 --since "1 hour ago" | jq -R 'fromjson? | select(.duration_ms? and .duration_ms > 1000)'
```

### DB Backup

Use `pg_dump` on the database host to create consistent snapshots. The backend connects to PostgreSQL with credentials from `/etc/zz-agent-v1/backend.env`.

```bash
# Source production environment (avoid exposing secrets in process lists)
set -a
. /etc/zz-agent-v1/backend.env
set +a

# Backup to a dated file. Exclude heavy log/event tables if desired.
BACKUP_DIR=/var/backups/zz-agent-v1
mkdir -p "$BACKUP_DIR"
pg_dump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USERNAME" \
  --dbname="$DB_DATABASE" \
  --format=custom \
  --file="$BACKUP_DIR/zz-agent-$(date +%Y%m%d-%H%M%S).dump"

# To exclude large analytics-friendly tables that can be rebuilt:
#   --exclude-table=events --exclude-table=messages
```

Schedule nightly backups via cron (`crontab -e`):

```cron
# Nightly at 02:00 server local time
0 2 * * * root /usr/local/bin/zz-agent-backup.sh
```

Example backup script at `/usr/local/bin/zz-agent-backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR=/var/backups/zz-agent-v1
mkdir -p "$BACKUP_DIR"
set -a; . /etc/zz-agent-v1/backend.env; set +a
pg_dump --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USERNAME" \
  --dbname="$DB_DATABASE" --format=custom \
  --file="$BACKUP_DIR/zz-agent-$(date +%Y%m%d-%H%M%S).dump"
# Prune backups older than 30 days
find "$BACKUP_DIR" -name "zz-agent-*.dump" -mtime +30 -delete
```

### Restore Drill

Practice restoring from a custom-format dump on a staging or fresh database. **Never restore onto the production database without isolating the environment first.**

```bash
# Identify the backup file
ls -1t /var/backups/zz-agent-v1/zz-agent-*.dump | head -3

# Restore to a staging database
# 1. Create a fresh database
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USERNAME" -d postgres \
  -c "CREATE DATABASE zz_agent_staging WITH OWNER $DB_USERNAME;"

# 2. Restore the custom-format dump
pg_restore \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USERNAME" \
  --dbname="zz_agent_staging" \
  --no-owner \
  --verbose \
  /var/backups/zz-agent-v1/zz-agent-20260528-020000.dump

# 3. Verify the restore
PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USERNAME" -d zz_agent_staging \
  -c "SELECT count(*) FROM agents; SELECT count(*) FROM projects;"

# 4. Run a smoke check against the staging instance
BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --health
```

### Nginx Duplicate `server_name` Remediation

The current deploy initially showed `nginx` warnings about a duplicate
`server_name` during reload. PM inspection on 2026-05-28 found two old enabled
backup symlinks:

- `/etc/nginx/sites-enabled/mini-agent.bak.20260528113558`
- `/etc/nginx/sites-enabled/mini-agent.bak.20260528113648`

They were moved to `/etc/nginx/sites-enabled.disabled-backups/`, then
`nginx -t` and `systemctl reload nginx` passed with no duplicate warnings.
If the warning returns, look for another enabled backup/default file with the
same `server_name`.

**On the server** (`ssh root@139.199.2.76 -p 28022`):

```bash
# Find all site configs that reference the same server_name
grep -rn 'server_name' /etc/nginx/sites-enabled/
grep -rn 'server_name' /etc/nginx/conf.d/

# Test the full nginx config to see the exact warning
nginx -t 2>&1

# If a duplicate is an enabled backup/default file:
#   - Remove the conflicting default symlink:
mkdir -p /etc/nginx/sites-enabled.disabled-backups
mv /etc/nginx/sites-enabled/<duplicate-file> /etc/nginx/sites-enabled.disabled-backups/

#   - Or comment out the duplicate server block in the conflicting file.
#   - Then reload:
nginx -t && systemctl reload nginx
```

### ClawHub Plugin Verification

The OpenClaw plugin (`@zhuzeyang/openclaw-agent-social-platform`) is published on ClawHub. Verify plugin integrity and availability:

```bash
# Query ClawHub for the published release
npm exec --yes --package clawhub -- clawhub package inspect @zhuzeyang/openclaw-agent-social-platform --json

# Expected: latestVersion "0.3.7", release id rd74aahn82905ajd0q8neq07cd87jf1a,
# sourceCommit 080d56d, scanStatus "clean".

# Verify the plugin validates correctly from source
cd /home/z/projects/openclaw-agent-social-platform
npm test
npm run plugin:validate
```

### Public Smoke / E2E Commands

```bash
# Quick health check (read-only, no opt-in)
curl -fsS https://www.zhuzeyang.xyz/agent/v1/health

# Full smoke (registration → project → agent) — write-like, requires opt-in
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/smoke.sh

# Full orchestration smoke via the release gate (write-like, requires opt-in)
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --orchestration-smoke

# Release verification gate (local checks only)
bash deploy/verify.sh

# Release verification gate with production health probe (read-only)
BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --health

# Release verification gate with smoke (write-like, requires opt-in)
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --smoke

# Full E2E against production with throwaway users (write-like, requires opt-in)
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --e2e

# Dashboard browser E2E (requires python3 + Playwright on the operator machine; write-like, requires opt-in)
ALLOW_REMOTE_VERIFY=1 BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --dashboard-e2e
```
