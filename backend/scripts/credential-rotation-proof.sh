#!/usr/bin/env bash
#
# Production Credential Rotation Proof — Remaining Proof Gap #6
#
# Validates credential lifecycle operations (rotate, revoke, retire, supersede)
# against a target API. Two modes:
#
#   --local     (default) Run the existing credential-lifecycle test against an
#               in-memory SQLite database. No external dependencies required.
#
#   --probe     Read-only probe of a live agent at BASE_URL. Checks agent
#               existence, lifecycle status, and key prefix presence without
#               rotating anything or writing any secret.
#
#   --probe --rotate
#               Full rotation probe against a live BASE_URL. Actually rotates
#               the target agent's API key, verifies old key fails and new key
#               works, revokes, re-activates. Requires ALLOW_REMOTE_VERIFY=1
#               and ALLOW_CREDENTIAL_ROTATION=1.
#
# SECURITY CONTRACTS (always enforced):
#   - Full API keys and Bearer tokens are NEVER printed to stdout/stderr.
#   - All credential displays use a redacted prefix (first 12 chars + "...").
#   - Sensitive values are never written to files on disk.
#   - The script exits 2 (BLOCKED) when required env vars are missing.
#   - Non-localhost targets require explicit opt-in (ALLOW_REMOTE_VERIFY=1).
#   - Rotation against production requires ALLOW_CREDENTIAL_ROTATION=1 as well.
#
# Usage:
#   bash backend/scripts/credential-rotation-proof.sh                              # local SQLite
#   bash backend/scripts/credential-rotation-proof.sh --probe                       # read-only probe
#   bash backend/scripts/credential-rotation-proof.sh --probe --rotate              # full rotation probe
#
# Required env for --probe / --rotate modes:
#   BASE_URL=<url>
#   PROBE_PROJECT_ID=<uuid>           # Project containing the target agent
#   PROBE_AGENT_ID=<uuid>             # Agent to probe
#   PROBE_OPERATOR_JWT=<jwt>          # JWT for a user with EditAgent on the project
#
# Additional required env for --rotate mode:
#   PROBE_AGENT_CURRENT_KEY=<key>     # The agent's current API key (for before/after verify)
#
# Required opt-in for non-localhost targets:
#   ALLOW_REMOTE_VERIFY=1
#
# Required opt-in for rotation (--rotate):
#   ALLOW_CREDENTIAL_ROTATION=1
#
# Exit codes:
#   0  All checks passed
#   1  One or more proof checks failed
#   2  BLOCKED — required env vars missing or configuration error
#   3  BLOCKED — probe target not reachable, agent/project not found
#
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly DEPLOY_DIR="$(cd "$BACKEND_DIR/../deploy" && pwd)"

PASS=0
FAIL=0
BLOCKED=0

E_OK=0
E_PROOF_FAIL=1
E_BLOCKED_ENV=2
E_BLOCKED_TARGET=3

# ---- config ----------------------------------------------------------------
MODE="local"
DO_ROTATE=false
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ALLOW_REMOTE_VERIFY="${ALLOW_REMOTE_VERIFY:-0}"
ALLOW_CREDENTIAL_ROTATION="${ALLOW_CREDENTIAL_ROTATION:-0}"

# ---- helpers ---------------------------------------------------------------

pass() { PASS=$((PASS+1)); echo "  PASS: $*"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }
blocked() { BLOCKED=$((BLOCKED+1)); echo "  BLOCKED: $*"; }

log()  { printf '[rotation-proof] %s\n' "$*"; }
err()  { printf '[rotation-proof][ERROR] %s\n' "$*" >&2; }

