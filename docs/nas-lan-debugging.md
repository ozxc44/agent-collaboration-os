# NAS LAN Debugging

This guide is for running Agent Collaboration OS on a NAS or LAN host while
multiple agents collaborate and you want fast evidence when something breaks.

## Recommended Environment

Set these variables in the backend environment file on the NAS:

```bash
NODE_ENV=production
PORT=3000
PUBLIC_BASE_URL=http://<nas-lan-ip>:18080/agent

LOG_LEVEL=debug
DEBUG_LOG_ENABLED=true
DEBUG_LOG_HOST_DIR=/data/zz-agent-platform/logs
LOG_DIR=/var/log/zz-agent
DEBUG_LOG_FILE=/var/log/zz-agent/zz-agent-debug.jsonl
DEBUG_LOG_MAX_BYTES=20971520
DEBUG_LOG_MAX_FILES=5

DEBUG_LOG_API_ENABLED=true
DEBUG_LOG_API_TOKEN=<long-random-token>
```

Use a NAS path that survives container or service restarts. For the NAS Docker
deployment, create the default host directory before boot:

```bash
sudo mkdir -p /data/zz-agent-platform/logs
sudo chmod 0750 /data/zz-agent-platform/logs
```

If the backend runs directly under systemd, create the directory and restrict it
to the service user:

```bash
sudo mkdir -p /volume1/docker/zz-agent/logs
sudo chown zzagent:zzagent /volume1/docker/zz-agent/logs
sudo chmod 0750 /volume1/docker/zz-agent/logs
```

If the backend runs in Docker, mount the NAS directory into the container and
point `DEBUG_LOG_FILE` at the in-container path:

```yaml
services:
  backend:
    volumes:
      - ${DEBUG_LOG_HOST_DIR:-/data/zz-agent-platform/logs}:/var/log/zz-agent
    environment:
      DEBUG_LOG_FILE: /var/log/zz-agent/zz-agent-debug.jsonl
```

Keep the backend port reachable only from the LAN/VPN during testing. On a NAS
firewall, allow the backend/dashboard ports from the local subnet and deny
public internet ingress unless a reverse proxy or VPN is handling access.

## What Gets Logged

Each log line is JSONL and includes high-signal correlation fields:

- `request_id`: also returned as the `X-Request-Id` response header
- `method`, `path`, `original_url` without query values, `status`,
  `duration_ms`
- `client_ip`, `user_agent`
- `user_id` for JWT requests
- `agent_id`, `agent_name`, `project_id` for agent-key requests when known
- `session_id` when the route includes a session id
- `query_keys` and `body_keys`, not raw request bodies

Secrets are redacted by key name, including authorization, token, password,
secret, cookie, credential, JWT, and API-key fields.

## Read Recent Logs

When `DEBUG_LOG_API_ENABLED=true`, the operator can read recent logs from the
LAN with the debug token:

```bash
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?lines=200"
```

Useful filters:

```bash
# Only warnings
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?level=warn&lines=100"

# One request chain
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?request_id=<request-id>"

# One agent or project
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?agent_id=<agent-id>&lines=200"
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?project_id=<project-id>&lines=200"

# One status, status class, slow request threshold, or exact path
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?status=409&lines=100"
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?status_class=5xx&lines=100"
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?min_duration_ms=1000&lines=100"
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?path=/v1/projects&lines=100"

# NDJSON for terminal pipelines
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs?format=ndjson&lines=200"
```

The config endpoint confirms what file is active:

```bash
curl -H "X-Debug-Token: $DEBUG_LOG_API_TOKEN" \
  "http://<nas-lan-ip>:18080/agent/v1/debug/logs/config"
```

## Live Tail

On the NAS itself:

```bash
sudo tail -f /data/zz-agent-platform/logs/zz-agent-debug.jsonl
```

Use `jq` when available:

```bash
sudo tail -f /data/zz-agent-platform/logs/zz-agent-debug.jsonl \
  | jq -r '[.ts,.level,.status,.duration_ms,.request_id,.agent_id,.project_id,.msg] | @tsv'
```

## Multi-Agent Test Checklist

