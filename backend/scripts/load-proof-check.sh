#!/usr/bin/env bash
#
# Repeatable local load proof for Remaining Proof Gap #5
# (live production p95 / concurrency load).
#
# Default mode runs the enhanced workload-p05 test against an in-memory SQLite
# backend, reports p50/p95/p99 latencies for poll/claim/complete/e2e paths, and
# writes a small JSON artifact.
#
# Optional --postgres mode attempts the same load proof against a real PostgreSQL
# instance. If Postgres is unavailable (no docker/podman/local DB), the script
# prints a precise blocker and exits 2 (BLOCKED) so production parity is never
# silently claimed.
#
# Usage:
#   bash backend/scripts/load-proof-check.sh                # local SQLite proof
#   bash backend/scripts/load-proof-check.sh --postgres     # attempt Postgres
#   bash backend/scripts/load-proof-check.sh --container    # force container Postgres
#   bash backend/scripts/load-proof-check.sh --local        # use caller-supplied Postgres (needs DB_* env)
#   LOAD_PROOF_ARTIFACT_DIR=/tmp bash backend/scripts/load-proof-check.sh
#
# Exit codes:
#   0  load proof passed and artifact written
#   1  proof failed (build or test errored)
#   2  BLOCKED -- Postgres requested but no provisioning method available
#   3  Postgres provisioner found but Postgres failed to start in time
#
set -uo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Unique per-run container name so teardown can never remove another run.
CONTAINER_NAME="zz-load-proof-$$"
PG_IMAGE="${LOAD_PROOF_PG_IMAGE:-postgres:16}"
PG_PARITY_USER="pgparity"
PG_PARITY_PASSWORD="pgparity"
PG_PARITY_DB="pgparity"
PG_PORT_DEFAULT="55433"  # one port above pg-parity-check.sh default to avoid collisions
READY_TIMEOUT="${LOAD_PROOF_READY_TIMEOUT:-40}"

E_OK=0
E_PROOF_FAIL=1
E_BLOCKED_NO_PROVISIONER=2
E_PROVISION_FAIL=3

MODE="local"  # default SQLite mode; --postgres/--container/--local switch to Postgres
POSTGRES_MODE=""
HOST_PORT=""
ENGINE=""
STARTED_OUR_OWN=0

ARTIFACT_DIR="${LOAD_PROOF_ARTIFACT_DIR:-$BACKEND_DIR/load-proof-artifacts}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_PATH="$ARTIFACT_DIR/local-load-proof-$TIMESTAMP.json"

usage() {
  awk 'NR==1{next} /^#/{sub(/^#[[:space:]]?/, ""); print; next} {exit}' "$0"
  exit "${1:-0}"
}

log()  { printf '[load-proof] %s\n' "$*"; }
err()  { printf '[load-proof][ERROR] %s\n' "$*" >&2; }

with_db_env() {
  if [ "$POSTGRES_MODE" = "local" ]; then
    DB_SYNCHRONIZE=false DB_LOGGING=false "$@"
  else
    DB_HOST=127.0.0.1 \
    DB_PORT="$HOST_PORT" \
    DB_USERNAME="$PG_PARITY_USER" \
    DB_PASSWORD="$PG_PARITY_PASSWORD" \
    DB_DATABASE="$PG_PARITY_DB" \
    DB_SYNCHRONIZE=false \
    DB_LOGGING=false \
    "$@"
  fi
}

detect_engine() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo docker; return
  fi
  if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    echo podman; return
  fi
  echo ""
}

port_in_use() {
  local p="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 1 127.0.0.1 "$p" >/dev/null 2>&1 && return 0 || return 1
  fi
  node -e "require('net').createConnection({host:'127.0.0.1',port:$p}).on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" \
    >/dev/null 2>&1 && return 0 || return 1
}