# Redact a sensitive string, keeping only the first N chars.
redact() {
  local val="$1"
  local keep="${2:-12}"
  if [[ ${#val} -le "$keep" ]]; then
    echo "${val:0:$keep}"
  else
    echo "${val:0:$keep}..."
  fi
}

# Safely display a redacted version of a key/token for logging.
safe_val() {
  local label="$1"
  local val="$2"
  echo "${label}=$(redact "$val")"
}

# Extract a value from JSON piping through node.
json_get() {
  node -e '
    const path = process.argv[1].split(".");
    let value = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const key of path) value = value && value[key];
    if (value === undefined || value === null) process.exit(2);
    if (typeof value === "object") process.stdout.write(JSON.stringify(value));
    else process.stdout.write(String(value));
  ' "$1"
}

# Assert that a value equals expected.
assert_eq() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$label: expected '$expected', got '$actual'"
    return 1
  fi
  pass "$label: $actual"
}

# Test that a condition is truthy.
assert_true() {
  local label="$1"
  local val="$2"
  if [[ "$val" == "true" ]] || [[ "$val" == "1" ]]; then
    pass "$label"
  else
    fail "$label: expected truthy value, got '$val'"
    return 1
  fi
}

# Assert a string is non-empty.
assert_nonempty() {
  local label="$1"
  local val="$2"
  if [[ -z "$val" ]]; then
    fail "$label: expected non-empty value, got empty"
    return 1
  fi
  pass "$label: $(redact "$val")"
}

# Assert HTTP status code matches.
assert_http_status() {
  local label="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$label: expected HTTP $expected, got HTTP $actual"
    return 1
  fi
  pass "$label: HTTP $actual"
}

# Perform an HTTP request using curl. Accepts JWT auth or API key auth.
# Usage: request <method> <path> [body] [jwt|api_key]
# Result globals (set in THIS shell so callers see them — no subshell loss):
#   REPLY_STATUS  HTTP status code, or "000" on transport-level failure.
#   REPLY_BODY    Response body. NEVER written to disk (rotate responses
#                 contain the full new API key, so they must stay in memory).
# Prints nothing to stdout.
request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local auth="${4:-}"

  # Base args are always present so the array is never empty — bash 3.2 (macOS
  # default) errors on "${arr[@]}" for an empty array under `set -u`, so we
  # append the optional auth header conditionally instead of using a separate
  # (possibly-empty) auth array. An earlier version initialized auth_header=""
  # and expanded "${auth_header[@]}", which emitted a stray empty curl argument
  # on unauthenticated requests (e.g. /v1/health) and broke probing.
  local curl_args=(-sS -X "$method" "${BASE_URL%/}$path" \
    -H "Content-Type: application/json" -w $'\n''%{http_code}')

  if [[ -n "$auth" ]]; then
    if [[ "$auth" == zzk_* ]]; then
      curl_args+=(-H "X-API-Key: $auth")
    else
      curl_args+=(-H "Authorization: Bearer $auth")
    fi
  fi

  if [[ -n "$body" ]]; then
    curl_args+=(-d "$body")
  fi

  # No -f: we must capture the body AND status of 4xx/5xx responses (the 401s
  # we assert on). curl exits non-zero only on transport failure (connection
  # refused / DNS / timeout); in that case no http_code line is produced.
  # No temp file is used: bodies may contain secrets, so they are captured on
  # stdout only. The status code is appended as a final line via -w; the body
  # may itself contain newlines, so we split on the FINAL newline only.
  local raw rc=0
  raw=$(curl "${curl_args[@]}" 2>/dev/null) || rc=$?

  if [[ $rc -ne 0 && -z "$raw" ]]; then
    REPLY_STATUS="000"
    REPLY_BODY=""
    return 0
  fi

  REPLY_STATUS="${raw##*$'\n'}"
  REPLY_BODY="${raw%$'\n'*}"

  # Guard against partial output with no parseable trailing status line.
  if ! [[ "$REPLY_STATUS" =~ ^[0-9]{3}$ ]]; then
    REPLY_STATUS="000"
    REPLY_BODY=""
  fi
  return 0
}

# Perform a request and expose status+body via REPLY_STATUS / REPLY_BODY.
request_json() {
  request "$@"
}

