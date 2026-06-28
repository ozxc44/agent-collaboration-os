#!/usr/bin/env python3
"""
Agent Runtime — the unified local-model runtime for the Agent Collaboration OS.

This ONE script does what previously took three (invoke_server.py + invoke_handler.py
+ executor.py wiring) and adds the missing pieces: per-agent model routing,
on-demand instantiation, and warm-instance caching.

══════════════════════════════════════════════════════════════════════════════
WHY THIS EXISTS
══════════════════════════════════════════════════════════════════════════════
A host runs MANY local models (kimi, mimo, codex, zcode, deepseek-API, ...).
Each can serve one or more agents. Previously each agent had to wire its own
invoke server + handler, and getting the routing right (which model for which
agent_id) was manual and error-prone — tasks ended up at the wrong terminal.

This runtime fixes that: ONE process serves ALL agents on a host. It maps
agent_id -> model backend (via agents.json), instantiates the right model
on demand, caches warm instances, and routes invokes accurately.

══════════════════════════════════════════════════════════════════════════════
ARCHITECTURE
══════════════════════════════════════════════════════════════════════════════
                        ┌──────────────── runtime.py ────────────────┐
  platform invoke ──►   │  HTTP /zz/v1/invoke (multi-agent router)   │
  (X-ZZ-Agent-Id)       │     │                                       │
                        │     ▼ agent_id → backend (agents.json)     │
                        │   ┌─────────────────────────────────┐      │
                        │   │ Model Registry (warm cache)      │      │
                        │   │  kimi-cli  (kimi -p, warm)        │      │
                        │   │  mimo-cli  (mimo run, warm)       │      │
                        │   │  codex-cli (codex exec)           │      │
                        │   │  api       (deepseek/GLM/...)     │      │
                        │   └─────────────────────────────────┘      │
                        │     │ reply text                            │
                        │     ▼                                       │
  reply ◄─────────────  │  runtime.v1 response                       │
                        └────────────────────────────────────────────┘

Backend types supported:
  - cli:kimi   → /Users/z/.kimi-code/bin/kimi -p "<prompt>" --output-format text
  - cli:mimo   → /Users/z/.mimocode/bin/mimo run "<prompt>"
  - cli:codex  → codex exec "<prompt>"
  - api        → OpenAI-compatible chat/completions (deepseek, moonshot, GLM, ...)
                 configured via {api_base, api_key, model}
  - exec:<cmd> → arbitrary command receiving prompt, returning stdout
  - echo       → test mode (no model)

══════════════════════════════════════════════════════════════════════════════
ACCURATE ROUTING (avoid sending a task to the wrong terminal)
══════════════════════════════════════════════════════════════════════════════
Routing is keyed on X-ZZ-Agent-Id (the platform always sends it). agents.json
maps each agent to its backend:

  {
    "kimi-agent":     {"secret": "s1", "backend": "cli:kimi"},
    "mimocode-agent": {"secret": "s2", "backend": "cli:mimo"},
    "deepseek-worker":{"secret": "s3", "backend": "api",
                       "api_base": "https://api.deepseek.com",
                       "api_key": "sk-...", "model": "deepseek-chat"},
    "codex-agent":    {"secret": "s4", "backend": "cli:codex"}
  }

An unknown agent_id is REJECTED — a task can never reach the wrong terminal.

══════════════════════════════════════════════════════════════════════════════
ON-DEMAND INSTANTIATION + WARM CACHE
══════════════════════════════════════════════════════════════════════════════
CLI backends (kimi/mimo/codex) cold-start in seconds. To keep invokes fast,
this runtime keeps a warm process pool per backend (reused across invokes).
The api backend is stateless (just an HTTP call), no pool needed.

══════════════════════════════════════════════════════════════════════════════
USAGE
══════════════════════════════════════════════════════════════════════════════
  python3 runtime.py --port 7785 --agents-file agents.json
  python3 runtime.py --port 7785 --agents-file agents.json --install-launchd
  python3 runtime.py --port 7785 --backend echo          # single-agent test

Pure Python stdlib. No dependencies.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = 'runtime.v1'
LAUNCHD_LABEL = 'com.zz-agent.runtime'

# Default binary locations (override via env if different). Covers the local
# model CLIs discovered from PM skills (claude-code, hermes-agent, codex) plus
# the agent CLIs seen on this host (kimi, mimo).
DEFAULT_BINS = {
    'kimi': os.environ.get('KIMI_BIN', '/Users/z/.kimi-code/bin/kimi'),
    'mimo': os.environ.get('MIMO_BIN', '/Users/z/.mimocode/bin/mimo'),
    'codex': os.environ.get('CODEX_BIN', 'codex'),
    # Claude Code (Anthropic) — print mode: claude -p '<prompt>'. From the
    # claude-code skill: non-interactive, skips dialogs, ideal for automation.
    'claude': os.environ.get('CLAUDE_BIN', 'claude'),
    # Hermes Agent (Nous Research) — single query: hermes chat -q '<prompt>'.
    # Provider-agnostic; the same instance can serve many models.
    'hermes': os.environ.get('HERMES_BIN', 'hermes'),
    # OpenCode (skill-listed alternative coding agent).
    'opencode': os.environ.get('OPENCODE_BIN', 'opencode'),
}

# Per-kind CLI invocation. Each kind maps to (binary, argv_template) where the
# prompt is appended. Derived from the PM skills' verified commands.
CLI_INVOCATIONS = {
    'kimi':     lambda bin, p: [bin, '-p', p, '--output-format', 'text'],
    'mimo':     lambda bin, p: [bin, 'run', p],
    'codex':    lambda bin, p: [bin, 'exec', p],
    # Claude Code print mode — the skill's PREFERRED automation path. No PTY,
    # no interactive dialogs, returns result and exits.
    'claude':   lambda bin, p: [bin, '-p', p],
    # Hermes single-query mode.
    'hermes':   lambda bin, p: [bin, 'chat', '-q', p],
    'opencode': lambda bin, p: [bin, 'run', p],
}


# ═══════════════════════════════════════════════════════════════════════════
# HMAC signature verification (same as the platform's runtime.v1 contract)
# ═══════════════════════════════════════════════════════════════════════════

def verify_signature(secret, raw_body, headers):
    if not secret:
        return True
    sig_header = headers.get('X-ZZ-Signature', '')
    m = re.match(r'sha256=([0-9a-f]+)', sig_header)
    if not m:
        return False
    provided = m.group(1)
    timestamp = headers.get('X-ZZ-Timestamp', '')
    delivery_id = headers.get('X-ZZ-Delivery-Id', '')
    body_hash = hashlib.sha256(raw_body).hexdigest()
    signed_payload = f'{timestamp}.{delivery_id}.{body_hash}'
    expected = hmac.new(secret.encode(), signed_payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(provided, expected)


# ═══════════════════════════════════════════════════════════════════════════
# Prompt framing — a platform invoke is a SYNCHRONOUS acknowledgement ping,
# NOT a place to execute the full task (that would block for minutes).
# ═══════════════════════════════════════════════════════════════════════════

def extract_latest_message(req):
    msgs = req.get('recent_messages') or []
    for m in reversed(msgs):
        if m.get('sender_type') in ('user', 'system') or m.get('role') == 'user':
            content = m.get('content', '')
            if content:
                return content[:800]
    trigger = req.get('trigger') or {}
    if isinstance(trigger, dict) and trigger.get('content'):
        return str(trigger['content'])[:800]
    return '(no message content)'


def ack_prompt(latest):
    return (
        '# Read-only acknowledgement request\n'
        'A collaboration platform is pinging you to confirm you received a task.\n'
        'Reply with 1-3 sentences confirming receipt and that you will work on it.\n'
        'DO NOT use tools, DO NOT edit files, DO NOT run commands, DO NOT execute '
        'the task now. Just reply with text.\n\n'
        f'# The message you received\n{latest}\n\n'
        '# Your short text reply (confirm receipt):'
    )


def _clean(text):
    lines = []
    for line in text.splitlines():
        if line.startswith('To resume this session:') or line.startswith('To continue this session:'):
            continue
        lines.append(line)
    return '\n'.join(lines).strip()


# ═══════════════════════════════════════════════════════════════════════════
# Dependency declaration — the runtime NEVER silently installs anything.
# It declares what it needs, checks for it, and tells the user exactly how to
# install each dependency (with their explicit consent). No auto-install.
# ═══════════════════════════════════════════════════════════════════════════

# Each entry: what the runtime needs, why, and the install command (NOT run
# automatically — only printed for the user to run with consent).
DEPENDENCIES = {
    'tmux': {
        'why': 'Required for instance: backends (persistent agent instances in tmux sessions). '
               'Not needed if you only use cli: / api / echo backends.',
        'install': {
            'darwin': 'brew install tmux',
            'linux': 'sudo apt-get install -y tmux  # or: sudo dnf install -y tmux',
        },
        'optional': True,  # only needed for instance: backends
    },
}


def check_dependencies(verbose=True):
    """Check declared dependencies. Returns dict {name: {'installed': bool, 'why':, 'install':}}.

    NEVER installs anything. Only reports status + install commands so the user
    can install with explicit consent.
    """
    import platform as _pf
    ostype = _pf.system().lower()
    status = {}
    for name, info in DEPENDENCIES.items():
        installed = shutil.which(name) is not None
        install_cmd = info['install'].get(ostype) or info['install'].get('linux', '')
        status[name] = {
            'installed': installed,
            'optional': info.get('optional', False),
            'why': info['why'],
            'install': install_cmd,
        }
    if verbose:
        print('\n📦 Runtime dependencies:', flush=True)
        for name, s in status.items():
            mark = '✅' if s['installed'] else ('⚠️ ' if s['optional'] else '❌')
            opt = ' (optional)' if s['optional'] else ' (required)'
            print(f'   {mark} {name}{opt}', flush=True)
            if not s['installed']:
                print(f'      why: {s["why"]}', flush=True)
                print(f'      install: {s["install"]}', flush=True)
        print(flush=True)
    return status


# ═══════════════════════════════════════════════════════════════════════════
# Model backends — each knows how to instantiate ONE model kind and reply.
# On-demand: instantiated the first time a backend is needed, cached warm.
# ═══════════════════════════════════════════════════════════════════════════

class ModelBackend:
    """Base class. Subclasses implement `invoke(prompt) -> reply_text`."""

    def __init__(self, spec):
        self.spec = spec
        self.name = spec.get('backend', 'echo')

    def invoke(self, prompt):
        raise NotImplementedError


class EchoBackend(ModelBackend):
    def invoke(self, prompt):
        return f'(echo) Acknowledged — received: {prompt[:120]}'


class CliBackend(ModelBackend):
    """Run a local CLI agent (kimi/mimo/codex) one-shot per invoke.

    These CLIs cold-start in seconds; the runtime keeps this object warm (it's
    instantiated once and reused), but each invoke spawns a fresh CLI process.
    For true persistent sessions, point the backend at the CLI's server mode.
    """

    def __init__(self, spec):
        super().__init__(spec)
        kind = self.name.split(':', 1)[1] if ':' in self.name else ''
        self.bin = spec.get('bin') or DEFAULT_BINS.get(kind, '')
        self.timeout = int(spec.get('timeout') or 150)
        self.kind = kind

    def invoke(self, prompt):
        if not self.bin:
            return f'(cli:{self.kind}) binary path not configured'
        builder = CLI_INVOCATIONS.get(self.kind)
        if builder is None:
            return f'(cli:{self.kind}) unknown kind (supported: {", ".join(CLI_INVOCATIONS)})'
        try:
            cmd = builder(self.bin, prompt)
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=self.timeout)
            out = proc.stdout.strip()
            if not out:
                err = proc.stderr.strip()[:200]
                return f'(cli:{self.kind} no output; stderr: {err})'
            return _clean(out)
        except subprocess.TimeoutExpired:
            return f'(cli:{self.kind} timed out after {self.timeout}s — keep replies short)'
        except FileNotFoundError:
            return f'(cli:{self.kind} binary not found: {self.bin})'
        except Exception as e:
            return f'(cli:{self.kind} error: {e})'


class ApiBackend(ModelBackend):
    """OpenAI-compatible chat API (deepseek, moonshot, GLM, OpenAI, ...).

    Stateless: a single HTTP POST per invoke. No warm pool needed. This is how
    'mainstream models' (deepseek etc.) are instantiated — they have no local CLI.
    """

    def __init__(self, spec):
        super().__init__(spec)
        self.api_base = spec.get('api_base') or os.environ.get('MODEL_API_BASE', '')
        self.api_key = spec.get('api_key') or os.environ.get('MODEL_API_KEY', '')
        self.model = spec.get('model') or os.environ.get('MODEL_NAME', 'deepseek-chat')
        self.timeout = int(spec.get('timeout') or 60)
        self.system = spec.get('system_prompt') or 'You are an agent acknowledging task receipt. Reply in 1-3 sentences. Do not use tools.'

    def invoke(self, prompt):
        if not self.api_key:
            return '(api) no api_key configured for this agent'
        url = self.api_base.rstrip('/') + '/v1/chat/completions'
        body = json.dumps({
            'model': self.model,
            'messages': [
                {'role': 'system', 'content': self.system},
                {'role': 'user', 'content': prompt},
            ],
            'max_tokens': 300,
            'temperature': 0.3,
        }).encode()
        req = urllib.request.Request(url, data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('Authorization', f'Bearer {self.api_key}')
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                d = json.loads(resp.read().decode())
                return _clean(d['choices'][0]['message']['content'])
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode())
                msg = err.get('error', {}).get('message', str(err))[:200]
            except Exception:
                msg = str(e)
            return f'(api HTTP {e.code}) {msg}'
        except Exception as e:
            return f'(api error) {e}'


class InstanceBackend(ModelBackend):
    """A PERSISTENT agent instance — not a one-shot chat.

    The previous design called `claude -p '<prompt>'` / `hermes chat -q` which
    is a one-shot query: ask, answer, exit. No file access, no tool use, no
    multi-turn. That's chat, not an agent.

    A real agent INSTANCE is a long-running process (a tmux session running
    `claude` / `hermes` / `kimi` / `mimo` in interactive mode) that:
      - can read/write files, run shell commands, use tools
      - keeps context across multiple task sends
      - works autonomously on a dispatched task until done

    This backend spawns one tmux session per agent_id (named rt-<id>), launches
    the model's interactive agent inside it, and on each invoke sends the task
    via tmux send-keys + captures the agent's work. The instance stays alive
    between invokes (warm) so context accumulates.

    Requires: tmux installed. Mode is per-kind:
      claude  → `claude --dangerously-skip-permissions` (full agent, no prompts)
      hermes  → `hermes` (interactive agent REPL)
      kimi    → `kimi` (interactive)
      mimo    → `mimo` (TUI agent)
      codex   → `codex` (interactive)
    """

    # How each kind launches its persistent agent (interactive, NOT -p/-q).
    INSTANCE_LAUNCH = {
        'claude': '{bin} --dangerously-skip-permissions',
        'hermes': '{bin}',
        'kimi':   '{bin}',
        'mimo':   '{bin}',
        'codex':  '{bin}',
    }
    # Lines to send after launch to dismiss first-run dialogs (per claude-code skill).
    DIALOG_KEYS = {
        'claude': ['Enter', 'Down', 'Enter'],  # trust + bypass-permissions
    }

    def __init__(self, spec):
        super().__init__(spec)
        # backend spec like "instance:claude"
        self.kind = self.name.split(':', 1)[1] if ':' in self.name else ''
        self.bin = spec.get('bin') or DEFAULT_BINS.get(self.kind, '')
        self.workdir = spec.get('workdir') or os.path.expanduser('~')
        self.session = 'rt-' + (spec.get('agent_id') or self.kind)[:12]
        self.timeout = int(spec.get('timeout') or 150)
        self._started = False

    def _ensure_instance(self):
        """Start the tmux session + launch the interactive agent (once)."""
        if self._started:
            # Already running? Verify the tmux session exists.
            r = subprocess.run(['tmux', 'has-session', '-t', self.session],
                               capture_output=True)
            if r.returncode == 0:
                return True
        launch = self.INSTANCE_LAUNCH.get(self.kind, '{bin}').format(bin=self.bin)
        # Create a detached tmux session, cd into workdir, launch the agent.
        subprocess.run(['tmux', 'new-session', '-d', '-s', self.session,
                        '-x', '200', '-y', '50', '-c', self.workdir], capture_output=True)
        subprocess.run(['tmux', 'send-keys', '-t', self.session, launch, 'Enter'],
                       capture_output=True)
        # Dismiss first-run dialogs (workspace trust, permissions).
        for key in self.DIALOG_KEYS.get(self.kind, []):
            subprocess.run(['sleep', '1'], capture_output=True)
            subprocess.run(['tmux', 'send-keys', '-t', self.session, key], capture_output=True)
        # Give the agent time to initialize.
        subprocess.run(['sleep', '4'], capture_output=True)
        self._started = True
        return True

    def invoke(self, prompt):
        if not self.bin:
            return f'(instance:{self.kind}) binary not configured'
        if not shutil.which('tmux'):
            return f'(instance:{self.kind}) tmux not installed — required for persistent agent instances'
        try:
            self._ensure_instance()
            # Send the task to the agent instance.
            subprocess.run(['tmux', 'send-keys', '-t', self.session, prompt, 'Enter'],
                           capture_output=True)
            # Wait for the agent to produce output, then capture the pane.
            subprocess.run(['sleep', str(min(self.timeout, 20))], capture_output=True)
            r = subprocess.run(['tmux', 'capture-pane', '-t', self.session, '-p', '-S', '-60'],
                               capture_output=True, text=True)
            return _clean(r.stdout.strip()) or f'(instance:{self.kind} no output captured — agent still working?)'
        except Exception as e:
            return f'(instance:{self.kind} error: {e})'


class ExecBackend(ModelBackend):
    """Arbitrary command: receives the prompt as the last arg, returns stdout."""

    def __init__(self, spec):
        super().__init__(spec)
        cmd = spec.get('command', '')
        self.cmd = cmd.split()
        self.timeout = int(spec.get('timeout') or 150)

    def invoke(self, prompt):
        try:
            proc = subprocess.run(self.cmd + [prompt], capture_output=True, text=True, timeout=self.timeout)
            out = proc.stdout.strip()
            if not out:
                return f'(exec no output; stderr: {proc.stderr.strip()[:150]})'
            return _clean(out)
        except Exception as e:
            return f'(exec error) {e}'


def make_backend(spec):
    """Factory: pick the right backend class for a spec."""
    backend = spec.get('backend', 'echo')
    if backend == 'echo':
        return EchoBackend(spec)
    if backend.startswith('cli:'):
        return CliBackend(spec)
    if backend.startswith('instance:'):
        return InstanceBackend(spec)
    if backend == 'api':
        return ApiBackend(spec)
    if backend.startswith('exec:'):
        spec = dict(spec)
        spec['command'] = backend[5:]
        return ExecBackend(spec)
    return EchoBackend(spec)


# ═══════════════════════════════════════════════════════════════════════════
# Agent registry — maps agent_id/name -> {secret, backend}. This is the
# ACCURATE ROUTING table: a task can only reach the model bound to its agent_id.
# ═══════════════════════════════════════════════════════════════════════════

class AgentRegistry:
    def __init__(self, args):
        self.single_backend = args.backend
        self.single_secret = args.invoke_secret
        self.agents = {}            # config-file mode
        self.id_to_key = {}
        self._warm_backends = {}    # backend_key -> ModelBackend (warm cache)
        self._lock = threading.Lock()
        self.mode = 'single'

        if args.agents_file:
            self._load(args.agents_file)
            self.mode = 'multi'

    def _load(self, path):
        with open(path) as f:
            cfg = json.load(f)
        entries = cfg.get('agents', cfg)
        for key, spec in entries.items():
            if not isinstance(spec, dict):
                continue
            self.agents[key] = {
                'secret': spec.get('secret', ''),
                'backend': spec.get('backend', 'echo'),
                'api_base': spec.get('api_base'),
                'api_key': spec.get('api_key'),
                'model': spec.get('model'),
                'system_prompt': spec.get('system_prompt'),
                'bin': spec.get('bin'),
                'timeout': spec.get('timeout'),
                'command': spec.get('command'),
            }
            for aid in (spec.get('agent_id'), spec.get('id')):
                if aid:
                    self.id_to_key[aid] = key

    def resolve(self, agent_id, agent_name=None):
        """Return (secret, backend) or None if the agent is not registered.

        Match priority (first hit wins):
          1. agent_id mapped via id_to_key (explicit agent_id field in config)
          2. agent_id IS a key directly (config keyed by UUID)
          3. agent_name IS a key directly (config keyed by name)
        We try agent_id BEFORE name so a UUID-keyed entry always wins even when
        the platform also sends a name — preventing wrong-terminal routing.
        """
        if self.mode == 'multi':
            key = self.id_to_key.get(agent_id)
            if key is None and agent_id and agent_id in self.agents:
                key = agent_id
            if key is None and agent_name and agent_name in self.agents:
                key = agent_name
            spec = self.agents.get(key) if key else None
            if spec is None:
                return None
            # Warm-cache the backend per backend-key (so we don't rebuild each time).
            bk = json.dumps(spec, sort_keys=True)
            with self._lock:
                if bk not in self._warm_backends:
                    self._warm_backends[bk] = make_backend(spec)
            return (spec['secret'], self._warm_backends[bk])
        # single mode: one backend for everyone (but STILL must verify secret).
        bk = f'single:{self.single_backend}'
        with self._lock:
            if bk not in self._warm_backends:
                spec = {'backend': self.single_backend}
                self._warm_backends[bk] = make_backend(spec)
        return (self.single_secret, self._warm_backends[bk])

    def summary(self):
        if self.mode == 'multi':
            return f'multi-agent ({len(self.agents)} agents, {len(self._warm_backends)} warm backends)'
        return f'single ({self.single_backend})'


# ═══════════════════════════════════════════════════════════════════════════
# HTTP handler
# ═══════════════════════════════════════════════════════════════════════════

class RuntimeHandler(BaseHTTPRequestHandler):
    server_version = 'AgentRuntime/1.0'

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-ZZ-Protocol-Version', PROTOCOL_VERSION)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        import time
        ts = time.strftime('%H:%M:%S')
        sys.stderr.write(f'[{ts}] {fmt % args}\n')

    def do_GET(self):
        if self.path in ('/', '/health', '/zz/v1/health'):
            self._send(200, {
                'ok': True, 'protocol_version': PROTOCOL_VERSION,
                'service': 'agent-runtime', 'mode': self.server.registry.summary(),
                'agents': list(self.server.registry.agents.keys()) if self.server.registry.mode == 'multi' else ['(single)'],
            })
        elif self.path == '/agents':
            self._send(200, {'agents': list(self.server.registry.agents.keys())})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        if self.path not in ('/zz/v1/invoke', '/invoke', '/'):
            self._send(404, {'error': {'code': 'not_found', 'message': f'unknown path {self.path}'}})
            return

        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''

        try:
            req = json.loads(raw.decode()) if raw else {}
        except Exception as e:
            self._send(200, {'status': 'failed',
                             'error': {'code': 'bad_json', 'message': str(e), 'retryable': False}})
            return

        agent_id = req.get('agent_id', '') or self.headers.get('X-ZZ-Agent-Id', '')
        agent_name = (req.get('agent') or {}).get('name', '')
        resolved = self.server.registry.resolve(agent_id, agent_name)

        if resolved is None:
            self.log_message('REJECT agent=%s (not in registry — accurate routing)', str(agent_id)[:12])
            self._send(200, {'status': 'rejected',
                             'error': {'code': 'unknown_agent',
                                       'message': f'agent {agent_id} not registered on this runtime — no risk of wrong-terminal routing',
                                       'retryable': False}})
            return

        secret, backend = resolved
        if not verify_signature(secret, raw, self.headers):
            self._send(401, {'status': 'rejected',
                             'error': {'code': 'invalid_signature',
                                       'message': 'X-ZZ-Signature verification failed',
                                       'retryable': False}})
            return

        run_id = req.get('run_id', '?')
        latest = extract_latest_message(req)
        prompt = ack_prompt(latest)
        self.log_message('invoke agent=%s backend=%s run=%s',
                         str(agent_id)[:12], backend.name, str(run_id)[:12])

        try:
            reply = backend.invoke(prompt)
        except Exception as e:
            reply = f'(backend error) {e}'

        self._send(200, {
            'status': 'completed',
            'messages': [{
                'content': reply,
                'content_type': 'text/markdown',
                'role': 'agent',
                'sender_type': 'agent',
                'sender_id': agent_id,
            }],
            'metrics': [],
        })


# ═══════════════════════════════════════════════════════════════════════════
# launchd autostart (macOS) — so the runtime starts on boot and stays up.
# ═══════════════════════════════════════════════════════════════════════════

LAUNCHD_PLIST_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{python}</string>
    <string>{script}</string>
    <string>--port</string><string>{port}</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--agents-file</string><string>{agents_file}</string>
  </array>
  <key>WorkingDirectory</key><string>{home}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{err_log}</string>
</dict>
</plist>
"""


