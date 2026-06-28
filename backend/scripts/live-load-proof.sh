#!/usr/bin/env bash
#
# Live / staging load proof entrypoint for Remaining Proof Gap #5.
#
# Targets a real deployed base URL supplied explicitly by the operator. It runs
# a bounded Golden-Path workload, measures poll/claim/complete/e2e latencies,
# and writes a redacted JSON artifact.
#
# Required environment variables:
#   BASE_URL                    Target API base URL, e.g. https://staging.example.com/agent
#                               (must be set explicitly; no implicit localhost default)
#
# Authentication (one of):
#   LOAD_PROOF_OWNER_TOKEN      Existing JWT bearer token for a test owner account
#     OR
#   LOAD_PROOF_EMAIL            + LOAD_PROOF_PASSWORD to register/login a throwaway user
#
# Safety / bounding (optional):
#   ALLOW_REMOTE_VERIFY=1       Required when BASE_URL is not localhost/127.0.0.1
#   LOAD_PROOF_WORKERS=2        Number of concurrent worker agents
#   LOAD_PROOF_TASKS_PER_WORKER=2  Tasks dispatched to each worker
#   LOAD_PROOF_ITERATIONS=1     How many independent project/orchestration runs
#   LOAD_PROOF_MAX_TOTAL_TASKS=50  Hard cap on total tasks (workers * tasks * iterations)
#   LOAD_PROOF_ARTIFACT_DIR     Directory for JSON artifact (default: ./load-proof-artifacts)
#
# Usage:
#   # Staging target with owner token
#   ALLOW_REMOTE_VERIFY=1 BASE_URL=https://staging.example.com/agent \
#     LOAD_PROOF_OWNER_TOKEN="$TOKEN" bash backend/scripts/live-load-proof.sh
#
#   # Staging target with throwaway credentials
#   ALLOW_REMOTE_VERIFY=1 BASE_URL=https://staging.example.com/agent \
#     LOAD_PROOF_EMAIL="loadproof+$(date +%s)@example.invalid" \
#     LOAD_PROOF_PASSWORD="$PASSWORD" bash backend/scripts/live-load-proof.sh
#
# Exit codes:
#   0  load proof passed and artifact written
#   1  proof failed (runtime error, assertion failure, health check failure)
#   2  BLOCKED -- required env missing or remote opt-in not granted
#
set -uo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"

E_OK=0
E_PROOF_FAIL=1
E_BLOCKED=2

log()  { printf '[live-load-proof] %s\n' "$*"; }
err()  { printf '[live-load-proof][ERROR] %s\n' "$*" >&2; }
blocked() { printf '[live-load-proof][BLOCKED] %s\n' "$*" >&2; }

usage() {
  awk 'NR==1{next} /^#/{sub(/^#[[:space:]]?/, ""); print; next} {exit}' "$0"
  exit "${1:-0}"
}

# ---- argument / env parse ----
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage 0
fi

BASE_URL="${BASE_URL:-}"
ALLOW_REMOTE_VERIFY="${ALLOW_REMOTE_VERIFY:-0}"

if [[ -z "$BASE_URL" ]]; then
  blocked 'BASE_URL is required. Set it explicitly to the target staging/production URL.'
  exit "$E_BLOCKED"
fi

if ! [[ "$BASE_URL" =~ ^https?:// ]]; then
  blocked 'BASE_URL must be a valid http(s) URL'
  exit "$E_BLOCKED"
fi

# Re-use the same localhost detection logic as deploy/smoke.sh for consistency.
is_localhost() {
  local host
  host=$(printf '%s' "$BASE_URL" | sed -E 's#^https?://([^/:]+).*#\1#')
  [[ "$host" =~ ^127\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  [[ "$host" == "localhost" ]] || \
  [[ "$host" == "::1" ]] || \
  [[ "$host" == "[::1]" ]]
}

if ! is_localhost && [[ "$ALLOW_REMOTE_VERIFY" != "1" ]]; then
  blocked "BASE_URL ${BASE_URL} is not localhost. Set ALLOW_REMOTE_VERIFY=1 to opt in."
  exit "$E_BLOCKED"
fi

if [[ -z "${LOAD_PROOF_OWNER_TOKEN:-}" ]]; then
  if [[ -z "${LOAD_PROOF_EMAIL:-}" || -z "${LOAD_PROOF_PASSWORD:-}" ]]; then
    blocked 'Authentication not configured. Set LOAD_PROOF_OWNER_TOKEN, or both LOAD_PROOF_EMAIL and LOAD_PROOF_PASSWORD.'
    exit "$E_BLOCKED"
  fi
fi

# Sanity-check that secrets are not being passed as positional args or echoed.
if [[ -n "${LOAD_PROOF_OWNER_TOKEN:-}" ]]; then
  log 'auth: using LOAD_PROOF_OWNER_TOKEN (redacted)'
fi
if [[ -n "${LOAD_PROOF_EMAIL:-}" ]]; then
  # Redact email: show first 3 chars of local part + domain only.
  _local="${LOAD_PROOF_EMAIL%%@*}"
  _domain="${LOAD_PROOF_EMAIL#*@}"
  _redacted="${_local:0:3}***@${_domain}"
  log "auth: using LOAD_PROOF_EMAIL=${_redacted}"
  unset _local _domain _redacted
fi
if [[ -n "${LOAD_PROOF_PASSWORD:-}" ]]; then
  log 'auth: LOAD_PROOF_PASSWORD is set (value redacted)'
fi

log "target: $BASE_URL"
log "workers: ${LOAD_PROOF_WORKERS:-2}, tasks_per_worker: ${LOAD_PROOF_TASKS_PER_WORKER:-2}, iterations: ${LOAD_PROOF_ITERATIONS:-1}"

# ---- build backend ----
cd "$BACKEND_DIR" || { err "backend dir not found: $BACKEND_DIR"; exit "$E_PROOF_FAIL"; }

log 'building backend (npm run build)'
if ! npm run build; then
  err 'backend build failed'
  exit "$E_PROOF_FAIL"
fi

# ---- run live load proof ----
log 'running live load proof probe'
node dist/tests/live-load-proof.test.js
rc=$?

if [[ "$rc" -eq "$E_BLOCKED" ]]; then
  err 'probe exited BLOCKED (2)'
  exit "$E_BLOCKED"
fi
if [[ "$rc" -ne "$E_OK" ]]; then
  err "probe failed (exit $rc)"
  exit "$E_PROOF_FAIL"
fi

log 'live load proof passed'
exit "$E_OK"
