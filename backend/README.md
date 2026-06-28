# ZZ Agent Backend — Agent Collaboration OS

A multi-agent collaboration platform backend built with TypeScript, Express, and TypeORM. Manages projects, agents, sessions, real-time event streams, health monitoring, and webhook integrations.

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment (copy and edit .env)
cp .env.example .env

# Start development server
npx tsx src/index.ts
```

The server starts on `http://localhost:3000` by default (configurable via `PORT` env var).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `JWT_SECRET` | `dev-jwt-secret-change-in-production` | JWT signing secret |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_USERNAME` | `postgres` | Database username |
| `DB_PASSWORD` | `postgres` | Database password |
| `DB_DATABASE` | `zz_agent` | Database name |
| `DB_SYNCHRONIZE` | `false` | Auto-sync TypeORM schema |
| `HEALTH_CHECK_INTERVAL_MINUTES` | `5` | Agent health check interval |
| `WEBHOOK_SECRET` | `dev-webhook-secret` | Webhook HMAC signing secret |
| `LOG_LEVEL` | `info` | Minimum JSON log level: `debug`, `info`, `warn`, or `error` |
| `DEBUG_LOG_ENABLED` | `false` | Enable file-backed JSONL logs when `true` |
| `DEBUG_LOG_FILE` | unset | Absolute or relative JSONL debug log path |
| `LOG_DIR` | `./logs` | Directory used for `zz-agent-debug.jsonl` when file logging is enabled and no file is set |
| `DEBUG_LOG_MAX_BYTES` | `20971520` | Rotate the active JSONL log after this many bytes; `0` disables rotation |
| `DEBUG_LOG_MAX_FILES` | `5` | Number of rotated JSONL files to keep |
| `DEBUG_LOG_API_ENABLED` | `false` | Enable operator-only `/v1/debug/logs` endpoints |
| `DEBUG_LOG_API_TOKEN` | unset | Required token for `/v1/debug/logs` when the endpoint is enabled |

## API Endpoints

### Authentication (`/v1/auth`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/auth/register` | None | Register a new user |
| POST | `/v1/auth/token` | None | Login and get JWT token |
| GET | `/v1/auth/me` | JWT | Get current user info |

### Projects (`/v1/projects`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/projects` | JWT | List user's projects |
| POST | `/v1/projects` | JWT | Create a project |
| GET | `/v1/projects/:project_id` | JWT | Get project details |
| GET | `/v1/projects/:project_id/summary` | JWT | Get project-space summary (file totals, README, recent activity, buckets) |
| PATCH | `/v1/projects/:project_id` | JWT | Update project |
| DELETE | `/v1/projects/:project_id` | JWT | Delete project |
| GET | `/v1/projects/:project_id/members` | JWT | List project members |
| POST | `/v1/projects/:project_id/members` | JWT | Add project member |
| PATCH | `/v1/projects/:project_id/members/:user_id` | JWT | Update member role |
| DELETE | `/v1/projects/:project_id/members/:user_id` | JWT | Remove member |

### Agents (`/v1/projects/:project_id/agents`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/projects/:project_id/agents` | JWT | List agents in project |
| POST | `/v1/projects/:project_id/agents` | JWT | Create agent |
| GET | `/v1/projects/:project_id/agents/:aid` | JWT | Get agent details |
| PATCH | `/v1/projects/:project_id/agents/:aid` | JWT | Update agent |
| POST | `/v1/projects/:project_id/agents/:aid/rotate-key` | JWT | Rotate agent API key |
| POST | `/v1/projects/:project_id/agents/:aid/send` | JWT | Send message to agent |
| GET | `/v1/projects/:project_id/agents/:aid/runs` | JWT | List agent run records |

### Agent Health & Metrics

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/agents/heartbeat` | API Key | Agent heartbeat |
| POST | `/v1/agents/metrics` | API Key | Report agent metrics |
| GET | `/v1/agents/:aid/health` | JWT | Get agent health status |

### Sessions (`/v1/projects/:project_id/sessions`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/projects/:project_id/sessions` | JWT | List sessions |
| POST | `/v1/projects/:project_id/sessions` | JWT | Create session |
| GET | `/v1/projects/:project_id/sessions/:sid` | JWT | Get session + messages |
| POST | `/v1/projects/:project_id/sessions/:sid/messages` | JWT | Send message to session |

### Events & SSE

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/sessions/:id/stream` | JWT | SSE event stream |
| POST | `/v1/projects/:project_id/events` | HMAC | Webhook event delivery |

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/health` | None | Platform health check |
| GET | `/v1/projects/:project_id/health` | JWT | Project health |
| GET | `/v1/projects/:project_id/health/incidents` | JWT | List project incidents |
| PATCH | `/v1/projects/:project_id/health/incidents/:iid` | JWT | Update incident |

### Debug Logs

