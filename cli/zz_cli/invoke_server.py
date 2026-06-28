#!/usr/bin/env python3
"""
Agent Invoke Server (runtime.v1) — the HTTP endpoint an agent exposes so the
platform can POST tasks/messages to it and it responds with the agent's output.

Per platform contract (runtime.v1):
  POST <endpoint_url>    (e.g. http://0.0.0.0:7781/zz/v1/invoke)
  Headers in:
    X-ZZ-Protocol-Version, X-ZZ-Project-Id, X-ZZ-Session-Id, X-ZZ-Agent-Id,
    X-ZZ-Run-Id, X-ZZ-Delivery-Id, X-ZZ-Timestamp, X-ZZ-Signature: sha256=<hmac>
    X-ZZ-Trace-Id, X-ZZ-Idempotency-Key
  Body in:  AgentInvokeRequest JSON — { project_id, session_id, agent_id,
            trigger, agent:{system_prompt}, recent_messages:[...], project_rules, ... }
  Body out: { "status": "completed",
              "messages": [{"content": "<the agent's reply, markdown>",
                            "content_type": "text/markdown"}] }

This is the agent's BRAIN endpoint. The agent IS the LLM — when the platform
POSTs an invoke request, this server is where the agent thinks and replies.

══════════════════════════════════════════════════════════════════════════════
MULTI-AGENT: one server, many agents (PORT REUSE)
══════════════════════════════════════════════════════════════════════════════
A single host often runs several agents (kimi, mimocode, hermes...). Instead of
one server + one port per agent, this server serves ALL of them on ONE port.
The platform identifies the target agent in the X-ZZ-Agent-Id header; the server
routes to that agent's secret + handler.

Three ways to configure (in priority order):

  1. CONFIG FILE (--agents-file agents.json) — recommended for multi-agent:
     {
       "agents": {
         "kimi-agent":     {"secret": "s1", "handler": "python3 kimi_brain.py"},
         "mimocode-agent": {"secret": "s2", "handler": "python3 mimo_brain.py", "echo": true},
         "hermes":         {"secret": "s3", "handler": "/path/to/hermes.sh"}
       }
     }
     Keys are agent IDs (UUID) OR agent names; X-ZZ-Agent-Id is matched against
     both. Each agent has its own secret + handler. Unknown agents are rejected.

  2. SHARED (--shared-handler) — one handler for all agents on this host:
     python3 invoke_server.py --port 7781 --shared-handler \
         --invoke-secret <secret> --handler "python3 brain.py"
     Useful when one brain script serves multiple agents (it reads agent_id
     from the request body and branches). Same secret for all.

  3. SINGLE (default) — one agent per server (backward compatible):
     python3 invoke_server.py --port 7781 --invoke-secret S --handler "cmd"
     Or --echo for a smoke test. Register every agent's endpoint_url pointing
     at this same port; only the configured agent is served.

The handler command receives the full AgentInvokeRequest as JSON on stdin and
must print the reply text on stdout (plain text or a JSON object with a
"content" key). Everything else (HMAC verify, response shaping, routing) is
handled here.

Pure Python stdlib. No dependencies. Works on macOS/Linux.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL_VERSION = 'runtime.v1'


def verify_signature(invoke_secret: str, raw_body: bytes, headers) -> bool:
    """Verify X-ZZ-Signature HMAC. Returns True if valid or if no secret set."""
    if not invoke_secret:
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
    expected = hmac.new(invoke_secret.encode(), signed_payload.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(provided, expected)


def extract_prompt(req: dict) -> str:
    """Build the prompt text the agent's brain should respond to."""
    parts = []
    sysp = (req.get('agent') or {}).get('system_prompt')
    if sysp:
        parts.append(f'# System\n{sysp}\n')
    msgs = req.get('recent_messages') or []
    if msgs:
        parts.append('# Recent conversation')
        for mm in msgs[-8:]:
            role = mm.get('sender_type', mm.get('role', '?'))
            content = mm.get('content', '')
            parts.append(f'[{role}] {content}')
        parts.append('')
    trigger = req.get('trigger') or {}
    if trigger.get('type') == 'message.created':
        parts.append('# Respond to the latest message above.')
    return '\n'.join(parts)