is_local_base_url() {
  local host=""
  [[ "$BASE_URL" =~ ^https?://(\[::1\]|[^/:]+) ]] || return 1
  host="${BASH_REMATCH[1]}"
  [[ "$host" =~ ^127\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || \
  [[ "$host" == "localhost" ]] || \
  [[ "$host" == "::1" ]] || \
  [[ "$host" == "[::1]" ]]
}

require_remote_opt_in() {
  if is_local_base_url; then
    return 0
  fi
  if [[ "$ALLOW_REMOTE_VERIFY" == "1" ]]; then
    return 0
  fi
  blocked "Non-localhost BASE_URL ($BASE_URL) requires ALLOW_REMOTE_VERIFY=1"
  return 1
}

require_rotation_opt_in() {
  if [[ "$ALLOW_CREDENTIAL_ROTATION" == "1" ]]; then
    return 0
  fi
  blocked "Rotation probe requires ALLOW_CREDENTIAL_ROTATION=1 (this is a destructive operation)"
  return 1
}

usage() {
  awk 'NR==1{next} /^#/{sub(/^#[[:space:]]?/, ""); print; next} /^[a-zA-Z]/ {exit}' "$0"
  exit "${1:-0}"
}

# ---- arg parse -------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --probe)    MODE="probe"; shift ;;
    --rotate)   DO_ROTATE=true; shift ;;
    --local)    MODE="local"; shift ;;
    -h|--help)  usage 0 ;;
    *) err "unknown argument: $1"; usage 1 ;;
  esac
done

if [[ "$DO_ROTATE" == "true" && "$MODE" != "probe" ]]; then
  err "--rotate is only meaningful with --probe"
  usage 1
fi

echo "========================================"
echo "  Credential Rotation Proof — Gap #6"
echo "  Mode: $MODE"
if [[ "$MODE" == "probe" ]]; then
  echo "  BASE_URL: $BASE_URL"
  echo "  Rotation: $DO_ROTATE"
fi
echo "========================================"
echo ""

# ============================================================================
# LOCAL MODE — run existing credential-lifecycle test against SQLite
# ============================================================================
if [[ "$MODE" == "local" ]]; then
  log "Running local credential-lifecycle test against in-memory SQLite"

  cd "$BACKEND_DIR" || { err "backend dir not found: $BACKEND_DIR"; exit "$E_BLOCKED_TARGET"; }

  log "building backend (npm run build)"
  if ! npm run build 2>&1 | tail -5; then
    err "build failed"
    exit "$E_PROOF_FAIL"
  fi
  pass "backend build"

  log "running credential-lifecycle.test.js"
  if NODE_ENV=test node dist/tests/credential-lifecycle.test.js 2>&1; then
    pass "credential-lifecycle test passed"
  else
    fail "credential-lifecycle test failed"
  fi

  echo ""
  echo "========================================"
  echo "  Local proof: $PASS passed, $FAIL failed"
  echo "========================================"
  echo ""
  echo "SCOPE: local mode runs the in-process credential-lifecycle test"
  echo "(SQLite) ONLY. No live, staging, or production target was contacted,"
  echo "and no real key was rotated/revoked. This does NOT prove production"
  echo "rotation. For a live/staging proof run '--probe' (read-only) or"
  echo "'--probe --rotate' (destructive) against a real BASE_URL."
  exit $(( FAIL > 0 ? E_PROOF_FAIL : E_OK ))
fi

# ============================================================================
# PROBE MODE — validate against live target
# ============================================================================

# -- Validate required env ---------------------------------------------------
ERR_ENV=0

if [[ -z "${BASE_URL:-}" ]]; then
  err "BASE_URL is required in --probe mode"
  ERR_ENV=1
fi
if [[ -z "${PROBE_PROJECT_ID:-}" ]]; then
  err "PROBE_PROJECT_ID is required in --probe mode"
  ERR_ENV=1
fi
if [[ -z "${PROBE_AGENT_ID:-}" ]]; then
  err "PROBE_AGENT_ID is required in --probe mode"
  ERR_ENV=1
