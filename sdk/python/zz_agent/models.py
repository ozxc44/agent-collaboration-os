from __future__ import annotations

import enum
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ZZModel(BaseModel):
    """Base model that tolerates additive API fields during V1 iteration."""

    model_config = ConfigDict(extra="allow")


class EventType(str, enum.Enum):
    """All event types in the append-only event stream."""

    MESSAGE_CREATED = "message.created"
    SESSION_CREATED = "session.created"
    AGENT_JOINED = "agent.joined"
    SESSION_ENDED = "session.ended"
    AGENT_RUN_QUEUED = "agent.run.queued"
    AGENT_RUN_STARTED = "agent.run.started"
    AGENT_RUN_COMPLETED = "agent.run.completed"
    AGENT_RUN_FAILED = "agent.run.failed"
    HEALTH_METRIC = "health.metric"
    ERROR_OCCURRED = "error.occurred"
    HEALTH_DEGRADED = "health.degraded"
    HEALTH_RESOLVED = "health.resolved"
    PROJECT_MEMBER_ADDED = "project.member_added"
    PROJECT_MEMBER_REMOVED = "project.member_removed"


class EventEnvelope(ZZModel):
    """Envelope wrapping every event in the append-only session event log.

    Events carry a monotonically increasing ``seq`` (per session) and are
    streamed via SSE or forwarded via webhook.
    """

    seq: int = Field(default=0, description="Monotonically increasing sequence number within the session")
    type: EventType | str
    session_id: Optional[str] = None
    project_id: Optional[str] = None
    payload: dict[str, Any] = Field(description="Event-specific payload data")
    timestamp: Optional[datetime] = Field(default=None, description="ISO8601 timestamp of the event")


class Message(ZZModel):
    """A message within a session."""

    id: str = ""
    role: str = "user"  # user | agent | system
    content: str = ""
    session_id: str = ""
    sender_participant_id: Optional[str] = None
    recipient_participant_ids: list[str] = Field(default_factory=list)
    visibility: str = "session"
    agent_id: Optional[str] = None
    created_at: Optional[datetime] = None


class SessionParticipant(ZZModel):
    """A user or agent address inside a shared session."""

    id: str = ""
    session_id: Optional[str] = None
    participant_type: str = ""  # user | agent
    ref_id: str = ""
    role: str = "member"
    status: str = "active"
    joined_at: Optional[datetime] = None


class Session(ZZModel):
    """A shared session within a project."""

    id: str = ""
    project_id: str = ""
    agent_ids: list[str] = Field(default_factory=list)
    participants: list[SessionParticipant] = Field(default_factory=list)
    title: Optional[str] = None
    status: str = "active"  # active | closed
    last_seq: int = 0
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class Agent(ZZModel):
    """An agent registered in a project."""

    id: str = ""
    project_id: str = ""
    name: str = ""
    system_prompt: Optional[str] = None
    endpoint_url: Optional[str] = None
    api_key: Optional[str] = None
    api_key_prefix: Optional[str] = None
    status: str = "unknown"  # offline | idle | running | error | healthy | degraded
    created_at: Optional[datetime] = None


class Project(ZZModel):
    """A project space for multi-agent collaboration."""

    id: str = ""
    name: str = ""
    description: Optional[str] = None
    owner_id: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class HealthStatus(ZZModel):
    """Health status summary for a project."""

    project_id: Optional[str] = None
    agent_id: Optional[str] = None
    status: str = "unknown"  # healthy | degraded | down
    last_check: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    metrics: dict[str, float] | list[dict[str, Any]] = Field(default_factory=dict)
    agents: list[dict[str, Any]] = Field(default_factory=list)


class Incident(ZZModel):
    """A health incident for a project."""

    id: str
    project_id: str
    type: str  # agent_down | high_failure_rate | slow_reply | tool_timeout | event_lag | manual
    severity: str  # low | medium | high | critical
    status: str  # open | investigating | resolved
    details: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    resolved_at: Optional[datetime] = None


class TokenResponse(ZZModel):
    """Response from the token endpoint."""

    access_token: str
    token_type: str = "bearer"
    expires_at: datetime


class User(ZZModel):
    """A platform user."""

    id: str
    username: str
    display_name: Optional[str] = None
    created_at: datetime


class Member(ZZModel):
    """A project member."""

    user_id: str
    role: str  # owner | admin | member | viewer
    joined_at: datetime