def run_handler(handler_cmd: str, req_json: str, timeout: int = 300) -> str:
    """Pipe the invoke request to a handler command; return its stdout reply."""
    try:
        proc = subprocess.run(
            handler_cmd, shell=True, input=req_json,
            capture_output=True, text=True, timeout=timeout,
        )
        out = proc.stdout.strip()
        if not out:
            err = proc.stderr.strip()[:300]
            return f'(handler produced no output. stderr: {err})'
        try:
            parsed = json.loads(out)
            if isinstance(parsed, dict) and 'content' in parsed:
                return str(parsed['content'])
        except json.JSONDecodeError:
            pass
        return out
    except subprocess.TimeoutExpired:
        return f'(handler timed out after {timeout}s)'
    except Exception as e:
        return f'(handler error: {e})'


class AgentRegistry:
    """Resolves an incoming invoke to (secret, handler_cmd, echo_mode) for the
    target agent. Supports config-file (multi-agent), shared-handler, and
    single-agent modes."""

    def __init__(self, args):
        self.mode = 'single'
        self.agents = {}        # config-file mode: {id_or_name: {secret,handler,echo}}
        self.id_to_key = {}     # canonical lookup: agent_id -> registry key
        self.shared_secret = args.invoke_secret or os.environ.get('INVOKE_SECRET', '')
        self.shared_handler = args.handler or os.environ.get('AGENT_HANDLER', '')
        self.shared_echo = args.echo
        self.shared = args.shared_handler

        # Mode 1: config file (multi-agent)
        if args.agents_file:
            self._load_config(args.agents_file)
            self.mode = 'multi'
        # Mode 2: shared handler for all agents on this host
        elif self.shared:
            self.mode = 'shared'
        # Mode 3: single agent (default)

    def _load_config(self, path):
        with open(path) as f:
            cfg = json.load(f)
        entries = cfg.get('agents', cfg)
        for key, spec in entries.items():
            if not isinstance(spec, dict):
                continue
            self.agents[key] = {
                'secret': spec.get('secret', ''),
                'handler': spec.get('handler', ''),
                'echo': bool(spec.get('echo', False)),
            }
            # Also map any listed agent_id to this key for exact lookup.
            for aid in (spec.get('agent_id'), spec.get('id')):
                if aid:
                    self.id_to_key[aid] = key

    def resolve(self, agent_id, agent_name=None):
        """Return (secret, handler, echo) for the target agent, or None."""
        # Multi-agent: look up by id, then name, then any entry.
        if self.mode == 'multi':
            key = self.id_to_key.get(agent_id)
            if key is None and agent_name:
                key = agent_name
            if key is None:
                key = agent_id
            spec = self.agents.get(key)
            if spec is None:
                # Fallback: maybe registered under a name we don't know; reject.
                return None
            return (spec['secret'], spec['handler'], spec['echo'])
        # Shared or single: same secret/handler for everyone.
        return (self.shared_secret, self.shared_handler, self.shared_echo)

    def summary(self):
        if self.mode == 'multi':
            return f"multi-agent ({len(self.agents)} agents from config)"
        if self.mode == 'shared':
            return "shared (one handler for all agents on this host)"
        if self.shared_echo:
            return "single / echo (test)"
        return f"single ({self.shared_handler or 'NONE'})"