fi
if [[ -z "${PROBE_OPERATOR_JWT:-}" ]]; then
  err "PROBE_OPERATOR_JWT is required in --probe mode"
  ERR_ENV=1
fi
if [[ "$DO_ROTATE" == "true" && -z "${PROBE_AGENT_CURRENT_KEY:-}" ]]; then
  err "PROBE_AGENT_CURRENT_KEY is required in --rotate mode"
  ERR_ENV=1
fi

if [[ "$ERR_ENV" -ne 0 ]]; then
  err "Required env vars missing. Exiting BLOCKED."
  exit "$E_BLOCKED_ENV"
fi

# Check remote opt-in
if ! require_remote_opt_in; then
  exit "$E_BLOCKED_ENV"
fi

# Check rotation opt-in if needed
if [[ "$DO_ROTATE" == "true" ]] && ! require_rotation_opt_in; then
  exit "$E_BLOCKED_ENV"
fi

# -- Helper: redact-sensitive JSON from CURL response into a log-safe string
redacted_body() {
  # Strip known sensitive fields from response JSON for safe display
  node -e '
    try {
      const body = JSON.parse(process.argv[1]);
      if (body.access_token) body.access_token = body.access_token.substring(0,12) + "...";
      if (body.api_key) body.api_key = body.api_key.substring(0,12) + "...";
      if (body.detail) body.detail = body.detail;
      console.log(JSON.stringify(body, null, 2));
    } catch {
      console.log(process.argv[1]);
    }
  ' "$REPLY_BODY"
}

# -- Step 0: Health check ----------------------------------------------------
echo "--- [gate 0] Target reachability ---"
request_json GET /v1/health ""
if [[ "$REPLY_STATUS" == "000" ]]; then
  blocked "Target unreachable: $BASE_URL/v1/health"
  exit "$E_BLOCKED_TARGET"
fi
assert_http_status "health endpoint" "$REPLY_STATUS" "200" || {
  blocked "Target not healthy at $BASE_URL"
  exit "$E_BLOCKED_TARGET"
}

# -- Step 1: Verify agent exists and is active --------------------------------
echo ""
echo "--- [gate 1] Agent existence and lifecycle ---"
request_json GET "/v1/agents/${PROBE_AGENT_ID}" "" "$PROBE_OPERATOR_JWT"
if [[ "$REPLY_STATUS" == "404" ]]; then
  blocked "Agent $PROBE_AGENT_ID not found at $BASE_URL"
  exit "$E_BLOCKED_TARGET"
fi
if [[ "$REPLY_STATUS" == "403" ]]; then
  blocked "Operator JWT lacks ViewProject permission for agent $PROBE_AGENT_ID"
  exit "$E_BLOCKED_TARGET"
fi

GATE1_OK=true
assert_http_status "agent fetch" "$REPLY_STATUS" "200" || GATE1_OK=false

if [[ "$GATE1_OK" == "true" ]]; then
  PROBE_AGENT_LIFECYCLE=$(echo "$REPLY_BODY" | json_get lifecycle_status 2>/dev/null || echo "unknown")
  PROBE_AGENT_STATUS=$(echo "$REPLY_BODY" | json_get status 2>/dev/null || echo "unknown")
  PROBE_AGENT_KEY_PREFIX=$(echo "$REPLY_BODY" | json_get api_key_prefix 2>/dev/null || echo "null")
  PROBE_AGENT_NAME=$(echo "$REPLY_BODY" | json_get name 2>/dev/null || echo "unknown")
  PROBE_AGENT_PROJECT_ID=$(echo "$REPLY_BODY" | json_get project_id 2>/dev/null || echo "")

  pass "agent name: $PROBE_AGENT_NAME"
  assert_eq "agent lifecycle_status" "$PROBE_AGENT_LIFECYCLE" "active" || GATE1_OK=false
  assert_eq "agent status" "$PROBE_AGENT_STATUS" "active" || GATE1_OK=false
  assert_nonempty "agent api_key_prefix" "$PROBE_AGENT_KEY_PREFIX" || GATE1_OK=false

  # Verify the agent belongs to the specified project
  if [[ -n "$PROBE_AGENT_PROJECT_ID" ]]; then
    assert_eq "agent project_id" "$PROBE_AGENT_PROJECT_ID" "$PROBE_PROJECT_ID" || GATE1_OK=false
  fi