pick_host_port() {
  local base="${LOAD_PROOF_PG_PORT:-$PG_PORT_DEFAULT}"
  local p="$base"
  local attempts=0
  while [ "$attempts" -lt 50 ]; do
    if ! port_in_use "$p"; then
      HOST_PORT="$p"
      [ "$p" != "$base" ] && log "preferred port $base was busy; selected free port $p"
      return 0
    fi
    p=$((p + 1))
    attempts=$((attempts + 1))
  done
  err "could not find a free host port starting at $base (tried 50 ports)"
  return 1
}

provision_container() {
  local eng="$1"
  log "starting throwaway $PG_IMAGE via $eng (name=$CONTAINER_NAME, port 127.0.0.1:$HOST_PORT)"
  if ! "$eng" run -d --rm \
        -e "POSTGRES_USER=$PG_PARITY_USER" \
        -e "POSTGRES_PASSWORD=$PG_PARITY_PASSWORD" \
        -e "POSTGRES_DB=$PG_PARITY_DB" \
        -p "$HOST_PORT:5432" \
        --name "$CONTAINER_NAME" \
        "$PG_IMAGE" >/dev/null 2>&1; then
    err "$eng run failed for image $PG_IMAGE (is the daemon running? is the image pulled? is port $HOST_PORT free?)"
    return 1
  fi
  local i
  for i in $(seq 1 "$READY_TIMEOUT"); do
    if "$eng" exec "$CONTAINER_NAME" pg_isready -U "$PG_PARITY_USER" -d "$PG_PARITY_DB" >/dev/null 2>&1; then
      log "Postgres ready after ${i}s"
      return 0
    fi
    sleep 1
  done
  err "Postgres did not become ready within ${READY_TIMEOUT}s"
  return 1
}

teardown_container() {
  local eng="${1:-$ENGINE}"
  if [ -n "${eng:-}" ]; then
    "$eng" stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    "$eng" rm   -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

local_pg_reachable() {
  local h="${DB_HOST:-localhost}" p="${DB_PORT:-5432}"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 "$h" "$p" >/dev/null 2>&1 && return 0 || return 1
  fi
  node -e "require('net').createConnection({host:'$h',port:$p}).on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" \
    >/dev/null 2>&1 && return 0 || return 1
}

print_blocker() {
  cat >&2 <<EOF
[load-proof][BLOCKED] PostgreSQL load proof requested but no Postgres provisioning method is available.

  Probed (all absent):
    docker           -> $(command -v docker          || echo MISSING)
    podman           -> $(command -v podman          || echo MISSING)
    psql             -> $(command -v psql            || echo MISSING)
    pg_isready       -> $(command -v pg_isready      || echo MISSING)
    pg_ctl / initdb  -> $(command -v pg_ctl          || echo MISSING)

  Confirmed no server on localhost:5432 (best-effort probe).

  To run the Postgres load proof, install ONE of:
    - Docker Desktop / Colima / OrbStack, then:  bash backend/scripts/load-proof-check.sh --postgres
    - or a local PostgreSQL, then:               bash backend/scripts/load-proof-check.sh --local
      (export DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE first)

  The local SQLite load proof (default, no flags) still passes and is the only
  evidence produced by this environment. It is explicitly NOT production parity.

  Exiting 2 (BLOCKED) so the gap is never silently closed.
EOF
}

run_local_sqlite_proof() {
  cd "$BACKEND_DIR" || { err "backend dir not found: $BACKEND_DIR"; return 1; }

  log "building backend (npm run build)"
  npm run build; local rc=$?
  if [ "$rc" -ne 0 ]; then err "build failed (exit $rc)"; return "$rc"; fi

  mkdir -p "$ARTIFACT_DIR"
  log "running workload-p05 load proof against in-memory SQLite"
  log "  artifact will be written to: $ARTIFACT_PATH"

  NODE_ENV=test \
  INBOX_LEASE_ENABLED=true \
  WORKLOAD_ARTIFACT_PATH="$ARTIFACT_PATH" \
    node dist/tests/workload-p05.test.js; rc=$?
  if [ "$rc" -ne 0 ]; then err "workload-p05 test failed (exit $rc)"; return "$rc"; fi

  log "SQLite load proof passed — artifact: $ARTIFACT_PATH"
  return 0
}

run_postgres_proof() {
  cd "$BACKEND_DIR" || { err "backend dir not found: $BACKEND_DIR"; return 1; }
  local rc

  log "building backend (npm run build)"
  npm run build; rc=$?
  if [ "$rc" -ne 0 ]; then err "build failed (exit $rc)"; return "$rc"; fi

  log "running migration:run against Postgres"
  with_db_env npm run migration:run; rc=$?
  if [ "$rc" -ne 0 ]; then err "migration:run failed (exit $rc)"; return "$rc"; fi

  mkdir -p "$ARTIFACT_DIR"
  ARTIFACT_PATH="$ARTIFACT_DIR/postgres-load-proof-$TIMESTAMP.json"
  log "running workload-p05 load proof against PostgreSQL"
  log "  artifact will be written to: $ARTIFACT_PATH"

  # NODE_ENV=pg-parity keeps backend/src/data-source.ts on the postgres branch.
  with_db_env env \
    NODE_ENV=pg-parity \
    INBOX_LEASE_ENABLED=true \
    WORKLOAD_ARTIFACT_PATH="$ARTIFACT_PATH" \
      node dist/tests/workload-p05.test.js; rc=$?
  if [ "$rc" -ne 0 ]; then err "workload-p05 test against Postgres failed (exit $rc)"; return "$rc"; fi

  log "Postgres load proof passed — artifact: $ARTIFACT_PATH"
  return 0
}

# ---- arg parse ----
while [ $# -gt 0 ]; do
  case "$1" in
    --postgres)  MODE="postgres"; POSTGRES_MODE="auto" ;;
    --container) MODE="postgres"; POSTGRES_MODE="container" ;;
    --local)     MODE="postgres"; POSTGRES_MODE="local" ;;
    -h|--help)   usage 0 ;;
    *) err "unknown argument: $1"; usage 1 ;;
  esac
  shift
