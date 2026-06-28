"""Agent state helpers for local task context files.

Directory: ~/.zz/agent-state/
File naming: {task_id}.json

The task id is reduced to a single, safe filename segment before it is ever
joined onto the state directory, so a hostile or malformed id such as
``../escape`` can never traverse out of ``agent-state`` (see ``_sanitize_task_id``).
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Optional


def _get_agent_state_dir() -> str:
    override = os.environ.get("ZZ_HOME")
    if override:
        base = os.path.abspath(os.path.expanduser(override))
    else:
        base = os.path.join(os.path.expanduser("~"), ".zz")
    d = os.path.join(base, "agent-state")
    os.makedirs(d, exist_ok=True, mode=0o700)
    return d


def _sanitize_task_id(task_id: Any) -> str:
    """Return a safe, single-segment filename component for ``task_id``.

    Path separators, traversal fragments (``.``, ``..``), and control bytes are
    rejected so the value can never escape the ``agent-state`` directory. The
    caller-visible id is preserved verbatim when it is already a plain token
    (the normal case for backend-issued task ids).
    """
    if not isinstance(task_id, str):
        raise ValueError("task_id must be a string")
    name = task_id.strip()
    if not name:
        raise ValueError("task_id must not be empty")
    # A path separator is the only thing that can make os.path.join traverse.
    # Reject it outright rather than silently rewriting the id (which could
    # collide distinct task states).
    if "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError(f"unsafe task_id contains path/traversal characters: {task_id!r}")
    if any(ord(c) < 32 for c in name):
        raise ValueError(f"unsafe task_id contains control characters: {task_id!r}")
    return name


def _state_path(task_id: str) -> str:
    base = os.path.realpath(_get_agent_state_dir())
    name = _sanitize_task_id(task_id)
    path = os.path.join(base, f"{name}.json")
    # Defense in depth: guarantee the final path is still directly inside base.
    if os.path.dirname(path) != base:
        raise ValueError(f"task_id escapes agent-state directory: {task_id!r}")
    return path


def _write_task_state(item: Any) -> str:
    """Write a task state file from a watch output item (or any object with expected attrs).

    Returns the written file path.
    """
    task_id = getattr(item, "task_id", None)
    if not task_id:
        raise ValueError("item has no task_id")
    state = {
        "project_id": getattr(item, "project_id", None),
        "orchestration_id": getattr(item, "orchestration_id", None),
        "task_id": task_id,
        "agent_id": getattr(item, "agent_id", None),
        "inbox_id": getattr(item, "inbox_id", None),
        "title": getattr(item, "title", None),
        "goal": getattr(item, "goal", None),
        "status": getattr(item, "status", None) or "dispatched",
        "created_at": getattr(item, "created_at", None) or _iso_now(),
        "updated_at": _iso_now(),
    }
    # Only keep non-None values for optional fields to keep files compact
    path = _state_path(task_id)
    with open(path, "w") as f:
        json.dump(state, f, indent=2, default=str)
        f.write("\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _list_task_states() -> list[dict[str, Any]]:
    d = _get_agent_state_dir()
    states: list[dict[str, Any]] = []
    for fname in os.listdir(d):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(d, fname)
        try:
            with open(path, "r") as f:
                data = json.load(f)
            data["_path"] = path
            data["_mtime"] = os.path.getmtime(path)
            states.append(data)
        except Exception:
            continue
    states.sort(key=lambda s: s.get("created_at", "") or s.get("_mtime", 0), reverse=True)
    return states


def _get_task_state(task_id: str) -> dict[str, Any] | None:
    path = _state_path(task_id)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r") as f:
            return dict(json.load(f))
    except Exception:
        return None


def _update_task_state(task_id: str, patch: dict[str, Any]) -> None:
    state = _get_task_state(task_id) or {}
    state.update(patch)
    state["updated_at"] = _iso_now()
    path = _state_path(task_id)
    with open(path, "w") as f:
        json.dump(state, f, indent=2, default=str)
        f.write("\n")


def _find_next_dispatched_task() -> dict[str, Any] | None:
    for s in _list_task_states():
        if s.get("status") in ("dispatched", None):
            return s
    return None


def _find_current_running_task() -> dict[str, Any] | None:
    for s in _list_task_states():
        if s.get("status") == "running":
            return s
    return None