fi

# -- Step 2: Verify project exists and is accessible --------------------------
echo ""
echo "--- [gate 2] Project access ---"
request_json GET "/v1/projects/${PROBE_PROJECT_ID}" "" "$PROBE_OPERATOR_JWT"
if [[ "$REPLY_STATUS" == "404" ]]; then
  blocked "Project $PROBE_PROJECT_ID not found at $BASE_URL"
  exit "$E_BLOCKED_TARGET"
fi
assert_http_status "project fetch" "$REPLY_STATUS" "200" || GATE1_OK=false

# Record probe evidence
echo ""
echo "--- [evidence] Pre-probe state ---"
echo "  agent_name: $PROBE_AGENT_NAME"
echo "  agent_id: ${PROBE_AGENT_ID:0:8}..."
echo "  lifecycle_status: $PROBE_AGENT_LIFECYCLE"
echo "  status: $PROBE_AGENT_STATUS"
echo "  api_key_prefix: ${PROBE_AGENT_KEY_PREFIX:0:12}"
echo "  project_id: ${PROBE_PROJECT_ID:0:8}..."
echo "  target: $BASE_URL"
echo ""

# If this is read-only probe, summarise and exit
if [[ "$DO_ROTATE" != "true" ]]; then
  echo "--- Read-only probe complete ---"
  echo ""
  echo "SCOPE: read-only probe verified reachability, agent/project existence,"
  echo "and lifecycle status at $BASE_URL. It performed NO rotation, revoke, or"
  echo "key mutation against ANY target, so it does NOT prove real production"
  echo "rotation. The rotation/revoke/reactivate policy notes below describe"
  echo "the code path; they were NOT exercised here. To exercise them against"
  echo "$BASE_URL run '--probe --rotate' with ALLOW_CREDENTIAL_ROTATION=1."
  echo ""
  echo "Dual-key window evidence:  N/A (read-only mode — no rotation performed)"
  echo "  To verify, run: --probe --rotate"
  echo ""
  echo "Revocation propagation:    N/A (read-only mode — no rotation performed)"
  echo ""
  echo "Retire/supersede denial:  Agent is active (lifecycle_status=$PROBE_AGENT_LIFECYCLE, status=$PROBE_AGENT_STATUS)"
  echo "  Retired/superseded agents return 401 via auth middleware filtering"
  echo ""
  echo "Rotation policy evidence:"
  echo "  Auth middleware provides immediate key invalidation — no grace/window period."
  echo "  Rotate replaces bcrypt hash in DB; old key never re-matched."
  echo "  Revoke nullifies api_key_hash; agent requires re-rotate to activate."
  echo "  Retire/Supersede sets status=INACTIVE; auth middleware filters"
  echo "  by status+lifecycle before bcrypt comparison."
  echo "  Agent key prefix rotation: new prefix generated on each rotate."
  echo "  See: backend/src/routes/agents.routes.ts (rotate-key, revoke-key)"
  echo "  See: backend/src/middleware/auth.ts (authenticateAgentApiKey)"
  echo ""

  if [[ "$GATE1_OK" == "true" ]]; then
    pass "Read-only probe completed — all gates OK"
    echo ""
    echo "========================================"
    echo "  Probe result: $PASS passed, $FAIL failed"
    echo "========================================"
    exit "$E_OK"
  else
    echo ""
    echo "========================================"
    echo "  Probe result: $PASS passed, $FAIL failed"
    echo "========================================"
    exit "$E_PROOF_FAIL"
  fi
fi

# ============================================================================
# ROTATION PROBE MODE
# ============================================================================

