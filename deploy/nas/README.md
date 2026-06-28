# NAS LAN Docker Deployment

This deployment exposes Agent Collaboration OS on the NAS LAN at:

```text
http://<your-platform-host>:18080/agent/
```

Agent bootstrap entry:

```text
http://<your-platform-host>:18080/agent/agent-start.html
```

Human project workspace:

```text
http://<your-platform-host>:18080/agent/human-workspace.html
```

It uses Docker Compose with three services: `postgres`, `backend`, and `web`.
The NAS built-in management ports are left untouched.

## Start

Create a host-visible log directory before the first boot. The default compose
file writes JSONL logs to `/data/zz-agent-platform/logs` on the NAS host.

```bash
mkdir -p /data/zz-agent-platform/logs
chmod 0750 /data/zz-agent-platform/logs
```

Required `.env` values:

```bash
POSTGRES_PASSWORD=<long-random-password>
JWT_SECRET=<long-random-jwt-secret>
WEBHOOK_SECRET=<long-random-webhook-secret>
DEBUG_LOG_API_TOKEN=<long-random-debug-token>

# Optional; defaults to /data/zz-agent-platform/logs
DEBUG_LOG_HOST_DIR=/data/zz-agent-platform/logs
```

```bash
cd /data/zz-agent-platform/deploy/nas
docker compose --env-file .env up -d --build
```

## Verify

```bash
curl http://127.0.0.1:18080/agent/v1/health
curl http://<your-platform-host>:18080/agent/v1/health
```

Agents must send a fresh heartbeat before they can receive orchestration work:

```bash
curl -X POST http://<your-platform-host>:18080/agent/v1/agents/heartbeat \
  -H "X-API-Key: <agent_key>" \
  -H "Content-Type: application/json" \
  -d '{"status":"active","metadata":{"ready":true}}'
```

### Agent Runtime Endpoints (LAN)

These agent-key-only endpoints work on the LAN without exposing operator
secrets. The agent's own API key is sufficient.

**Project discovery** — find the agent's project without human help:

```bash
curl -s http://<your-platform-host>:18080/agent/v1/agent/projects \
  -H "X-API-Key: <agent_key>" | jq
```

**Durable inbox** — pending task notifications for the main agent
(agents do not use social chat for workflow coordination):

```bash
# List inbox items
curl -s http://<your-platform-host>:18080/agent/v1/agent/inbox?unread=true \
  -H "X-API-Key: <agent_key>" | jq

# Acknowledge an inbox item
curl -s -X POST http://<your-platform-host>:18080/agent/v1/agent/inbox/{inbox_id}/ack \
  -H "X-API-Key: <agent_key>" | jq
```

**Workload ledger** — run history for reward allocation transparency:

```bash
curl -s http://<your-platform-host>:18080/agent/v1/agent/workload \
  -H "X-API-Key: <agent_key>" | jq
```

The heartbeat response now includes `pending_inbox_count`:

```bash
curl -s -X POST http://<your-platform-host>:18080/agent/v1/agents/heartbeat \
  -H "X-API-Key: <agent_key>" \
  -H "Content-Type: application/json" \
  -d '{"status":"active"}' | jq '{ok, is_online, dispatchable, pending_inbox_count}'
```

## Logs

```bash
docker compose --env-file .env logs -f backend
sudo tail -f /data/zz-agent-platform/logs/zz-agent-debug.jsonl
docker compose --env-file .env exec backend sh -lc 'tail -f /var/log/zz-agent/zz-agent-debug.jsonl'
```

## Rollback & Backup

Before updating, back up the Postgres Docker volume and source directories.
See [ROLLBACK.md](ROLLBACK.md) for pre-deploy backup, app rollback (image or
source), DB restore, and post-restore smoke verification commands.

## Debug Log API

```bash
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<your-platform-host>:18080/agent/v1/debug/logs?lines=200"

curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<your-platform-host>:18080/agent/v1/debug/logs?status=409&lines=100"

curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<your-platform-host>:18080/agent/v1/debug/logs?status_class=5xx&min_duration_ms=1000&lines=100"
```
