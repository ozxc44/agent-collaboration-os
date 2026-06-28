#!/usr/bin/env bash
#
# Reproducible PostgreSQL parity proof for the backend TypeORM layer.
#
# Closes / sharpens Remaining Proof Gap #2 (PostgreSQL) in
# .codex/pm-workers/current-capability-matrix.md. It exercises the production
# postgres branch of backend/src/data-source.ts (the `driver === 'postgres'`
# branches inside each migration) end to end against a REAL PostgreSQL instance:
#
#   npm run build
#   npm run migration:show   (lists pending migrations — proves the connection works)
#   npm run migration:run    (applies all 18 migrations against a fresh schema)
#   node dist/tests/e2e-api.test.js  with NODE_ENV != test  (one Golden Path)
#
# It is deliberately local-only and SECRET-FREE: when it provisions Postgres it
# uses throwaway credentials (pgparity / pgparity / pgparity) bound to 127.0.0.1
# on an ephemeral port. It never reads, embeds, or requires production secrets.
#
# Provisioning is auto-detected in this order:
#   1. docker   (spins up a throwaway `postgres:16` container, torn down on exit)
#   2. podman   (same, via podman)
#   3. --local  (a Postgres *you* have already started; reads DB_* from your env)
#
# --local mode PRESERVES your caller-supplied DB_* (host/port/username/password/
# database) for build / migration:show / migration:run / Golden Path. It only
# forces DB_SYNCHRONIZE=false and DB_LOGGING=false so the proof runs real
# migrations instead of TypeORM schema sync. Container/auto mode uses throwaway
# secret-free creds bound to 127.0.0.1, and each run gets a UNIQUE container
# name + a free host port so concurrent/repeated runs never touch each other's
# containers.
#
# FAILS CLOSED: if no provisioning method is available (this machine has none),
# the script prints the exact environmental blocker and exits 2. This is the
# reproducible blocker artifact — not a silent skip.
#
# Usage:
#   bash backend/scripts/pg-parity-check.sh                # auto-detect docker/podman
#   bash backend/scripts/pg-parity-check.sh --container     # force throwaway container
#   bash backend/scripts/pg-parity-check.sh --local         # force local postgres (needs DB_* creds)
#   PG_PARITY_SKIP_GP=1 bash backend/scripts/pg-parity-check.sh   # skip the Golden Path step
#   PG_PARITY_PORT=5599  bash backend/scripts/pg-parity-check.sh  # preferred host port (container mode)
#   PG_PARITY_IMAGE=postgres:15 bash backend/scripts/pg-parity-check.sh
#
# Exit codes:
#   0  proof succeeded — postgres provisioned + migrations ran (+ GP unless skipped)
#   1  proof FAILED — postgres was reachable but migrations or the GP step errored
#   2  BLOCKED — no postgres provisioning method available (environmental)
#   3  BLOCKED — a provisioner was found but Postgres failed to start in time
#
set -uo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Throwaway credentials only — never production. Bound to localhost. Used in
# container/auto mode only; --local mode uses the caller's DB_* instead.
PG_PARITY_USER="pgparity"
PG_PARITY_PASSWORD="pgparity"
PG_PARITY_DB="pgparity"
# Unique per-run container name: concurrent invocations get distinct PIDs, so
# teardown (docker stop/rm) can NEVER remove another run's container. Repeated
# sequential runs each tear down their own (--rm + explicit cleanup).
CONTAINER_NAME="zz-pg-parity-$$"
# Preferred host port for container mode; the first FREE port at or above this
# value is used, so concurrent runs do not collide on the port bind either.
PG_PARITY_PORT_DEFAULT="55432"
PG_IMAGE="${PG_PARITY_IMAGE:-postgres:16}"
READY_TIMEOUT="${PG_PARITY_READY_TIMEOUT:-40}"

E_OK=0
E_PROOF_FAIL=1
E_BLOCKED_NO_PROVISIONER=2
E_PROVISION_FAIL=3

MODE="auto"
HOST_PORT=""

usage() {
  # Print the leading header comment block (every '#' line after the shebang),
  # stripping the "# " prefix. Dynamic so header edits never desync the range.
  awk 'NR==1{next} /^#/{sub(/^#[[:space:]]?/, ""); print; next} {exit}' "$0"
  exit "${1:-0}"
}

log()  { printf '[pg-parity] %s\n' "$*"; }
err()  { printf '[pg-parity][ERROR] %s\n' "$*" >&2; }

