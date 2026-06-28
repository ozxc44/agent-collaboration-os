from __future__ import annotations

import secrets
import time
from typing import Any

from rich.console import Console
from rich.table import Table

from .fake_agent import FakeAgentConfig, start_fake_agent_thread


def run_quickstart_runtime(
    *,
    console: Console,
    base_url: str,
    api_key: str,
    project_name: str,
    host: str,
    reviewer_mode: str,
    tester_mode: str,
    tail_seconds: float,
    poll_interval_seconds: float,
) -> None:
    from zz_agent import ZZClient

    reviewer_secret = secrets.token_urlsafe(24)
    tester_secret = secrets.token_urlsafe(24)

    client = ZZClient(base_url=base_url, api_key=api_key)
    reviewer_server = None
    tester_server = None
    try:
        project = client.projects.create(
            name=project_name,
            description="Created by zz dev quickstart-runtime",
        )
        console.print(f"[green]created project[/green] {project.id} ({project.name})")

        reviewer_server, _ = start_fake_agent_thread(
            host,
            0,
            FakeAgentConfig(
                name="reviewer",
                mode=reviewer_mode,
                invoke_secret=reviewer_secret,
            ),
        )
        tester_server, _ = start_fake_agent_thread(
            host,
            0,
            FakeAgentConfig(
                name="tester",
                mode=tester_mode,
                invoke_secret=tester_secret,
            ),
        )

        reviewer_url = f"http://{host}:{reviewer_server.server_address[1]}/zz/v1/invoke"
        tester_url = f"http://{host}:{tester_server.server_address[1]}/zz/v1/invoke"
        console.print("[bold]Runtime demo agents[/bold]")
        console.print(f"  reviewer: {reviewer_url}")
        console.print(f"  tester:   {tester_url}")

        reviewer = client.agents.register(
            project_id=project.id,
            name="reviewer",
            endpoint_url=reviewer_url,
            invoke_secret=reviewer_secret,
            system_prompt="Review diffs and call out product or correctness risks.",
        )
        tester = client.agents.register(
            project_id=project.id,
            name="tester",
            endpoint_url=tester_url,
            invoke_secret=tester_secret,
            system_prompt="Design fast validation checks for the proposed change.",
        )
        console.print(f"[green]registered agents[/green] {reviewer.id}, {tester.id}")

        session = client.sessions.create(
            project_id=project.id,
            agent_ids=[reviewer.id, tester.id],
            title="V1 runtime quickstart",
        )
        session = _refresh_session_for_participants(client, session.id, session)
        console.print(f"[green]created shared session[/green] {session.id}")

        reviewer_participant_id = _agent_participant_id(session, reviewer.id)
        if reviewer_participant_id is None:
            reviewer_participant_id = reviewer.id
            console.print(
                "[yellow]could not find reviewer participant id; falling back to agent id[/yellow]"
            )

        broadcast = client.sessions.send(
            session_id=session.id,
            message="Review this tiny diff and suggest one fast validation.",
            visibility="session",
        )
        console.print(f"[green]broadcast sent[/green] {broadcast.id}")

        targeted = client.sessions.send(
            session_id=session.id,
            message="Reviewer only: focus on API contract risk.",
            recipient_participant_ids=[reviewer_participant_id],
            visibility="direct",
        )
        console.print(f"[green]targeted direct sent[/green] {targeted.id}")

        _tail_events(
            console=console,
            client=client,
            session_id=session.id,
            tail_seconds=tail_seconds,
            poll_interval_seconds=poll_interval_seconds,
        )

        health = client.health.get(project_id=project.id)
        console.print("[bold]health[/bold]")
        console.print_json(data=health.model_dump(mode="json"))
    finally:
        if reviewer_server is not None:
            reviewer_server.shutdown()
            reviewer_server.server_close()
        if tester_server is not None:
            tester_server.shutdown()
            tester_server.server_close()
        client.close()


def _refresh_session_for_participants(client: Any, session_id: str, session: Any) -> Any:
    if getattr(session, "participants", None):
        return session
    try:
        return client.sessions.get(session_id)
    except Exception:
        return session


def _agent_participant_id(session: Any, agent_id: str) -> str | None:
    mapping = getattr(session, "participant_ids_by_agent", None)
    if isinstance(mapping, dict) and isinstance(mapping.get(agent_id), str):
        return mapping[agent_id]

    participants = getattr(session, "participants", None) or []
    for participant in participants:
        participant_type = _field(participant, "participant_type")
        ref_id = _field(participant, "ref_id")
        status = _field(participant, "status") or "active"
        if participant_type == "agent" and ref_id == agent_id and status == "active":
            participant_id = _field(participant, "id")
            if isinstance(participant_id, str):
                return participant_id
    return None


def _field(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _tail_events(
    *,
    console: Console,
    client: Any,
    session_id: str,
    tail_seconds: float,
    poll_interval_seconds: float,
) -> None:
    console.print(f"[bold]tailing events for {tail_seconds:g}s[/bold]")
    table = Table(title="Session Timeline", title_style="bold")
    table.add_column("Seq", style="dim", no_wrap=True)
    table.add_column("Type", style="cyan")
    table.add_column("Summary")

    after_seq = 0
    seen = 0
    deadline = time.monotonic() + tail_seconds
    while time.monotonic() < deadline:
        events = client.sessions.events(session_id=session_id, after_seq=after_seq, limit=50)
        for event in events:
            after_seq = max(after_seq, int(getattr(event, "seq", 0) or 0))
            seen += 1
            table.add_row(
                str(getattr(event, "seq", "")),
                str(getattr(event, "type", "")),
                _event_summary(getattr(event, "payload", {}) or {}),
            )
        time.sleep(poll_interval_seconds)

    if seen == 0:
        console.print("[yellow]no events observed during tail window[/yellow]")
    else:
        console.print(table)


def _event_summary(payload: dict[str, Any]) -> str:
    for key in ("content", "message", "status", "error", "agent_id", "run_id"):
        value = payload.get(key)
        if value:
            text = value if isinstance(value, str) else str(value)
            return text[:96]
    return str(payload)[:96]