echo "=== ROTATION PROBE (ALLOW_CREDENTIAL_ROTATION=1) ==="
echo ""
echo "WARNING: This will rotate the production agent's API key."
echo "The old key will immediately stop working."
echo "The operator is responsible for distributing the new key."
echo ""

# -- Step 3: Verify current key works before rotation -------------------------
echo "--- [gate 3] Current key works before rotation ---"

request_json GET "/v1/projects/${PROBE_PROJECT_ID}/agents/${PROBE_AGENT_ID}" "" "$PROBE_AGENT_CURRENT_KEY"
if [[ "$REPLY_STATUS" == "401" ]]; then
  blocked "Current API key does not work against agent $PROBE_AGENT_ID"
  blocked "Check PROBE_AGENT_CURRENT_KEY. Agent: ${PROBE_AGENT_ID:0:8}..."
  exit "$E_BLOCKED_TARGET"
fi
assert_http_status "current key works for agent profile" "$REPLY_STATUS" "200"
request POST /v1/agents/heartbeat '{"status":"active"}' "$PROBE_AGENT_CURRENT_KEY"
BEFORE_HEARTBEAT_STATUS="$REPLY_STATUS"
assert_http_status "current key works for heartbeat" "$BEFORE_HEARTBEAT_STATUS" "200"
PASS_COUNT_BEFORE=$PASS

KEY_AFTER_ROTATE=""
OLD_KEY_AFTER_ROTATE="$PROBE_AGENT_CURRENT_KEY"

# -- Step 4: Rotate key -------------------------------------------------------
echo ""
echo "--- [gate 4] Rotate key ---"
request_json POST "/v1/projects/${PROBE_PROJECT_ID}/agents/${PROBE_AGENT_ID}/rotate-key" "" "$PROBE_OPERATOR_JWT"

# DESTRUCTIVE POINT: once the rotate request returns, the server may already
# have replaced the agent's key. From here through re-activation (gate 7) we
# MUST NOT abort on an assertion or parse error — otherwise the agent is left
# mid-rotation with an unknown key and no recovery. Disable errexit; every
# step records its own pass/fail, and gate 7 always attempts a fresh rotate
# to leave the agent usable. The final exit code reflects any failures.
set +e
assert_http_status "rotate key" "$REPLY_STATUS" "200"

if [[ "$REPLY_STATUS" == "200" ]]; then
  KEY_AFTER_ROTATE=$(echo "$REPLY_BODY" | json_get api_key 2>/dev/null || echo "")

  if [[ -z "$KEY_AFTER_ROTATE" ]]; then
    fail "rotate response did not contain api_key"
  else
    assert_string="new key starts with zzk_"
    if [[ "$KEY_AFTER_ROTATE" == zzk_* ]]; then
      pass "$assert_string"
    else
      fail "$assert_string: got $(redact "$KEY_AFTER_ROTATE")"
    fi

    # Parse the prefix from the rotate RESPONSE BODY (JSON), not from the raw
    # key string. The key is not JSON, so the prior `echo "$KEY_AFTER_ROTATE"
    # | json_get api_key_prefix` always failed and — under `set -e` — could
    # abort right after the destructive rotate.
    NEW_PREFIX=$(echo "$REPLY_BODY" | json_get api_key_prefix 2>/dev/null || echo "")
    assert_nonempty "new api_key_prefix" "$NEW_PREFIX"

    NEW_AGENT_ID=$(echo "$REPLY_BODY" | json_get id 2>/dev/null || echo "")
    assert_eq "rotate returns agent id" "$NEW_AGENT_ID" "$PROBE_AGENT_ID"

    log "new key $(safe_val "prefix" "${KEY_AFTER_ROTATE:0:12}")"
  fi
fi

# -- Step 5: Dual-key window check --------------------------------------------
echo ""
echo "--- [gate 5] Dual-key window verification ---"
echo "  Objective: Verify old key is immediately rejected after rotation"
echo "  (no grace/window period where both keys work)"
echo ""

