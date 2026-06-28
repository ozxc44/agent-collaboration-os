# NAS Deployment Rollback & Backup Runbook

This runbook covers backup, rollback, and restore procedures for the NAS LAN
Docker deployment (`deploy/nas/`). All commands run on the NAS host unless
otherwise noted.

---

## Pre-Deploy Backup (Do Before Every Update)

Before pulling a new image or updating configuration, take a logical database
backup first. A cold Docker-volume snapshot is useful for whole-volume rollback,
but it must be taken while Postgres is stopped.

```bash
cd /data/zz-agent-platform/deploy/nas

# 1. Logical backup through the running Postgres container
BACKUP_DIR=/data/zz-agent-platform/backups
mkdir -p "$BACKUP_DIR"
BACKUP_TS=$(date +%Y%m%d-%H%M%S)

docker compose --env-file .env exec -T postgres \
  pg_dump -U zz_agent -d zz_agent --format=custom \
  > "$BACKUP_DIR/predeploy-$BACKUP_TS.dump"

echo "Logical backup: $BACKUP_DIR/predeploy-$BACKUP_TS.dump"
```

For a cold volume snapshot, stop writers first and discover the actual Compose
volume mounted at `/var/lib/postgresql/data`:

```bash
cd /data/zz-agent-platform/deploy/nas
BACKUP_DIR=/data/zz-agent-platform/backups
mkdir -p "$BACKUP_DIR"
BACKUP_TS=$(date +%Y%m%d-%H%M%S)

docker compose --env-file .env stop backend postgres

VOLUME_NAME=$(
  docker compose --env-file .env ps -q postgres \
    | xargs docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Name }}{{ end }}{{ end }}'
)

docker run --rm \
  -v "${VOLUME_NAME}":/src/data:ro \
  -v "$BACKUP_DIR":/dest \
  alpine:latest \
  tar czf "/dest/postgres-vol-$BACKUP_TS.tar.gz" -C /src/data .

docker compose --env-file .env up -d postgres backend
echo "Cold volume backup: $BACKUP_DIR/postgres-vol-$BACKUP_TS.tar.gz"
```

---

## App Rollback (Restore Previous Docker Image or Source)

### Option A — Roll back to a previous image tag

```bash
cd /data/zz-agent-platform/deploy/nas

# List current image tags used by the compose services
docker compose --env-file .env config | grep 'image:'

# Pull a specific older tag (example: the image from 24 hours ago)
# If using a registry:
#   docker pull ghcr.io/your-org/zz-agent-backend:previous-tag

# Edit docker-compose.yml to pin the older image tag, then:
docker compose --env-file .env up -d --build backend

# Verify health
curl -fsS http://127.0.0.1:18080/agent/v1/health
```

### Option B — Roll back to a previous synced source directory

If the deployment uses a bind-mounted source directory instead of a Docker image,
restore from the source backup:

```bash
# Assuming source is bind-mounted at /data/zz-agent-platform/backend-src
RSYNC_BACKUP_DIR=/data/zz-agent-platform/source-backups
mkdir -p "$RSYNC_BACKUP_DIR"

# Create a fresh timestamped backup of current source before replacing
sudo rsync -av --delete \
  /data/zz-agent-platform/backend-src/ \
  "$RSYNC_BACKUP_DIR/pre-source-$BACKUP_TS/"

# Restore previous source
sudo rsync -av \
  "$RSYNC_BACKUP_DIR/pre-source-$BACKUP_TS/" \
  /data/zz-agent-platform/backend-src/

# Restart backend to pick up restored source
docker compose --env-file .env restart backend
```

---

## DB Restore Path

### Restore from Docker volume snapshot

```bash
cd /data/zz-agent-platform/deploy/nas
BACKUP_DIR=/data/zz-agent-platform/backups
# Pick the backup file
BACKUP_FILE=$(ls -1t "$BACKUP_DIR"/postgres-vol-*.tar.gz | head -1)
echo "Restoring from: $BACKUP_FILE"

# Stop all writers, including Postgres, before replacing the volume contents.
docker compose --env-file .env stop backend postgres

VOLUME_NAME=$(
  docker compose --env-file .env ps -a -q postgres \
    | xargs docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Name }}{{ end }}{{ end }}'
)

# Clear and restore the volume
docker run --rm \
  -v "${VOLUME_NAME}":/dest/data \
  -v "$BACKUP_DIR":/src \
  alpine:latest \
  sh -c "rm -rf /dest/data/* && tar xzf '/src/$(basename $BACKUP_FILE)' -C /dest/data"

# Restart services
docker compose --env-file .env up -d postgres backend

# Verify
curl -fsS http://127.0.0.1:18080/agent/v1/health
```

### Restore from logical pg_dump file

```bash
cd /data/zz-agent-platform/deploy/nas
BACKUP_DIR=/data/zz-agent-platform/backups
BACKUP_FILE=$(ls -1t "$BACKUP_DIR"/predeploy-*.dump | head -1)

# Stop backend
docker compose --env-file .env stop backend

# Restore via the running Postgres container. The compose file creates the
# `zz_agent` database/user and the official Postgres image grants this user
# superuser privileges inside the container.
docker compose --env-file .env exec -T postgres \
  pg_restore --username=zz_agent --dbname=zz_agent --clean --if-exists \
  < "$BACKUP_FILE"

# Restart backend
docker compose --env-file .env up -d backend

# Verify
curl -fsS http://127.0.0.1:18080/agent/v1/health
```

### Safety Warnings

- **Never restore a production DB backup onto a staging DB that is still in use.**
  Isolate the restore environment first.
- If the backup predates a schema migration, either apply the missing migrations
  before restoring, or restore to a pre-migration snapshot.
- After any restore, run the smoke test:

```bash
curl -fsS http://127.0.0.1:18080/agent/v1/health
BASE_URL=http://127.0.0.1:18080/agent bash deploy/smoke.sh
```

---

## Health & Smoke Verification Commands

After any rollback or restore, verify the deployment is healthy:

```bash
# 1. Health endpoint
curl -fsS http://127.0.0.1:18080/agent/v1/health

# 2. LAN health (from another host on the same network)
curl -fsS http://<your-platform-host>:18080/agent/v1/health

# 3. Basic smoke (user registration, project, agent)
BASE_URL=http://127.0.0.1:18080/agent bash deploy/smoke.sh

# 4. Full orchestration smoke (agent collaboration changes)
BASE_URL=http://127.0.0.1:18080/agent RUN_ORCHESTRATION_SMOKE=1 bash deploy/smoke.sh

# 5. Verify agent inbox endpoint
curl -s http://<your-platform-host>:18080/agent/v1/agent/inbox?unread=true \
  -H "X-API-Key: <agent_key>" | jq '.data | length'

# 6. Check running containers
docker compose --env-file .env ps

# 7. Check backend logs for errors
docker compose --env-file .env logs --tail=50 backend | grep -i error
```