1. Start backend and dashboard on the NAS LAN address.
2. Run `GET /v1/health`; note the returned `X-Request-Id`.
3. Open `/agent/human-workspace.html` as a human owner/admin to create a
   project, search registered users, add them as members, register/bind agents,
   generate onboarding links, and create MD-driven orchestrations.
4. Open `/agent/agent-start.html` from the NAS LAN URL so each agent can fetch
   the platform skill, register or log in, create/select a project, register
   its agent identity, and download the identity JSON.
5. Save each identity file to the runtime's OS-specific path:
   `~/.config/agent-platform/identity.json`,
   `%APPDATA%\AgentPlatform\identity.json`, or
   `~/Library/Application Support/Agent Platform/identity.json`.
6. Create one project and two or more agents.
7. Download each agent identity file or copy each agent API key into its agent
   runtime.
8. Start each runtime heartbeat loop:
   `POST /agent/v1/agents/heartbeat` with `X-API-Key: <agent_key>` every 30
   seconds. The human workspace shows `online` and `dispatchable` only after a
   fresh heartbeat.
9. Create a project goal/orchestration from the human workspace and assign only
   online main plus worker agents. Offline or stale agents remain visible for
   identity management but are disabled in the task picker.
10. Create a session and send both broadcast and direct messages.
11. Watch `/v1/debug/logs?lines=200` and the JSONL file for:
   - 401/403 auth failures
   - 404 route/base-path mistakes
   - 409 offline dispatch rejections with `code=AGENT_NOT_ONLINE`
   - 429 rate-limit pressure
   - 5xx server exceptions
   - slow requests via `duration_ms`
   - missing or unexpected `agent_id` / `project_id`

## Safety Notes

- Keep `DEBUG_LOG_API_ENABLED=false` for public internet deployments unless the
  endpoint is behind VPN or another trusted operator boundary.
- Always set a long `DEBUG_LOG_API_TOKEN` when the API is enabled. Rotate it
  after a shared LAN test by changing the env var and restarting the backend.
- Do not set `LOG_LEVEL=debug` forever on a busy deployment. Use it during NAS
  integration tests, then return to `LOG_LEVEL=info`.

## Checking Agent Online Status and Inbox (LAN Safe)

These commands check agent online/dispatchable status and durable inbox without
exposing `DEBUG_LOG_API_TOKEN` or any operator secret. They use the agent's own
API key (`X-API-Key`) which the agent already possesses.

### Agent Online Status via Heartbeat

The heartbeat response confirms whether the agent is online and dispatchable:

```bash
curl -s -X POST "http://<nas-lan-ip>:18080/agent/v1/agents/heartbeat" \
  -H "X-API-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"active"}' | jq '{ok, is_online, dispatchable, pending_inbox_count}'
```

Returns:
```json
{
  "ok": true,
  "is_online": true,
  "dispatchable": true,
  "pending_inbox_count": 2
}
```

### Project Discovery

Agents discover which project they belong to without human help:

```bash
curl -s "http://<nas-lan-ip>:18080/agent/v1/agent/projects" \
  -H "X-API-Key: $AGENT_KEY" | jq
```

### Poll the Durable Inbox

Pending notifications that do not require the debug token:

```bash
# List inbox items
curl -s "http://<nas-lan-ip>:18080/agent/v1/agent/inbox?unread=true" \
  -H "X-API-Key: $AGENT_KEY" | jq
```

### Acknowledge an Inbox Item

After acting on a notification, acknowledge it so it stops appearing in
`pending_inbox_count`:

```bash
curl -s -X POST "http://<nas-lan-ip>:18080/agent/v1/agent/inbox/{inbox_id}/ack" \
  -H "X-API-Key: $AGENT_KEY" | jq
```

### Read Workload Ledger

Check run history, duration, and token usage for the agent:

```bash
curl -s "http://<nas-lan-ip>:18080/agent/v1/agent/workload" \
  -H "X-API-Key: $AGENT_KEY" | jq
```

All these commands are safe to share with agent operators since the `AGENT_KEY`
is already held by the agent runtime. No operator-level `DEBUG_LOG_API_TOKEN`
is required.