DUAL_KEY_OK=false
if [[ -n "$KEY_AFTER_ROTATE" ]]; then
  DUAL_KEY_OK=true
  # Old key must fail
  request GET "/v1/projects/${PROBE_PROJECT_ID}/agents/${PROBE_AGENT_ID}" "" "$OLD_KEY_AFTER_ROTATE"
  OLD_PROFILE_STATUS="$REPLY_STATUS"
  assert_http_status "old key denied after rotate (profile)" "$OLD_PROFILE_STATUS" "401" || DUAL_KEY_OK=false

  request POST /v1/agents/heartbeat '{"status":"active"}' "$OLD_KEY_AFTER_ROTATE"
  OLD_HB_STATUS="$REPLY_STATUS"
  assert_http_status "old key denied after rotate (heartbeat)" "$OLD_HB_STATUS" "401" || DUAL_KEY_OK=false

  # New key must work
  request GET "/v1/projects/${PROBE_PROJECT_ID}/agents/${PROBE_AGENT_ID}" "" "$KEY_AFTER_ROTATE"
  NEW_PROFILE_STATUS="$REPLY_STATUS"
  assert_http_status "new key works after rotate (profile)" "$NEW_PROFILE_STATUS" "200" || DUAL_KEY_OK=false

  request POST /v1/agents/heartbeat '{"status":"active"}' "$KEY_AFTER_ROTATE"
  NEW_HB_STATUS="$REPLY_STATUS"
  assert_http_status "new key works after rotate (heartbeat)" "$NEW_HB_STATUS" "200" || DUAL_KEY_OK=false

  if [[ "$DUAL_KEY_OK" == "true" ]]; then
    pass "Dual-key window: NO grace period — old key immediately rejected, new key immediately accepted"
  fi
else
  fail "Dual-key window check skipped — no new key available"
fi

# -- Step 6: Revoke key -------------------------------------------------------
echo ""
echo "--- [gate 6] Revoke key ---"

REVOKE_OK=false
if [[ -n "$KEY_AFTER_ROTATE" ]]; then
  request_json POST "/v1/projects/${PROBE_PROJECT_ID}/agents/${PROBE_AGENT_ID}/revoke-key" "" "$PROBE_OPERATOR_JWT"
  assert_http_status "revoke key" "$REPLY_STATUS" "200"

  if [[ "$REPLY_STATUS" == "200" ]]; then
    REVOKE_OK=true
    # Verify revoked key fails
    request GET "/v1/projects/${PROBE_PROJECT_ID}/agents/${PROBE_AGENT_ID}" "" "$KEY_AFTER_ROTATE"
    REVOKED_PROFILE_STATUS="$REPLY_STATUS"
    assert_http_status "revoked key denied (profile)" "$REVOKED_PROFILE_STATUS" "401" || REVOKE_OK=false

    request POST /v1/agents/heartbeat '{"status":"active"}' "$KEY_AFTER_ROTATE"
    REVOKED_HB_STATUS="$REPLY_STATUS"
    assert_http_status "revoked key denied (heartbeat)" "$REVOKED_HB_STATUS" "401" || REVOKE_OK=false

    if [[ "$REVOKE_OK" == "true" ]]; then
      pass "Revocation propagation: immediate — no lingering key access after revoke"
    fi
  fi
else
  fail "Revoke check skipped — no new key available"
fi

# -- Step 7: Re-activate by rotating ------------------------------------------
echo ""
echo "--- [gate 7] Re-activation (rotate after revoke) ---"

request_json POST "/v1/projects/${PROBE_PROJECT_ID}/agents/${PROBE_AGENT_ID}/rotate-key" "" "$PROBE_OPERATOR_JWT"
assert_http_status "rotate after revoke" "$REPLY_STATUS" "200"