class InvokeHandler(BaseHTTPRequestHandler):
    server_version = 'AgentInvokeServer/1.0'

    def _send(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-ZZ-Protocol-Version', PROTOCOL_VERSION)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        ts = __import__('time').strftime('%H:%M:%S')
        sys.stderr.write(f'[{ts}] {fmt % args}\n')

    def do_GET(self):
        if self.path in ('/', '/health', '/zz/v1/health'):
            self._send(200, {'ok': True, 'protocol_version': PROTOCOL_VERSION,
                             'service': 'agent-invoke-server',
                             'mode': self.server.registry.summary()})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        if self.path not in ('/zz/v1/invoke', '/invoke', '/'):
            self._send(404, {'error': {'code': 'not_found',
                                       'message': f'unknown path {self.path}'}})
            return

        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''

        try:
            req = json.loads(raw.decode()) if raw else {}
        except Exception as e:
            self._send(200, {'status': 'failed',
                             'error': {'code': 'bad_json', 'message': str(e),
                                       'retryable': False}})
            return

        agent_id = req.get('agent_id', '') or self.headers.get('X-ZZ-Agent-Id', '')
        agent_name = (req.get('agent') or {}).get('name', '')
        resolved = self.server.registry.resolve(agent_id, agent_name)

        if resolved is None:
            self.log_message('reject agent=%s (unknown in config)', str(agent_id)[:12])
            self._send(200, {'status': 'rejected',
                             'error': {'code': 'unknown_agent',
                                       'message': f'agent {agent_id} not in registry',
                                       'retryable': False}})
            return

        secret, handler_cmd, echo_mode = resolved

        # Verify HMAC signature (if a secret is configured for this agent).
        if not verify_signature(secret, raw, self.headers):
            self._send(401, {'status': 'rejected',
                             'error': {'code': 'invalid_signature',
                                       'message': 'X-ZZ-Signature verification failed',
                                       'retryable': False}})
            return

        run_id = req.get('run_id', '?')
        trigger_type = (req.get('trigger') or {}).get('type', '?')
        self.log_message('invoke agent=%s run=%s trigger=%s',
                         str(agent_id)[:12], str(run_id)[:12], trigger_type)

        # Produce the reply.
        if echo_mode:
            reply = extract_prompt(req) or '(no prompt content)'
        elif handler_cmd:
            reply = run_handler(handler_cmd, raw.decode())
        else:
            reply = ('Agent invoke server received a request but has no handler '
                     'configured for this agent. Use --echo (test), --handler "cmd", '
                     '--shared-handler, or --agents-file agents.json.')

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


def main():
    p = argparse.ArgumentParser(
        description='Agent Invoke Server (runtime.v1) — multi-agent capable',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split('═══')[0] if '═══' in (__doc__ or '') else '',
    )
    p.add_argument('--port', type=int, default=7781)
    p.add_argument('--host', default='0.0.0.0')
    p.add_argument('--invoke-secret', default=os.environ.get('INVOKE_SECRET', ''),
                   help='HMAC secret (single/shared modes). Env INVOKE_SECRET.')
    p.add_argument('--handler', default=os.environ.get('AGENT_HANDLER', ''),
                   help='Command receiving invoke JSON on stdin, printing reply.')
    p.add_argument('--echo', action='store_true',
                   help='Echo mode (smoke test): reply with the received prompt.')
    p.add_argument('--shared-handler', action='store_true',
                   help='Multi-agent: one handler+secret serves ALL agents on this host.')
    p.add_argument('--agents-file', default=os.environ.get('AGENTS_FILE', ''),
                   help='JSON config mapping agent id/name -> {secret,handler,echo}. '
                        'Serves many agents on one port. Env AGENTS_FILE.')
    args = p.parse_args()

    registry = AgentRegistry(args)
    if registry.mode == 'single' and not args.echo and not args.handler:
        print('⚠ No handler configured. --echo (test) / --handler "cmd" / '
              '--shared-handler / --agents-file agents.json', file=sys.stderr)

    server = ThreadingHTTPServer((args.host, args.port), InvokeHandler)
    server.registry = registry

    print(f'🧠 Agent Invoke Server (runtime.{PROTOCOL_VERSION})', flush=True)
    print(f'   Listening : http://{args.host}:{args.port}/zz/v1/invoke', flush=True)
    print(f'   Mode      : {registry.summary()}', flush=True)
    if registry.mode == 'multi':
        for key, spec in registry.agents.items():
            print(f'   agent     : {key[:32]:32} '
                  f'secret={"set" if spec["secret"] else "-":3} '
                  f'echo={"y" if spec["echo"] else "n"} '
                  f'handler={(spec["handler"] or "-")[:30]}', flush=True)
    elif registry.mode == 'single' and not args.echo:
        print(f'   Secret    : {"set" if registry.shared_secret else "(none)"}', flush=True)
        print(f'   Register  : zz agents register -p <project> -n <name> \\', flush=True)
        print(f'                 --endpoint-url http://<host>:{args.port}/zz/v1/invoke \\', flush=True)
        print(f'                 --invoke-secret <secret>', flush=True)
    print(f'   Ctrl+C to stop.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping...', flush=True)
        server.shutdown()


if __name__ == '__main__':
    main()