class ProjectFile(ZZModel):
    """A file within a project space."""

    id: str = ""
    project_id: str = ""
    path: str = ""
    content: str = ""
    content_type: str = "text/markdown"
    content_hash: str = ""
    size_bytes: int = 0
    current_revision_id: Optional[str] = None
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ProjectFileSummary(ZZModel):
    """Summary of a project file without full content."""

    id: str = ""
    project_id: str = ""
    path: str = ""
    content_type: str = "text/markdown"
    content_hash: str = ""
    size_bytes: int = 0
    current_revision_id: Optional[str] = None
    updated_by: Optional[str] = None
    updated_at: Optional[datetime] = None


class ProjectFileRevision(ZZModel):
    """A revision of a project file."""

    id: str = ""
    project_id: str = ""
    file_id: str = ""
    path: str = ""
    revision_number: int = 1
    content: str = ""
    content_type: str = "text/markdown"
    content_hash: str = ""
    message: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[datetime] = None


class ProjectMemory(ZZModel):
    """A memory entry in a project space."""

    id: str = ""
    project_id: str = ""
    agent_id: Optional[str] = None
    author_user_id: Optional[str] = None
    content: str = ""
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    visibility: str = "project"  # project | agent
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ProjectJoinRequest(ZZModel):
    """A request to join a project."""

    id: str = ""
    project_id: str = ""
    user_id: str = ""
    user_email: Optional[str] = None
    user_display_name: Optional[str] = None
    status: str = "pending"  # pending | approved | rejected | cancelled
    requested_role: str = "member"  # member | viewer
    note: Optional[str] = None
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ProjectFileProposal(ZZModel):
    """A proposal to change a project file (agent-authored, user-reviewed)."""

    id: str = ""
    project_id: str = ""
    file_id: Optional[str] = None
    path: str = ""
    proposed_content: str = ""
    content_type: str = "text/markdown"
    content_hash: str = ""
    base_revision_id: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    status: str = "pending"  # pending | approved | rejected
    created_by_user_id: Optional[str] = None
    created_by_agent_id: Optional[str] = None
    reviewed_by: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    review_message: Optional[str] = None
    merged_revision_id: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


# ─── Agent Runtime Models ────────────────────────────────────────────────────


class AgentProjectDiscovery(ZZModel):
    """Project discovery entry for an authenticated agent."""

    project: Project
    agent: Agent
    role: str = "agent"


class AgentProjectDiscoveryList(ZZModel):
    """List of project discovery entries."""

    data: list[AgentProjectDiscovery] = Field(default_factory=list)


class InboxItem(ZZModel):
    """A durable inbox item delivered to an agent."""

    id: str = ""
    project_id: Optional[str] = None
    recipient_agent_id: Optional[str] = None
    orchestration_id: Optional[str] = None
    task_id: Optional[str] = None
    event_type: str = ""
    title: Optional[str] = None
    body: Optional[str] = None
    payload: dict[str, Any] = Field(default_factory=dict)
    status: str = "unread"  # unread | read | acked
    read_at: Optional[datetime] = None
    acked_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @field_validator("payload", mode="before")
    @classmethod
    def coerce_payload(cls, v: Any) -> Any:
        """Normalize null payload to empty dict so production items parse."""
        if v is None:
            return {}
        return v


class InboxMeta(ZZModel):
    """Metadata for an inbox query response."""

    total: int = 0
    limit: int = 50
    unread_count: int = 0


class InboxList(ZZModel):
    """Paginated inbox response."""

    data: list[InboxItem] = Field(default_factory=list)
    meta: InboxMeta = Field(default_factory=InboxMeta)


class WorkloadSummary(ZZModel):
    """Summary of an agent's workload."""

    total_units: int = 0
    completed_units: int = 0
    total_work: float = 0.0


class WorkloadUnit(ZZModel):
    """A single unit of work in the agent's recent history."""

    id: str = ""
    project_id: Optional[str] = None
    orchestration_id: Optional[str] = None
    task_id: Optional[str] = None
    source_event: Optional[str] = None
    status: str = ""
    review_decision: Optional[str] = None
    metrics: dict[str, Any] = Field(default_factory=dict)
    normalized_work_units: Optional[float] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    reviewed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None


class Workload(ZZModel):
    """Agent workload response."""

    summary: WorkloadSummary = Field(default_factory=WorkloadSummary)
    recent: list[WorkloadUnit] = Field(default_factory=list)


class HeartbeatResponse(ZZModel):
    """Response from the agent heartbeat endpoint."""

    ok: bool = True
    agent_id: Optional[str] = None
    status: str = ""
    agent_status: Optional[str] = None
    presence: Optional[str] = None
    is_online: Optional[bool] = None
    dispatchable: Optional[bool] = None
    last_heartbeat_at: Optional[datetime] = None
    heartbeat_age_ms: Optional[int] = None
    next_heartbeat_at: Optional[datetime] = None
    pending_inbox_count: int = 0


