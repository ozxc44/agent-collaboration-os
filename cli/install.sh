#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Agent Platform Bootstrap Script (cross-platform: macOS / Linux / Windows-WSL)
# Downloads, installs, and starts the executor daemon.
# Any agent can run this to connect to the platform and start working.
# ═══════════════════════════════════════════════════════════════════════════
set -e

PLATFORM=$(uname -s)
ARCH=$(uname -m)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🤖 Agent Platform Bootstrap"
echo "   OS: $PLATFORM $ARCH"
echo ""

# ── Config ──
DEFAULT_BASE_URL="http://<your-platform-host>:18080/agent"
BASE_URL="${ZZ_BASE_URL:-$DEFAULT_BASE_URL}"

# ── Check for agent key ──
AGENT_KEY="${ZZ_AGENT_KEY:-}"
if [ -z "$AGENT_KEY" ]; then
    # Try identity files
    if [ "$PLATFORM" = "Darwin" ]; then
        IDENTITY_FILE="$HOME/Library/Application Support/Agent Platform/identity.json"
    else
        IDENTITY_FILE="$HOME/.config/agent-platform/identity.json"
    fi
    if [ -f "$IDENTITY_FILE" ]; then
        AGENT_KEY=$(python3 -c "import json;print(json.load(open('$IDENTITY_FILE')).get('credentials',{}).get('agent_key',''))" 2>/dev/null || echo "")
    fi
fi

if [ -z "$AGENT_KEY" ]; then
    echo "❌ No agent key found."
    echo "   Set ZZ_AGENT_KEY, or bootstrap via agent-start.html first."
    echo "   Example: ZZ_AGENT_KEY=zzk_xxx $0"
    exit 1
fi

echo "✅ Agent key found (${AGENT_KEY:0:8}...)"
echo "   Platform: $BASE_URL"
echo ""

# ── Check Python 3 ──
if command -v python3 >/dev/null 2>&1; then
    PYTHON=python3
elif command -v python >/dev/null 2>&1; then
    PYTHON=python
else
    echo "❌ Python 3 not found. Install: https://python.org"
    exit 1
fi
echo "✅ Python: $($PYTHON --version 2>&1)"

# ── Download executor.py if not present ──
EXECUTOR_FILE="$SCRIPT_DIR/executor.py"
if [ ! -f "$EXECUTOR_FILE" ]; then
    echo "📥 Downloading executor.py..."
    # Correct bootstrap endpoint
    EXECUTOR_URL="${BASE_URL}/v1/agent/bootstrap/executor.py"
    if curl -sLf "$EXECUTOR_URL" -o "$EXECUTOR_FILE" 2>/dev/null; then
        echo "   ✅ Downloaded from platform"
    elif curl -sLf "${BASE_URL%/*}/v1/agent/bootstrap/executor.py" -o "$EXECUTOR_FILE" 2>/dev/null; then
        echo "   ✅ Downloaded (alt path)"
    else
        echo "   ⚠ Could not download. Checking bundled copy..."
        for p in "$SCRIPT_DIR/cli/zz_cli/executor.py" "$HOME/.zz/executor.py"; do
            if [ -f "$p" ]; then
                cp "$p" "$EXECUTOR_FILE"
                echo "   ✅ Found at $p"
                break
            fi
        done
    fi
fi

if [ ! -f "$EXECUTOR_FILE" ]; then
    echo "❌ executor.py not found. Install zz CLI first or download manually."
    exit 1
fi

echo "✅ Executor ready: $EXECUTOR_FILE"
echo ""

# ── Verify connection ──
echo "🔌 Testing connection..."
HB=$($PYTHON -c "
import json, urllib.request
req = urllib.request.Request('${BASE_URL}/v1/agents/heartbeat', data=b'{}', method='POST')
req.add_header('Content-Type','application/json')
req.add_header('X-API-Key','$AGENT_KEY')
try:
    resp = urllib.request.urlopen(req, timeout=10)
    d = json.loads(resp.read())
    print(json.dumps({'ok':True, 'presence':d.get('presence'), 'pending':d.get('pending_inbox_count',0)}))
except Exception as e:
    print(json.dumps({'ok':False, 'error':str(e)}))
" 2>/dev/null)

if echo "$HB" | grep -q '"ok": true'; then
    PRESENCE=$(echo "$HB" | $PYTHON -c "import sys,json;print(json.load(sys.stdin).get('presence',''))" 2>/dev/null)
    PENDING=$(echo "$HB" | $PYTHON -c "import sys,json;print(json.load(sys.stdin).get('pending',0))" 2>/dev/null)
    echo "   ✅ Connected! Presence: $PRESENCE, Pending: $PENDING"
else
    echo "   ❌ Connection failed: $HB"
    exit 1
fi

echo ""

# ── Start executor daemon ──
HANDLER="${HANDLER_CMD:-}"
MODE="${EXECUTOR_MODE:-full}"  # full / pm-only / worker-only

# Relay-first: an agent's own brain is reached via endpoint_url, --handler, or
# --manual. The daemon does NOT call an LLM in the main path (agents are LLMs).
# Only use --headless for a registered identity that has no model of its own.
HEADLESS=""
if [ "${EXECUTOR_HEADLESS:-0}" = "1" ]; then HEADLESS="--headless"; fi

echo "🚀 Starting executor daemon..."
echo "   Mode: $MODE"
echo "   Handler: ${HANDLER:-(none)}"
echo "   Endpoint: (from agent profile, or set via dashboard)"
if [ -n "$HEADLESS" ]; then
    echo "   Headless: ON (built-in LLM fallback — only for nodes with no brain)"
else
    echo "   Headless: off (relay to the agent's own brain via endpoint/handler/manual)"
fi
echo "   Interval: ${EXECUTOR_INTERVAL:-30}s"
echo ""
echo "   ℹ Without endpoint/handler/manual, the daemon only SURFACES tasks."
echo "   ℹ No LLM key is required — the agent's own runtime does the work."
echo ""

MODE_FLAG=""
if [ "$MODE" = "pm-only" ]; then MODE_FLAG="--pm-only"; fi
if [ "$MODE" = "worker-only" ]; then MODE_FLAG="--worker-only"; fi

exec $PYTHON "$EXECUTOR_FILE" \
    --base-url "$BASE_URL" \
    --api-key "$AGENT_KEY" \
    --interval "${EXECUTOR_INTERVAL:-30}" \
    ${HANDLER:+--handler "$HANDLER"} \
    $HEADLESS \
    $MODE_FLAG
