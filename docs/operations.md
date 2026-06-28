# Production Operations Evidence

Last verified: 2026-05-29

## 0. Latest Production Release

- Release: `/opt/zz-agent-v1/releases/20260529T200221-p0-docs-landing-product`
- Current symlink: `/opt/zz-agent-v1/current`
- Service: `zz-agent-v1.service` active on `127.0.0.1:8102`
- Static root: `/var/www/agent-platform/frontend/dist/`
- Public URLs:
  - `https://www.zhuzeyang.xyz/agent/`
  - `https://www.zhuzeyang.xyz/agent/product.html`
  - `https://www.zhuzeyang.xyz/agent/docs`
  - `https://www.zhuzeyang.xyz/agent/api/openapi.json`

Predeploy backup:

```text
/var/backups/zz-agent-v1/predeploy-20260529T200221-p0-docs-landing-product.dump
```

Postdeploy verification:

```text
GET /agent/ -> 200, landing.html, 17 KB
GET /agent/product.html -> 200, product.html, 60 KB
GET /agent/docs -> 200, Swagger UI
GET /agent/api/openapi.json -> 200, OpenAPI 3.1
GET /agent/v1/gate-templates -> 200, 3 preset templates
BASE_URL=https://www.zhuzeyang.xyz/agent bash deploy/verify.sh --smoke -> 9 passed, 0 failed
```

## 1. Backup Evidence

### Backup Script

Installed at `/usr/local/bin/zz-agent-backup.sh` (permissions `0750`, owner `root:root`).

The script sources `/etc/zz-agent-v1/backend.env`, runs `pg_dump --format=custom`, and prunes dumps older than 30 days.

### Backup File Path Pattern

```
/var/backups/zz-agent-v1/zz-agent-YYYYMMDD-HHMMSS.dump
```

### Systemd Timer

A systemd timer runs the backup nightly at ~02:00 CST with up to 10 minutes random delay:

```
$ systemctl list-timers zz-agent-backup.timer
NEXT                        LEFT          LAST PASSED UNIT                  ACTIVATES
Fri 2026-05-29 02:09:49 CST 3h 39min left -    -      zz-agent-backup.timer zz-agent-backup.service
```

Unit files:
- `/etc/systemd/system/zz-agent-backup.service` — oneshot, runs the backup script
- `/etc/systemd/system/zz-agent-backup.timer` — `OnCalendar=*-*-* 02:00:00`, `RandomizedDelaySec=600`, `Persistent=true`

### Manual Backup Result (2026-05-28 22:30 CST)

```
$ /usr/local/bin/zz-agent-backup.sh
[zz-agent-backup] dump written: /var/backups/zz-agent-v1/zz-agent-20260528-223046.dump
```

### Dump Verification

```
$ pg_restore --list /var/backups/zz-agent-v1/zz-agent-20260528-223046.dump | head -20
;
; Archive created at 2026-05-28 22:30:46 CST
;     dbname: zz_agent_v1
;     TOC Entries: 146
;     Compression: -1
;     Dump Version: 1.14-0
;     Format: CUSTOM
;     Dumped from database version: 15.18 (Debian 15.18-0+deb12u1)

$ pg_restore --list /var/backups/zz-agent-v1/zz-agent-20260528-223046.dump | wc -l
157
```

146 TOC entries, custom format, valid archive.

## 2. Restore Drill

### Blocker

The `agent_platform` database role (used by the backend and backup script) does not have `CREATEDB` permission:

```
$ psql -h 127.0.0.1 -U agent_platform -d postgres \
    -c "CREATE DATABASE zz_agent_staging WITH OWNER agent_platform;"
ERROR:  permission denied to create database
```

The only superuser is `postgres`, which requires password authentication (scram-sha-256) and the password is not stored in the application env file.

### How to Unblock

Option A: Grant `CREATEDB` to `agent_platform`:
```sql
ALTER ROLE agent_platform CREATEDB;
```

Option B: Use the `postgres` superuser with its password:
```bash
PGPASSWORD="<postgres-password>" pg_restore \
  --host=127.0.0.1 --port=5432 --username=postgres \
  --dbname=zz_agent_staging --no-owner --verbose \
  /var/backups/zz-agent-v1/zz-agent-20260528-223046.dump
```

### Restore Command (once unblocked)

```bash
# 1. Create staging database
psql -h 127.0.0.1 -U <privileged-user> -d postgres \
  -c "CREATE DATABASE zz_agent_staging WITH OWNER agent_platform;"

# 2. Restore
set -a; . /etc/zz-agent-v1/backend.env; set +a
export PGPASSWORD="$DB_PASSWORD"
pg_restore \
  --host="$DB_HOST" --port="$DB_PORT" --username="$DB_USERNAME" \
  --dbname=zz_agent_staging --no-owner --verbose \
  /var/backups/zz-agent-v1/zz-agent-20260528-223046.dump

# 3. Verify row counts
psql -h "$DB_HOST" -U "$DB_USERNAME" -d zz_agent_staging \
  -c "SELECT count(*) FROM agents; SELECT count(*) FROM projects;"
```

## 3. Log Query Examples

All backend logs are structured JSON emitted to stdout, captured by journald.

### Filter by request_id

```bash
journalctl -u zz-agent-v1 --since "1 hour ago" --no-pager \
  | jq -R 'fromjson? | select(.request_id=="36e14022-9165-4031-8bf7-99ace290ff3a")'
```

### Filter 4xx responses

```bash
journalctl -u zz-agent-v1 --since "1 hour ago" --no-pager \
  | jq -R 'fromjson? | select(.status? and .status >= 400 and .status < 500)'
```

Example output (actual production):
```json
{"ts":"2026-05-28T14:21:24.505Z","level":"warn","msg":"POST /v1/agents/heartbeat -> 401","request_id":"c5b3e9ac-43c8-4b15-86d8-f0101a375100","method":"POST","path":"/v1/agents/heartbeat","status":401,"duration_ms":3}
```

### Filter 5xx responses

```bash
journalctl -u zz-agent-v1 --since "1 hour ago" --no-pager \
  | jq -R 'fromjson? | select(.status? and .status >= 500)'
```

### Filter error-level logs

```bash
journalctl -u zz-agent-v1 --since "5 min ago" --no-pager \
  | jq -R 'fromjson? | select(.level=="error")'
```

### Filter slow requests (>1s)

```bash
journalctl -u zz-agent-v1 --since "1 hour ago" --no-pager \
  | jq -R 'fromjson? | select(.duration_ms? and .duration_ms > 1000)'
```

### Live tail with request tracing

```bash
# Tail all logs, pretty-print JSON
journalctl -u zz-agent-v1 -f --no-pager | jq -R 'fromjson?'

# Tail only access logs (have request_id)
journalctl -u zz-agent-v1 -f --no-pager | jq -R 'fromjson? | select(.request_id?)'
```

## 4. Service Commands Reference

```bash
# Status
systemctl status zz-agent-v1

# View recent logs
journalctl -u zz-agent-v1 -n 50 --no-pager

# Restart
systemctl restart zz-agent-v1

# Reload systemd after unit file changes
systemctl daemon-reload
systemctl restart zz-agent-v1

# Backup timer status
systemctl list-timers zz-agent-backup.timer --no-pager

# Trigger a manual backup
/usr/local/bin/zz-agent-backup.sh

# List available backups
ls -lht /var/backups/zz-agent-v1/

# Verify a backup dump
pg_restore --list /var/backups/zz-agent-v1/zz-agent-YYYYMMDD-HHMMSS.dump | head -20
```
