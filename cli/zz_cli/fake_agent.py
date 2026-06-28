from __future__ import annotations

import hashlib
import hmac
import json
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


FAKE_AGENT_MODES = {"normal", "slow", "fail", "reject", "invalid-json", "no-reply"}


@dataclass(frozen=True)
class FakeAgentConfig:
    name: str = "fake-agent"
    mode: str = "normal"
    invoke_secret: str = "dev-secret"
    delay_seconds: float = 3.0
    require_hmac: bool = True
    timestamp_tolerance_seconds: int = 300


def sign_runtime_request(
    raw_body: bytes,
    invoke_secret: str,
    timestamp: str,
    delivery_id: str,
) -> str:
    body_hash = hashlib.sha256(raw_body).hexdigest()
    signed_payload = f"{timestamp}.{delivery_id}.{body_hash}".encode("utf-8")
    digest = hmac.new(
        invoke_secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()
    return f"sha256={digest}"


def start_fake_agent_thread(
    host: str,
    port: int,
    config: FakeAgentConfig,
) -> tuple[ThreadingHTTPServer, threading.Thread]:
    server = ThreadingHTTPServer((host, port), _handler_factory(config))
    server.config = config  # type: ignore[attr-defined]
    server.idempotency_cache = {}  # type: ignore[attr-defined]
    server.cache_lock = threading.Lock()  # type: ignore[attr-defined]
    thread = threading.Thread(
        target=server.serve_forever,
        name=f"zz-fake-agent-{config.name}",
        daemon=True,
    )
    thread.start()
    return server, thread


def run_fake_agent(host: str, port: int, config: FakeAgentConfig) -> None:
    server = ThreadingHTTPServer((host, port), _handler_factory(config))
    server.config = config  # type: ignore[attr-defined]
    server.idempotency_cache = {}  # type: ignore[attr-defined]
    server.cache_lock = threading.Lock()  # type: ignore[attr-defined]
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def _handler_factory(config: FakeAgentConfig) -> type[BaseHTTPRequestHandler]:
    class FakeAgentHandler(BaseHTTPRequestHandler):
        server_version = "zz-fake-agent/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            print(
                f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] "
                f"{self.address_string()} {fmt % args}",
                flush=True,
            )

        def do_GET(self) -> None:
            if self.path not in {"/", "/health"}:
                self._send_json(404, {"error": "not_found"})
                return
            self._send_json(
                200,
                {
                    "status": "ok",
                    "name": config.name,
                    "mode": config.mode,
                    "invoke_path": "/zz/v1/invoke",
                },
            )

        def do_POST(self) -> None:
            if self.path != "/zz/v1/invoke":
                self._send_json(404, {"error": "not_found"})
                return

            raw_body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            hmac_error = self._verify_runtime_headers(raw_body)
            if hmac_error is not None:
                status_code, error = hmac_error
                self._send_json(status_code, {"error": error})
                return

            cache_key = self.headers.get("X-ZZ-Idempotency-Key")
            if cache_key:
                cached = self._cache_get(cache_key)
                if cached is not None:
                    self._send_raw(*cached, replay=True)
                    return

            try:
                payload = json.loads(raw_body.decode("utf-8") or "{}")
            except json.JSONDecodeError as exc:
                self._send_json(
                    400,
                    {
                        "error": "invalid_request_json",
                        "message": str(exc),
                    },
                )
                return

            if config.mode == "slow":
                time.sleep(config.delay_seconds)

            started = time.perf_counter()
            status_code, headers, response_body = self._build_response(payload)
            elapsed_ms = (time.perf_counter() - started) * 1000
            if response_body.startswith(b"{"):
                try:
                    response_data = json.loads(response_body)
                    response_data.setdefault("metrics", []).append(
                        {"name": "handler_duration_ms", "value": elapsed_ms, "unit": "ms"}
                    )
                    response_body = json.dumps(response_data).encode("utf-8")
                    headers["Content-Length"] = str(len(response_body))
                except json.JSONDecodeError:
                    pass

            if cache_key:
                self._cache_set(cache_key, (status_code, headers, response_body))

            self._send_raw(status_code, headers, response_body, replay=False)

        def _verify_runtime_headers(self, raw_body: bytes) -> tuple[int, str] | None:
            required_headers = [
                "X-ZZ-Protocol-Version",
                "X-ZZ-Project-Id",
                "X-ZZ-Session-Id",
                "X-ZZ-Agent-Id",
                "X-ZZ-Run-Id",
                "X-ZZ-Delivery-Id",
                "X-ZZ-Attempt",
                "X-ZZ-Timestamp",
                "X-ZZ-Trace-Id",
                "X-ZZ-Idempotency-Key",
            ]
            missing = [header for header in required_headers if not self.headers.get(header)]
            if missing:
                return 400, f"missing runtime headers: {', '.join(missing)}"

            if self.headers.get("X-ZZ-Protocol-Version") != "runtime.v1":
                return 400, "unsupported protocol version"

            if not config.require_hmac:
                return None

            timestamp = self.headers.get("X-ZZ-Timestamp")
            delivery_id = self.headers.get("X-ZZ-Delivery-Id")
            signature = self.headers.get("X-ZZ-Signature")
            if not timestamp or not delivery_id or not signature:
                return 401, "missing hmac signature headers"

            if config.timestamp_tolerance_seconds > 0:
                try:
                    age = abs(time.time() - int(timestamp))
                except ValueError:
                    return 401, "invalid hmac timestamp"
                if age > config.timestamp_tolerance_seconds:
                    return 401, "hmac timestamp outside tolerance"

            expected = sign_runtime_request(
                raw_body=raw_body,
                invoke_secret=config.invoke_secret,
                timestamp=timestamp,
                delivery_id=delivery_id,
            )
            if not hmac.compare_digest(signature, expected):
                return 401, "invalid hmac signature"
            return None

        def _build_response(self, payload: dict[str, Any]) -> tuple[int, dict[str, str], bytes]:
            headers = {
                "Content-Type": "application/json",
                "X-ZZ-Fake-Agent": config.name,
            }

            if config.mode == "invalid-json":
                body = b'{"status": "completed", "messages": ['
                headers["Content-Length"] = str(len(body))
                return 200, headers, body

            if config.mode == "fail":
                body_data: dict[str, Any] = {
                    "status": "failed",
                    "error": {
                        "code": "fake_agent_failed",
                        "message": f"{config.name} failed by requested mode",
                        "retryable": True,
                    },
                    "debug": {"summary": "Intentional fake-agent failure."},
                }
            elif config.mode == "reject":
                body_data = {
                    "status": "rejected",
                    "error": {
                        "code": "fake_agent_rejected",
                        "message": f"{config.name} rejected the invocation",
                        "retryable": False,
                    },
                    "debug": {"summary": "Intentional fake-agent rejection."},
                }
            elif config.mode == "no-reply":
                body_data = {
                    "status": "no_reply",
                    "metrics": self._base_metrics(payload),
                    "debug": {"summary": f"{config.name} completed without a reply."},
                }
            else:
                body_data = {
                    "status": "completed",
                    "messages": [self._message(payload)],
                    "metrics": self._base_metrics(payload),
                    "debug": {"summary": f"{config.name} completed normally."},
                }

            body = json.dumps(body_data, ensure_ascii=False).encode("utf-8")
            headers["Content-Length"] = str(len(body))
            return 200, headers, body

        def _message(self, payload: dict[str, Any]) -> dict[str, Any]:
            content = _extract_prompt(payload)
            agent_id = (
                payload.get("agent_id")
                or self.headers.get("X-ZZ-Agent-Id")
                or config.name
            )
            return {
                "role": "agent",
                "agent_id": agent_id,
                "type": "text",
                "content": f"{config.name} received: {content}",
                "visibility": "session",
                "metadata": {"fake_agent_mode": config.mode},
            }

        def _base_metrics(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
            recent_messages = payload.get("recent_messages")
            message_count = len(recent_messages) if isinstance(recent_messages, list) else 0
            attempt = payload.get("attempt") or self.headers.get("X-ZZ-Attempt") or 1
            try:
                attempt_value = int(attempt)
            except (TypeError, ValueError):
                attempt_value = 1
            return [
                {"name": "fake_agent_invocations", "value": 1, "unit": "count"},
                {"name": "recent_message_count", "value": message_count, "unit": "count"},
                {"name": "attempt", "value": attempt_value, "unit": "count"},
            ]

        def _cache_get(self, key: str) -> tuple[int, dict[str, str], bytes] | None:
            with self.server.cache_lock:  # type: ignore[attr-defined]
                cached = self.server.idempotency_cache.get(key)  # type: ignore[attr-defined]
                if cached is None:
                    return None
                status_code, headers, body = cached
                return status_code, dict(headers), body

        def _cache_set(self, key: str, value: tuple[int, dict[str, str], bytes]) -> None:
            with self.server.cache_lock:  # type: ignore[attr-defined]
                self.server.idempotency_cache[key] = value  # type: ignore[attr-defined]

        def _send_json(self, status_code: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send_raw(
                status_code,
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(len(body)),
                    "X-ZZ-Fake-Agent": config.name,
                },
                body,
                replay=False,
            )

        def _send_raw(
            self,
            status_code: int,
            headers: dict[str, str],
            body: bytes,
            replay: bool,
        ) -> None:
            self.send_response(status_code)
            merged_headers = dict(headers)
            merged_headers["X-ZZ-Idempotent-Replay"] = "true" if replay else "false"
            merged_headers["Content-Length"] = str(len(body))
            for key, value in merged_headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

    return FakeAgentHandler


def _extract_prompt(payload: dict[str, Any]) -> str:
    trigger = payload.get("trigger")
    if isinstance(trigger, dict):
        for key in ("message", "input"):
            value = trigger.get(key)
            if isinstance(value, dict) and isinstance(value.get("content"), str):
                return value["content"]
            if isinstance(value, str):
                return value
        if isinstance(trigger.get("content"), str):
            return trigger["content"]

    recent_messages = payload.get("recent_messages")
    if isinstance(recent_messages, list):
        for message in reversed(recent_messages):
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                return message["content"]

    return "runtime invoke"
