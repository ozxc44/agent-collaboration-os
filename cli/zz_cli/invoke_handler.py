#!/usr/bin/env python3
"""
Standard Invoke Handler (runtime.v1) — the agent's BRAIN entrypoint.

The invoke server forwards each platform POST to a handler command on stdin
(JSON) and expects the reply text on stdout. THIS is the reference handler.
It is correct by construction: agents that adapt it avoid the two most common
mistakes seen in the wild —

  • mimo handler used `mimo --no-interactive -p` (wrong subcommand; mimo prints
    help and exits, so every reply was a fallback string).
  • kimi handler passed the full task markdown to `kimi -p`, so kimi treated the
    dispatched task as real work — it edited files and ran tests for minutes,
    timing out the synchronous invoke.

The key principle encoded here: **a platform invoke is a SYNCHRONOUS ping that
expects a FAST acknowledgement**. The agent must NOT execute the dispatched task
inside the invoke (that would block for minutes). It replies with a short
acknowledgement; the actual work happens asynchronously in the agent's own
session/daemon. This keeps invokes under a few seconds.

## How an agent adapts this

Replace the `produce_reply()` function with a call to YOUR backend (kimi -p,
mimo run, a local model, etc.). Keep these invariants:

  1. Read the invoke request from stdin, extract ONLY the last user message.
  2. Produce a SHORT text reply (1-3 sentences). Do NOT do the task here.
  3. Print ONLY the reply text on stdout (the invoke server wraps it).
  4. Stay under ~120s; aim for <30s. If your backend is slow, keep it warm.

Usage (the invoke server calls this as --handler):
  python3 invoke_handler.py            # echo mode: replies with what it got (test)
  python3 invoke_handler.py --backend kimi
  python3 invoke_handler.py --backend mimo
  python3 invoke_handler.py --backend exec:/path/to/your/command

Pure Python stdlib. No dependencies.
"""
import argparse
import json
import os
import subprocess
import sys

# Hard cap: never let a backend call exceed the platform's invoke timeout.
DEFAULT_BACKEND_TIMEOUT = 120


def extract_last_user_message(req: dict) -> str:
    """Pull just the latest user/system message — not the full conversation.

    Passing the whole markdown task to the agent makes it start executing (slow).
    For an acknowledgement we only need the gist of the latest message.
    """
    msgs = req.get('recent_messages') or []
    for m in reversed(msgs):
        if m.get('sender_type') in ('user', 'system') or m.get('role') == 'user':
            content = m.get('content', '')
            if content:
                # Keep it short — the acknowledgement doesn't need the full task.
                return content[:800]
    trigger = req.get('trigger') or {}
    if isinstance(trigger, dict) and trigger.get('content'):
        return str(trigger['content'])[:800]
    return '(no message content)'


def ack_prompt(latest: str) -> str:
    """Frame the prompt so the backend ACKNOWLEDGES instead of executing.

    This is the fix for 'kimi treats the task as real work and times out'.
    The backend is told explicitly: read-only, text only, no tools, short reply.
    """
    return (
        '# Read-only acknowledgement request\n'
        'A collaboration platform is pinging you to confirm you received a task.\n'
        'Reply with 1-3 sentences confirming receipt and that you will work on it.\n'
        'DO NOT use tools, DO NOT edit files, DO NOT run commands, DO NOT execute '
        'the task now. Just reply with text.\n\n'
        f'# The message you received\n{latest}\n\n'
        '# Your short text reply (confirm receipt):'
    )


def call_backend_subprocess(cmd: list, prompt: str, timeout: int) -> str:
    """Run an external backend command, feeding the prompt, returning its stdout."""
    try:
        # Many agent CLIs take the message as the last positional arg.
        full = cmd + [prompt]
        proc = subprocess.run(full, capture_output=True, text=True, timeout=timeout)
        out = proc.stdout.strip()
        if not out:
            err = proc.stderr.strip()[:200]
            return f'(backend {cmd[0]} produced no output; stderr: {err})'
        return _clean_reply(out)
    except subprocess.TimeoutExpired:
        return f'(backend {cmd[0]} timed out after {timeout}s — keep your reply short)'
    except FileNotFoundError:
        return f'(backend {cmd[0]} not found on PATH — install it or set --backend exec:/path)'
    except Exception as e:
        return f'(backend {cmd[0]} error: {e})'


def _clean_reply(text: str) -> str:
    """Strip trailing session-resume hints that agent CLIs often append."""
    lines = []
    for line in text.splitlines():
        if line.startswith('To resume this session:') or line.startswith('To continue this session:'):
            continue
        lines.append(line)
    return '\n'.join(lines).strip()


def produce_reply(req: dict, backend: str, timeout: int) -> str:
    """Produce the acknowledgement reply. Override/extend the backends as needed."""
    latest = extract_last_user_message(req)
    prompt = ack_prompt(latest)

    if backend == 'echo':
        # Test mode: just echo back the gist. No external call.
        return f'(echo) Acknowledged — received: {latest[:120]}'

    if backend == 'kimi':
        return call_backend_subprocess(
            ['/Users/z/.kimi-code/bin/kimi', '-p', prompt, '--output-format', 'text'],
            prompt, timeout,
        )

    if backend == 'mimo':
        return call_backend_subprocess(
            ['/Users/z/.mimocode/bin/mimo', 'run', prompt],
            prompt, timeout,
        )

    if backend.startswith('exec:'):
        cmd = backend[5:].split()
        return call_backend_subprocess(cmd, prompt, timeout)

    # Default: echo (safe, fast). Agent must set --backend to its real CLI.
    return f'(no backend configured; echo) Acknowledged — received: {latest[:120]}'


def main():
    p = argparse.ArgumentParser(description='Standard Invoke Handler (runtime.v1)')
    p.add_argument('--backend', default=os.environ.get('AGENT_BACKEND', 'echo'),
                   help='Backend: echo (test), kimi, mimo, or exec:<cmd args>. Env AGENT_BACKEND.')
    p.add_argument('--timeout', type=int, default=int(os.environ.get('AGENT_BACKEND_TIMEOUT', DEFAULT_BACKEND_TIMEOUT)))
    args = p.parse_args()

    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        print(f'(handler: failed to parse invoke request: {e})')
        return

    reply = produce_reply(req, args.backend, args.timeout)
    # Print ONLY the reply content. The invoke server wraps it.
    print(reply)


if __name__ == '__main__':
    main()