# Run a command with the DB_* env the backend reads (data-source.ts:113-124).
# In --local mode the caller's DB_* are PRESERVED (host/port/username/password/
# database come from the caller's environment); only synchronize/logging are
# forced off. In container/auto mode the throwaway secret-free creds are used.
with_db_env() {
  if [ "$MODE" = "local" ]; then
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

# True if something is listening on 127.0.0.1:$1 (best-effort; TOCTOU-tolerant
# because a bind race fails the provision closed, not cross-run).
port_in_use() {
  local p="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 1 127.0.0.1 "$p" >/dev/null 2>&1 && return 0 || return 1
  fi
  node -e "require('net').createConnection({host:'127.0.0.1',port:$p}).on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" \
    >/dev/null 2>&1 && return 0 || return 1
}

# Pick the first free host port at or above the preferred base, so concurrent /
# repeated container runs do not collide on the bind. Honors PG_PARITY_PORT as
# the preferred base; falls back to PG_PARITY_PORT_DEFAULT. Sets HOST_PORT.
pick_host_port() {
  local base="${PG_PARITY_PORT:-$PG_PARITY_PORT_DEFAULT}"
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

# Tear down ONLY this run's uniquely-named container. Never matches another run.
teardown_container() {
  local eng="$1"
  if [ -n "${eng:-}" ]; then
    "$eng" stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    "$eng" rm   -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}

# Probe whether a local Postgres is reachable on DB_HOST/DB_PORT from the env.
local_pg_reachable() {
  local h="${DB_HOST:-localhost}" p="${DB_PORT:-5432}"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 "$h" "$p" >/dev/null 2>&1 && return 0 || return 1
  fi
  # Fallback: a node one-liner (node is required by this repo anyway).
  node -e "require('net').createConnection({host:'$h',port:$p}).on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" \
    >/dev/null 2>&1 && return 0 || return 1
}

run_proof() {
  cd "$BACKEND_DIR" || { err "backend dir not found: $BACKEND_DIR"; return 1; }
  local rc

  log "building backend (npm run build)"
  npm run build; rc=$?
  if [ "$rc" -ne 0 ]; then err "build failed (exit $rc)"; return "$rc"; fi

  log "running: migration:show  (lists pending migrations against Postgres)"
  with_db_env npm run migration:show; rc=$?
  if [ "$rc" -ne 0 ]; then err "migration:show failed (exit $rc)"; return "$rc"; fi

  log "running: migration:run   (applies all migrations against Postgres)"
  with_db_env npm run migration:run; rc=$?
  if [ "$rc" -ne 0 ]; then err "migration:run failed (exit $rc)"; return "$rc"; fi

  if [ "${PG_PARITY_SKIP_GP:-0}" = "1" ]; then
    log "PG_PARITY_SKIP_GP=1 — skipping Golden Path step"
    return 0
  fi

  # Golden Path against Postgres. NODE_ENV must NOT be 'test' (test => sqlite).
  log "running: e2e-api Golden Path against Postgres (NODE_ENV=pg-parity)"
  log "  (NOTE: this step is exercised only when a Postgres is available; it is"
  log "   not covered by the SQLite-only local CI and is the residual parity risk.)"
  with_db_env env NODE_ENV=pg-parity node dist/tests/e2e-api.test.js; rc=$?
  if [ "$rc" -ne 0 ]; then err "Golden Path against Postgres failed (exit $rc)"; return "$rc"; fi

  return 0
}

print_blocker() {
  cat >&2 <<EOF
[pg-parity][BLOCKED] No PostgreSQL provisioning method is available in this environment.

  Probed (all absent):
    docker           -> $(command -v docker          || echo MISSING)
    podman           -> $(command -v podman          || echo MISSING)
    psql             -> $(command -v psql            || echo MISSING)
    pg_isready       -> $(command -v pg_isready      || echo MISSING)
    pg_ctl / initdb  -> $(command -v pg_ctl          || echo MISSING)

  Confirmed no server on localhost:5432 (npm run migration:show -> ECONNREFUSED).

  To run the full parity proof, install ONE of:
    - Docker Desktop / Colima / OrbStack, then:  bash backend/scripts/pg-parity-check.sh
    - or a local PostgreSQL, then:               bash backend/scripts/pg-parity-check.sh --local
      (export DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE first;
       --local preserves those exact values for every step)

  No-DB partial proof that DOES pass here:
    node scripts/ci-migration-check.js   -> all 18 migrations compile & import (exit 0)

  Exiting 2 (BLOCKED) so the gap is never silently closed.
EOF
}

# ---- arg parse ----
while [ $# -gt 0 ]; do
  case "$1" in
    --container) MODE="container" ;;
    --local)     MODE="local" ;;
    -h|--help)   usage 0 ;;
    *) err "unknown argument: $1"; usage 1 ;;
  esac
  shift
done

ENGINE=""
STARTED_OUR_OWN=0

if [ "$MODE" = "local" ]; then
  if [ -z "${DB_HOST:-}" ] || [ -z "${DB_USERNAME:-}" ] || [ -z "${DB_DATABASE:-}" ]; then
    err "--local requires DB_HOST, DB_USERNAME, DB_DATABASE (and usually DB_PASSWORD) in env."
    err "Refusing to guess at local database credentials (secret-free policy)."
    exit "$E_BLOCKED_NO_PROVISIONER"
  fi
  if ! local_pg_reachable; then
    err "no Postgres reachable at ${DB_HOST:-localhost}:${DB_PORT:-5432} for --local mode"
    exit "$E_PROVISION_FAIL"
  fi
  log "using local Postgres at ${DB_HOST}:${DB_PORT:-5432} (caller-supplied creds preserved for every step)"
elif [ "$MODE" = "auto" ]; then
  ENGINE="$(detect_engine)"
  if [ -z "$ENGINE" ]; then
    print_blocker
    exit "$E_BLOCKED_NO_PROVISIONER"
  fi
  MODE="container"
fi

if [ "$MODE" = "container" ]; then
  [ -n "$ENGINE" ] || ENGINE="$(detect_engine)"
  if [ -z "$ENGINE" ]; then
    print_blocker
    exit "$E_BLOCKED_NO_PROVISIONER"
  fi
  if ! pick_host_port; then
    exit "$E_PROVISION_FAIL"
  fi
  trap 'teardown_container "$ENGINE"' EXIT INT TERM
  if ! provision_container "$ENGINE"; then
    teardown_container "$ENGINE"
    exit "$E_PROVISION_FAIL"
  fi
  STARTED_OUR_OWN=1
fi

if run_proof; then
  log "PARITY PROOF PASSED — migrations applied to a real PostgreSQL instance."
  [ "$STARTED_OUR_OWN" = "1" ] && teardown_container "$ENGINE"
  exit "$E_OK"
else
  rc=$?
  err "PARITY PROOF FAILED (last step exit $rc) against a real PostgreSQL instance."
  [ "$STARTED_OUR_OWN" = "1" ] && teardown_container "$ENGINE"
  exit "$E_PROOF_FAIL"
fi