These endpoints are disabled unless `DEBUG_LOG_API_ENABLED=true` and require
`X-Debug-Token: <DEBUG_LOG_API_TOKEN>`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/debug/logs` | Debug token | Read recent JSONL debug logs with filters such as `lines`, `level`, `request_id`, `agent_id`, `project_id`, and `format=ndjson` |
| GET | `/v1/debug/logs/config` | Debug token | Show active debug log file/configuration |

### Incidents

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/incidents` | JWT | List all incidents |
| GET | `/v1/incidents/:id` | JWT | Get incident details |
| PATCH | `/v1/incidents/:id` | JWT | Acknowledge/resolve/dismiss |
| GET | `/v1/projects/:project_id/agents/:agent_id/incidents` | JWT | List agent incidents |
| POST | `/v1/projects/:project_id/agents/:agent_id/health-check` | JWT | Trigger health check |

### MCP Capabilities

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/v1/projects/:pid/mcp/capabilities` | JWT | Register MCP capability |
| GET | `/v1/projects/:pid/mcp/capabilities` | JWT | List MCP capabilities |
| DELETE | `/v1/projects/:pid/mcp/capabilities/:cid` | JWT | Delete MCP capability |

## Running Demos

The `demo/` directory contains interactive demos showcasing multi-agent collaboration:

### Code Review Swarm

Demonstrates two agents (reviewer-bot and auto-approve-bot) collaborating on a code review:

```bash
# Terminal 1: Start the backend
npx tsx src/index.ts

# Terminal 2: Run the demo
npx tsx demo/demo-code-review-swarm.ts
```

### Customer Support Swarm

Demonstrates three agents (triage-bot, faq-bot, escalation-bot) handling customer support:

```bash
npx tsx demo/demo-customer-support-swarm.ts
```

## Running E2E Tests

The E2E test suite verifies 11 core API flows using pure Node.js fetch:

```bash
# Terminal 1: Start the backend
npx tsx src/index.ts

# Terminal 2: Run the tests
npx tsx tests/e2e-api.test.ts
```

Tests cover:
1. User registration and JWT token acquisition
2. Project creation
3. Project member management
4. Agent creation (with API key)
5. Session creation
6. Message sending
7. Message list retrieval
8. Agent heartbeat (API key auth)
9. Agent health query
10. Project agent listing
11. SSE event stream connection

## Authentication

### JWT (User Auth)

Register or login to receive a JWT token:

```bash
# Register
curl -X POST http://localhost:3000/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"secret"}'

# Login
curl -X POST http://localhost:3000/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"secret"}'
```

Use the token in subsequent requests: `Authorization: Bearer <token>`

### API Key (Agent Auth)

Agents authenticate via API key (generated on creation):

```bash
# Agent heartbeat
curl -X POST http://localhost:3000/v1/agents/heartbeat \
  -H "X-API-Key: zzk_..." \
  -H "Content-Type: application/json" \
  -d '{"status":"active"}'
```

## RBAC Permissions

| Role | Permissions |
|---|---|
| Owner | All permissions |
| Admin | All except DeleteProject |
| Member | ViewProject, CreateAgent, CreateSession, SendMessage, ViewSession, ViewHealth |
| Viewer | ViewProject, ViewSession, ViewHealth |

## Project Structure

```
backend/
├── demo/                          # Demo scripts
│   ├── demo-code-review-swarm.ts  # Code review multi-agent demo
│   └── demo-customer-support-swarm.ts  # Customer support multi-agent demo
├── src/
│   ├── app.ts                     # Express app setup
│   ├── index.ts                   # Server entry point
│   ├── data-source.ts             # TypeORM database config
│   ├── entities/                  # Database entities
│   │   ├── user.entity.ts         # User model
│   │   ├── project.entity.ts      # Project model
│   │   ├── project-member.entity.ts # Project membership & roles
│   │   ├── agent.entity.ts        # Agent model
│   │   ├── session.entity.ts      # Session model
│   │   ├── session-participant.entity.ts # Session participants
│   │   ├── message.entity.ts      # Message model
│   │   ├── event.entity.ts        # Event model (SSE)
│   │   ├── incident.entity.ts     # Agent health incidents
│   │   ├── project-incident.entity.ts # Project-level incidents
│   │   └── mcp-capability.entity.ts    # MCP capability registry
│   ├── middleware/
│   │   ├── auth.ts                # JWT & API key authentication
│   │   └── rbac.ts               # Role-based access control
│   ├── routes/
│   │   ├── auth.routes.ts         # Auth endpoints
│   │   ├── projects.routes.ts     # Project CRUD & members
│   │   ├── agents.routes.ts       # Agent CRUD & messaging
│   │   ├── sessions.routes.ts     # Session & message endpoints
│   │   ├── events.routes.ts       # SSE stream & webhook ingestion
│   │   ├── health.routes.ts       # Health check endpoints
│   │   ├── incidents.routes.ts    # Incident management
│   │   └── mcp.routes.ts          # MCP capability endpoints
│   └── services/
│       ├── auth.service.ts        # Registration & login logic
│       ├── event-stream.service.ts # SSE event management
│       ├── webhook.service.ts     # Outbound webhook delivery
│       ├── health-monitor.service.ts # Agent anomaly detection
│       ├── alert-routing.service.ts  # Alert routing & resolution
│       └── mcp-bridge.service.ts  # MCP capability management
├── tests/
│   └── e2e-api.test.ts            # End-to-end API test suite
├── tsconfig.json
└── package.json
```

## Development

```bash
# Type checking
npx tsc --noEmit

# Build
npm run build

# Production start
npm start
```