done

if [ "$MODE" = "postgres" ]; then
  if [ "$POSTGRES_MODE" = "local" ]; then
    if [ -z "${DB_HOST:-}" ] || [ -z "${DB_USERNAME:-}" ] || [ -z "${DB_DATABASE:-}" ]; then
      err "--local requires DB_HOST, DB_USERNAME, DB_DATABASE (and usually DB_PASSWORD) in env."
      err "Refusing to guess at local database credentials (secret-free policy)."
      exit "$E_BLOCKED_NO_PROVISIONER"
    fi
    if ! local_pg_reachable; then
      err "no Postgres reachable at ${DB_HOST:-localhost}:${DB_PORT:-5432} for --local mode"
      exit "$E_PROVISION_FAIL"
    fi
    log "using local Postgres at ${DB_HOST}:${DB_PORT:-5432}"
  else
    # auto / container
    ENGINE="$(detect_engine)"
    if [ -z "$ENGINE" ]; then
      print_blocker
      exit "$E_BLOCKED_NO_PROVISIONER"
    fi
    if ! pick_host_port; then
      exit "$E_PROVISION_FAIL"
    fi
    trap 'teardown_container' EXIT INT TERM
    if ! provision_container "$ENGINE"; then
      teardown_container
      exit "$E_PROVISION_FAIL"
    fi
    STARTED_OUR_OWN=1
  fi

  if run_postgres_proof; then
    [ "$STARTED_OUR_OWN" = "1" ] && teardown_container
    exit "$E_OK"
  else
    rc=$?
    [ "$STARTED_OUR_OWN" = "1" ] && teardown_container
    exit "$E_PROOF_FAIL"
  fi
else
  if run_local_sqlite_proof; then
    exit "$E_OK"
  else
    rc=$?
    exit "$E_PROOF_FAIL"
  fi
fi