if [[ "$REPLY_STATUS" == "200" ]]; then
  KEY_REACTIVATED=$(echo "$REPLY_BODY" | json_get api_key 2>/dev/null || echo "")
  if [[ -n "$KEY_REACTIVATED" ]]; then
    request GET "/v1/projects/${PROBE_PROJECT_ID}/agents/${PROBE_AGENT_ID}" "" "$KEY_REACTIVATED"
    REACTIVATED_STATUS="$REPLY_STATUS"
    assert_http_status "reactivated key works" "$REACTIVATED_STATUS" "200"
    pass "Agent re-activated after revoke via rotate"

    log "new key after reactivation $(safe_val "prefix" "${KEY_REACTIVATED:0:12}")"
  else
    fail "Re-activation response did not contain api_key"
  fi
fi

# -- Step 8: Rotation policy evidence summary ---------------------------------
echo ""
echo "--- [gate 8] Rotation policy and schedule evidence ---"
echo ""
echo "  Rotation mechanism:"
echo "    - POST /v1/projects/:pid/agents/:aid/rotate-key"
echo "    - Generates new uuid-based key with fresh prefix"
echo "    - Stores bcrypt hash in api_key_hash column"
echo "    - Updates api_key_prefix for efficient lookup"
echo "    - Old key immediately denied (no dual-key window)"
echo ""
echo "  Revocation mechanism:"
echo "    - POST /v1/projects/:pid/agents/:aid/revoke-key"
echo "    - Nullifies api_key_hash and api_key_prefix"
echo "    - Old key immediately denied (bcrypt comparison cannot match null)"
echo "    - Agent requires rotate-key to re-activate"
echo ""
echo "  Retire/Supersede mechanism:"
echo "    - POST /v1/agents/:aid/retire"
echo "    - Sets lifecycle_status=retired|superseded, status=inactive"
echo "    - Auth middleware filters retired/superseded agents before bcrypt check"
echo "    - Denial is immediate and permanent unless reactivated via DB"
echo ""
echo "  Auth middleware flow (backend/src/middleware/auth.ts):"
echo "    1. Lookup agents matching api_key_prefix (efficient index scan)"
echo "    2. Filter: status != INACTIVE AND lifecycle NOT IN (RETIRED, SUPERSEDED)"
echo "    3. bcrypt.compare(api_key, apiKeyHash)"
echo "    4. On match: authenticate; on miss: 401"
echo ""
if [[ "${DUAL_KEY_OK:-false}" == "true" ]]; then
  echo "  Dual-key window: NONE (confirmed by gate 5 against $BASE_URL)"
else
  echo "  Dual-key window: NOT confirmed (gate 5 checks failed or were skipped)"
fi
echo ""
if [[ "${REVOKE_OK:-false}" == "true" ]]; then
  echo "  Revocation propagation: IMMEDIATE (confirmed by gate 6 against $BASE_URL)"
else
  echo "  Revocation propagation: NOT confirmed (gate 6 checks failed or were skipped)"
fi
echo ""

# -- Final cleanup: none needed — secret data stays in memory only -------------
echo "--- Cleanup ---"
log "No secrets written to disk; all sensitive data remains in memory only."
log "If the agent was rotated, distribute the new key to operators:"
if [[ -n "${KEY_REACTIVATED:-}" ]]; then
  log "  Agent ${PROBE_AGENT_ID:0:8}... new key prefix: ${KEY_REACTIVATED:0:12}..."
elif [[ -n "${KEY_AFTER_ROTATE:-}" ]]; then
  log "  Agent ${PROBE_AGENT_ID:0:8}... new key prefix: ${KEY_AFTER_ROTATE:0:12}..."
fi

echo ""
echo "========================================"
echo "  Probe result: $PASS passed, $FAIL failed"
echo "  Read-only probe: $([[ "$DO_ROTATE" == "true" ]] && echo "no" || echo "yes")"
echo "  Rotation performed: $DO_ROTATE"
echo "========================================"

if [[ "$FAIL" -gt 0 ]]; then
  exit "$E_PROOF_FAIL"
fi
exit "$E_OK"