class WatchOutputItem(ZZModel):
    """Normalized actionable item emitted by the agent watch loop."""

    inbox_id: str
    event_type: str
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    task_id: Optional[str] = None
    orchestration_id: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    required_action: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: Optional[datetime] = None


class WatchResult(ZZModel):
    """Result of a single watch iteration."""

    heartbeat: HeartbeatResponse = Field(default_factory=HeartbeatResponse)
    items: list[WatchOutputItem] = Field(default_factory=list)
    acked: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


# ─── Orchestration Models ────────────────────────────────────────────────────


class OrchestrationPaths(ZZModel):
    """File paths for an orchestration."""

    goal: str = ""
    plan: str = ""
    tasks: str = ""
    pm_review: str = ""
    workers: str = ""


class Orchestration(ZZModel):
    """A project orchestration managed by a main agent."""

    id: str = ""
    project_id: str = ""
    title: str = ""
    objective: str = ""
    status: str = ""
    base_path: str = ""
    session_id: Optional[str] = None
    main_agent_id: Optional[str] = None
    created_by_user_id: Optional[str] = None
    created_by_agent_id: Optional[str] = None
    acceptance_criteria: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    paths: OrchestrationPaths = Field(default_factory=OrchestrationPaths)
    completed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    tasks: Optional[list[dict[str, Any]]] = None


class OrchestrationTask(ZZModel):
    """A task within an orchestration."""

    id: str = ""
    project_id: str = ""
    orchestration_id: str = ""
    title: str = ""
    goal: str = ""
    status: str = ""
    assigned_agent_id: Optional[str] = None
    worker_task_path: str = ""
    worker_context_path: str = ""
    result_path: Optional[str] = None
    evidence_path: Optional[str] = None
    acceptance_criteria: list[str] = Field(default_factory=list)
    depends_on: list[str] = Field(default_factory=list)
    review_notes: Optional[str] = None
    requested_changes: Optional[str] = None
    created_by_user_id: Optional[str] = None
    created_by_agent_id: Optional[str] = None
    completed_at: Optional[datetime] = None
    reviewed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


# ─── Changeset Models ────────────────────────────────────────────────────────


class ChangesetFileOp(ZZModel):
    """A file operation within a changeset."""

    op: str = "upsert"
    path: str = ""
    content: str = ""
    content_type: str = "text/markdown"
    base_revision_id: Optional[str] = None


class Changeset(ZZModel):
    """A project changeset for version-controlled file edits."""

    id: str = ""
    project_id: str = ""
    branch_id: str = ""
    base_commit_id: Optional[str] = None
    title: str = ""
    description: Optional[str] = None
    status: str = ""
    file_ops: list[ChangesetFileOp] = Field(default_factory=list)
    conflicts: Optional[list[dict[str, Any]]] = None
    result_path: Optional[str] = None
    evidence_path: Optional[str] = None
    created_by_user_id: Optional[str] = None
    created_by_agent_id: Optional[str] = None
    reviewed_by_user_id: Optional[str] = None
    reviewed_by_agent_id: Optional[str] = None
    review_notes: Optional[str] = None
    merged_commit_id: Optional[str] = None
    orchestration_id: Optional[str] = None
    task_id: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    merged_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ProjectCommit(ZZModel):
    """A commit in a project's version history."""

    id: str = ""
    project_id: str = ""
    branch_id: str = ""
    parent_commit_id: Optional[str] = None
    message: Optional[str] = None
    changed_files: list[dict[str, Any]] = Field(default_factory=list)
    changeset_id: Optional[str] = None
    snapshot: dict[str, Any] = Field(default_factory=dict)
    orchestration_id: Optional[str] = None
    task_id: Optional[str] = None
    created_by_user_id: Optional[str] = None
    created_by_agent_id: Optional[str] = None
    created_at: Optional[datetime] = None
    # Real git commit SHA (40-hex) from the isomorphic-git backend. Populated on
    # merge when the changeset is committed to the project's true git repo. Null
    # for commits created before the git backend existed.
    git_sha: Optional[str] = None


class GitLogEntry(ZZModel):
    """One real git commit from the project's isomorphic-git repo."""

    sha: str = ""
    message: Optional[str] = None
    author: dict[str, Any] = Field(default_factory=dict)
    committer: dict[str, Any] = Field(default_factory=dict)
    parents: list[str] = Field(default_factory=list)
    timestamp: Optional[int] = None


class GitLog(ZZModel):
    """Result of GET /v1/projects/:pid/git/log — the project's real git history."""

    backend: str = "isomorphic-git"
    head: Optional[str] = None
    data: list[GitLogEntry] = Field(default_factory=list)