def install_launchd(port, agents_file, script_path):
    home = os.path.expanduser('~')
    plist_path = os.path.join(home, 'Library/LaunchAgents', LAUNCHD_LABEL + '.plist')
    log = os.path.join(home, '.zz-agent', 'runtime.log')
    err_log = os.path.join(home, '.zz-agent', 'runtime.err.log')
    os.makedirs(os.path.dirname(plist_path), exist_ok=True)
    os.makedirs(os.path.dirname(log), exist_ok=True)
    python = sys.executable or '/usr/bin/python3'
    plist = LAUNCHD_PLIST_TEMPLATE.format(
        label=LAUNCHD_LABEL, python=python, script=os.path.abspath(script_path),
        port=port, agents_file=os.path.abspath(agents_file), home=home,
        log=log, err_log=err_log,
    )
    with open(plist_path, 'w') as f:
        f.write(plist)
    print(f'✓ launchd plist written: {plist_path}')
    # Unload if already loaded, then load.
    subprocess.run(['launchctl', 'unload', plist_path], capture_output=True)
    r = subprocess.run(['launchctl', 'load', plist_path], capture_output=True, text=True)
    if r.returncode == 0:
        print(f'✓ launchd loaded (starts on boot, KeepAlive)')
    else:
        print(f'⚠ launchctl load: {r.stderr.strip()}')
    print(f'  logs: {log}')
    print(f'  stop: launchctl unload {plist_path}')


