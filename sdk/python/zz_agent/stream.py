from __future__ import annotations

import json
from typing import Any, Generator, Optional

import httpx

from .models import EventEnvelope


class EventStreamClient:
    """SSE (Server-Sent Events) client for streaming session events.

    Usage::

        for event in client.stream(session_id="sess_xxx"):
            print(event.type, event.payload)
    """

    def __init__(
        self,
        base_url: str,
        http_client: httpx.Client,
        token_manager: Any,  # TokenManager, avoid circular
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._http_client = http_client
        self._token_manager = token_manager

    def stream(
        self,
        session_id: str,
        after_seq: Optional[int] = None,
    ) -> Generator[EventEnvelope, None, None]:
        """Stream events from a session via SSE.

        Args:
            session_id: The session ID to stream events from.
            after_seq: Optional sequence number to resume from.

        Yields:
            EventEnvelope for each event in the stream.
        """
        headers = self._token_manager.get_headers()
        headers["Accept"] = "text/event-stream"

        params: dict[str, Any] = {}
        if after_seq is not None:
            params["after_seq"] = after_seq

        url = f"{self._base_url}/v1/sessions/{session_id}/stream"

        with self._http_client.stream(
            "GET", url, headers=headers, params=params,
        ) as response:
            response.raise_for_status()
            for line in response.iter_lines():
                line = line.strip()
                if line.startswith("data: "):
                    data_str = line[6:]
                    try:
                        data = json.loads(data_str)
                        yield EventEnvelope(**data)
                    except (json.JSONDecodeError, Exception):
                        # Skip malformed events
                        continue