def uninstall_launchd():
    home = os.path.expanduser('~')
    plist_path = os.path.join(home, 'Library/LaunchAgents', LAUNCHD_LABEL + '.plist')
    if os.path.exists(plist_path):
        subprocess.run(['launchctl', 'unload', plist_path], capture_output=True)
        os.remove(plist_path)
        print(f'✓ uninstalled launchd: {plist_path}')
    else:
        print('(not installed)')


# ═══════════════════════════════════════════════════════════════════════════
# Local model discovery — scan the host for installed model CLIs and APIs.
# This is how "an agent downloads the script, then ALL its local models get
# registered, one agent id per model, with the user's permission."
# ═══════════════════════════════════════════════════════════════════════════

# Where to look for each local model CLI (first found wins). Covers the CLIs
# documented in PM skills (claude-code, hermes-agent, codex) + the agent CLIs
# seen on hosts in this project (kimi, mimo).
MODEL_PROBES = {
    'kimi': [
        os.path.expanduser('~/.kimi-code/bin/kimi'),
        '/usr/local/bin/kimi',
    ],
    'mimo': [
        os.path.expanduser('~/.mimocode/bin/mimo'),
        '/usr/local/bin/mimo',
    ],
    'codex': [
        '/Applications/Codex.app/Contents/Resources/codex',
        os.path.expanduser('~/.codex/pm-workers/bin/codex'),
        '/usr/local/bin/codex',
    ],
    'claude': [
        os.path.expanduser('~/.local/bin/claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
    ],
    'hermes': [
        os.path.expanduser('~/.local/bin/hermes'),
        '/opt/homebrew/bin/hermes',
        '/usr/local/bin/hermes',
    ],
    'opencode': [
        os.path.expanduser('~/.local/bin/opencode'),
        '/opt/homebrew/bin/opencode',
        '/usr/local/bin/opencode',
    ],
}

# API providers configured via env (set MODEL_API_KEY + MODEL_API_BASE + MODEL_NAME).
API_PROVIDER_PROBES = [
    {'env_key': 'DEEPSEEK_API_KEY', 'name': 'deepseek', 'api_base': 'https://api.deepseek.com', 'model': 'deepseek-chat'},
    {'env_key': 'OPENAI_API_KEY', 'name': 'openai', 'api_base': 'https://api.openai.com', 'model': 'gpt-4o-mini'},
    {'env_key': 'MOONSHOT_API_KEY', 'name': 'moonshot', 'api_base': 'https://api.moonshot.cn', 'model': 'moonshot-v1-8k'},
    {'env_key': 'GLM_API_KEY', 'name': 'glm', 'api_base': 'https://open.bigmodel.cn/api/paas/v4', 'model': 'glm-4-flash'},
]


def discover_local_models():
    """Scan the host for installed local model CLIs. Returns list of {name, backend, bin}.

    Checks explicit probe paths first, then falls back to PATH lookup (shutil.which)
    so models installed via npm/homebrew/pip are found even outside the probe list.
    """
    import shutil
    found = []
    seen_kinds = set()
    for kind, paths in MODEL_PROBES.items():
        bin_path = None
        for p in paths:
            if os.path.exists(p) and os.access(p, os.X_OK):
                bin_path = p
                break
        # Fallback: PATH lookup (handles npm -g, homebrew, pip installs).
        if bin_path is None:
            which = shutil.which(kind) or shutil.which(f'{kind}-code')
            if which:
                bin_path = which
        if bin_path:
            found.append({'name': f'{kind}-agent', 'backend': f'cli:{kind}', 'bin': bin_path})
            seen_kinds.add(kind)
    return found


def discover_api_providers():
    """Scan env for configured API providers (deepseek/openai/moonshot/GLM)."""
    found = []
    for probe in API_PROVIDER_PROBES:
        key = os.environ.get(probe['env_key'], '')
        if key:
            found.append({
                'name': f'{probe["name"]}-agent',
                'backend': 'api',
                'api_base': probe['api_base'],
                'api_key': key,
                'model': probe['model'],
            })
    return found


def generate_agents_file_from_discovery(output_path, secret_seed=None):
    """Discover all local models + API providers, write an agents.json, one entry
    per model. Each model gets a stable agent name (used as the routing key).

    Returns the dict so the caller can also auto-register them with the platform.
    """
    import secrets as _secrets
    seed = secret_seed or _secrets.token_hex(8)
    agents = {}
    all_models = discover_local_models() + discover_api_providers()
    for m in all_models:
        # Stable per-model secret (derived from seed + name) so reinstall keeps keys.
        per_secret = hashlib.sha256(f'{seed}:{m["name"]}'.encode()).hexdigest()[:32]
        entry = {'secret': per_secret, 'backend': m['backend']}
        if m.get('bin'):
            entry['bin'] = m['bin']
        if m.get('api_base'):
            entry['api_base'] = m['api_base']
            entry['api_key'] = m['api_key']
            entry['model'] = m['model']
        # Use the model name as the routing key. When registering with the
        # platform, set agent.name = this key so routing matches.
        agents[m['name']] = entry
    cfg = {
        'seed': seed,
        'comment': 'Auto-generated by runtime.py --discover. One agent per local model. '
                   'Register each agent with the platform using its name as the agent name.',
        'agents': agents,
    }
    with open(output_path, 'w') as f:
        json.dump(cfg, f, indent=2)
    return cfg


def cmd_discover(args):
    """The --discover command: scan local models, write agents.json, optionally
    auto-register each with the platform and install launchd autostart."""
    print('🔍 Scanning for local models...', flush=True)
    local = discover_local_models()
    api = discover_api_providers()
    print(f'   Local CLIs : {len(local)} found', flush=True)
    for m in local:
        print(f'     • {m["name"]:16} {m["backend"]:12} {m["bin"]}', flush=True)
    print(f'   API providers: {len(api)} found', flush=True)
    for m in api:
        print(f'     • {m["name"]:16} api          {m["api_base"]}', flush=True)
    print(flush=True)
    print('ℹ️  These are models ALREADY INSTALLED on this host (by you, npm, brew, etc).',
          flush=True)
    print('   The runtime detects them; it does NOT install them. Each becomes its',
          flush=True)
    print('   own agent on the platform with its own id.', flush=True)

    # Show runtime dependencies (tmux etc.) — clearly, never silent install.
    check_dependencies(verbose=True)

    if not local and not api:
        print('\n✗ No local models found. Install kimi/mimo/codex/claude/hermes or set an API key env.', file=sys.stderr)
        sys.exit(1)

    out = args.agents_file or os.path.join(os.path.expanduser('~'), '.zz-agent', 'discovered-agents.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cfg = generate_agents_file_from_discovery(out)
    print(f'\n✓ agents.json written: {out}', flush=True)
    print(f'  {len(cfg["agents"])} agent(s), one per model, each with a stable secret.', flush=True)
    print(f'\nNext steps:', flush=True)
    print(f'  1. Start the runtime:  python3 runtime.py --port {args.port} --agents-file {out}', flush=True)
    print(f'  2. Autostart on boot:  python3 runtime.py --install-launchd --agents-file {out} --port {args.port}', flush=True)
    print(f'  3. Register each model with the platform (one agent id per model):', flush=True)
    for name in cfg['agents']:
        print(f'       zz agents register -p <project> -n {name} '
              f'--endpoint-url http://<this-host>:{args.port}/zz/v1/invoke '
              f'--invoke-secret {cfg["agents"][name]["secret"]}', flush=True)
    print(f'\nEach model now has its OWN agent id on the platform. PM dispatches to a', flush=True)
    print(f'specific model go ONLY to that model — no wrong-terminal routing.', flush=True)

    if args.install_launchd:
        install_launchd(args.port, out, os.path.abspath(__file__))


# ═══════════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════════

def main():
    p = argparse.ArgumentParser(
        description='Agent Runtime — unified local-model runtime (multi-agent, on-demand, accurate routing)',
    )
    p.add_argument('--port', type=int, default=7785)
    p.add_argument('--host', default='0.0.0.0')
    p.add_argument('--agents-file', default=os.environ.get('AGENTS_FILE', ''),
                   help='agents.json mapping agent_id -> {secret, backend}. Env AGENTS_FILE.')
    p.add_argument('--backend', default=os.environ.get('RUNTIME_BACKEND', 'echo'),
                   help='single-agent mode backend (echo|cli:kimi|cli:mimo|cli:codex|api|exec:<cmd>)')
    p.add_argument('--invoke-secret', default=os.environ.get('INVOKE_SECRET', ''),
                   help='single-agent mode HMAC secret.')
    p.add_argument('--discover', action='store_true',
                   help='Scan this host for local models (kimi/mimo/codex + API providers), '
                        'write agents.json with one agent per model, and print registration commands.')
    p.add_argument('--install-launchd', action='store_true', help='Install macOS launchd autostart (with --discover: after generating agents.json).')
    p.add_argument('--uninstall-launchd', action='store_true', help='Remove launchd autostart and exit.')
    args = p.parse_args()

    if args.uninstall_launchd:
        uninstall_launchd()
        return

    if args.discover:
        cmd_discover(args)
        return

    if args.install_launchd:
        if not args.agents_file:
            print('✗ --install-launchd requires --agents-file', file=sys.stderr)
            sys.exit(1)
        install_launchd(args.port, args.agents_file, os.path.abspath(__file__))
        return

    registry = AgentRegistry(args)
    server = ThreadingHTTPServer((args.host, args.port), RuntimeHandler)
    server.registry = registry

    print(f'🤖 Agent Runtime (runtime.{PROTOCOL_VERSION})', flush=True)
    print(f'   Listening : http://{args.host}:{args.port}/zz/v1/invoke', flush=True)
    print(f'   Mode      : {registry.summary()}', flush=True)
    print(f'   Routing   : X-ZZ-Agent-Id → backend (agents.json) — no wrong-terminal risk', flush=True)
    if registry.mode == 'multi':
        for key, spec in registry.agents.items():
            print(f'   agent     : {key[:28]:28} backend={spec["backend"]}', flush=True)
    # Show environment status — clearly, never silently installing.
    check_dependencies(verbose=True)
    print(f'   Autostart : runtime.py --install-launchd --agents-file <file>', flush=True)
    print(f'   Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping...', flush=True)
        server.shutdown()


if __name__ == '__main__':
    main()
