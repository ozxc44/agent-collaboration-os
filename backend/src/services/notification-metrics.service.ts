import { AppDataSource } from '../data-source';
import { Agent } from '../entities/agent.entity';
import { AgentInboxItem, InboxItemStatus } from '../entities/agent-inbox-item.entity';
import { ProjectOrchestrationTask, ProjectOrchestrationTaskStatus } from '../entities/project-orchestration-task.entity';
import { getAgentPresence } from './agent-presence.service';

export interface AgentMetrics {
  agent_id: string;
  agent_name: string;
  presence: 'online' | 'stale' | 'offline';
  last_heartbeat_at: string | null;
  pending_inbox_count: number;
  pending_by_type: PendingByType[];
  oldest_unacked_age_seconds: number | null;
}

export interface PendingByType {
  event_type: string;
  count: number;
}

export interface TtftPhaseTimestamps {
  dispatched_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  reviewed_at: string | null;
}

export interface NotificationMetricsSummary {
  total_agents: number;
  online_count: number;
  stale_count: number;
  offline_count: number;
  pending_inbox_total: number;
  oldest_unacked_age_seconds: number | null;
  ack_latency_p50_seconds: number | null;
  ack_latency_p95_seconds: number | null;
  ack_latency_max_seconds: number | null;
  ack_latency_sla_pass: boolean;
  task_review_latency_p50_seconds: number | null;
  task_review_latency_p95_seconds: number | null;
  task_review_latency_max_seconds: number | null;
  task_review_latency_sla_pass: boolean;
  waiting_review_count: number;
  blocked_task_count: number;
  time_to_first_reviewed_task_ms: number | null;
  ttft_task_id: string | null;
  ttft_phases: TtftPhaseTimestamps | null;
}

export interface NotificationMetrics {
  project_id: string;
  agents: AgentMetrics[];
  summary: NotificationMetricsSummary;
}

async function getInboxMetrics(projectId: string): Promise<{
  pendingByAgent: Map<string, number>;
  pendingByTypeByAgent: Map<string, PendingByType[]>;
  oldestUnackedByAgent: Map<string, number | null>;
  globalOldestUnacked: number | null;
  ackLatencies: number[];
}> {
  const inboxRepo = AppDataSource.getRepository(AgentInboxItem);

  // Pending (unread or read, not acked) inbox items by agent
  const pendingRows = await inboxRepo
    .createQueryBuilder('item')
    .select('item.recipientAgentId', 'agent_id')
    .addSelect('COUNT(*)', 'count')
    .where('item.projectId = :projectId', { projectId })
    .andWhere('item.status != :acked', { acked: InboxItemStatus.ACKED })
    .groupBy('item.recipientAgentId')
    .getRawMany();

  const pendingByAgent = new Map<string, number>();
  for (const row of pendingRows) {
    pendingByAgent.set(row.agent_id, Number(row.count));
  }

  // Pending by type (event_type) per agent
  const typeRows = await inboxRepo
    .createQueryBuilder('item')
    .select('item.recipientAgentId', 'agent_id')
    .addSelect('item.eventType', 'event_type')
    .addSelect('COUNT(*)', 'count')
    .where('item.projectId = :projectId', { projectId })
    .andWhere('item.status != :acked', { acked: InboxItemStatus.ACKED })
    .groupBy('item.recipientAgentId')
    .addGroupBy('item.eventType')
    .getRawMany();

  const pendingByTypeByAgent = new Map<string, PendingByType[]>();
  for (const row of typeRows) {
    const list = pendingByTypeByAgent.get(row.agent_id) ?? [];
    list.push({ event_type: row.event_type, count: Number(row.count) });
    pendingByTypeByAgent.set(row.agent_id, list);
  }

  // Oldest unacked age per agent
  const now = Date.now();
  const oldestRows = await inboxRepo
    .createQueryBuilder('item')
    .select('item.recipientAgentId', 'agent_id')
    .addSelect('MIN(item.createdAt)', 'oldest_created')
    .where('item.projectId = :projectId', { projectId })
    .andWhere('item.status != :acked', { acked: InboxItemStatus.ACKED })
    .groupBy('item.recipientAgentId')
    .getRawMany();

  const oldestUnackedByAgent = new Map<string, number | null>();
  let globalOldestUnacked: number | null = null;
  for (const row of oldestRows) {
    if (row.oldest_created) {
      const ageSeconds = (now - new Date(row.oldest_created).getTime()) / 1000;
      oldestUnackedByAgent.set(row.agent_id, ageSeconds);
      if (globalOldestUnacked === null || ageSeconds > globalOldestUnacked) {
        globalOldestUnacked = ageSeconds;
      }
    } else {
      oldestUnackedByAgent.set(row.agent_id, null);
    }
  }

  // Ack latencies: for acked items, compute acked_at - created_at in seconds
  const ackedRows = await inboxRepo
    .createQueryBuilder('item')
    .select('item.createdAt', 'created_at')
    .addSelect('item.ackedAt', 'acked_at')
    .where('item.projectId = :projectId', { projectId })
    .andWhere('item.status = :acked', { acked: InboxItemStatus.ACKED })
    .andWhere('item.ackedAt IS NOT NULL')
    .getRawMany();

  const ackLatencies: number[] = [];
  for (const row of ackedRows) {
    if (row.created_at && row.acked_at) {
      const latency = (new Date(row.acked_at).getTime() - new Date(row.created_at).getTime()) / 1000;
      if (latency >= 0) {
        ackLatencies.push(latency);
      }
    }
  }
  ackLatencies.sort((a, b) => a - b);

  return { pendingByAgent, pendingByTypeByAgent, oldestUnackedByAgent, globalOldestUnacked, ackLatencies };
}

async function getTaskReviewMetrics(projectId: string): Promise<number[]> {
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
  const rows = await taskRepo
    .createQueryBuilder('task')
    .select('task.completedAt', 'completed_at')
    .addSelect('task.reviewedAt', 'reviewed_at')
    .where('task.projectId = :projectId', { projectId })
    .andWhere('task.completedAt IS NOT NULL')
    .andWhere('task.reviewedAt IS NOT NULL')
    .andWhere('task.status IN (:...statuses)', {
      statuses: [ProjectOrchestrationTaskStatus.APPROVED, ProjectOrchestrationTaskStatus.CHANGES_REQUESTED],
    })
    .getRawMany();

  const latencies: number[] = [];
  for (const row of rows) {
    if (row.completed_at && row.reviewed_at) {
      const latency = (new Date(row.reviewed_at).getTime() - new Date(row.completed_at).getTime()) / 1000;
      if (latency >= 0) {
        latencies.push(latency);
      }
    }
  }
  latencies.sort((a, b) => a - b);
  return latencies;
}

async function getTtftMetric(projectId: string): Promise<{
  time_to_first_reviewed_task_ms: number | null;
  ttft_task_id: string | null;
  ttft_phases: TtftPhaseTimestamps | null;
}> {
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
  // Find the earliest reviewed task in the project that has a dispatch timestamp or createdAt
  const task = await taskRepo
    .createQueryBuilder('task')
    .where('task.projectId = :projectId', { projectId })
    .andWhere('task.reviewedAt IS NOT NULL')
    .andWhere('task.status IN (:...statuses)', {
      statuses: [ProjectOrchestrationTaskStatus.APPROVED, ProjectOrchestrationTaskStatus.CHANGES_REQUESTED],
    })
    .orderBy('task.reviewedAt', 'ASC')
    .getOne();

  if (!task) {
    return {
      time_to_first_reviewed_task_ms: null,
      ttft_task_id: null,
      ttft_phases: null,
    };
  }

  // Dispatch time: prefer dispatchedAt, fall back to createdAt
  const dispatchTime = task.dispatchedAt ?? task.createdAt;
  if (!dispatchTime || !task.reviewedAt) {
    return {
      time_to_first_reviewed_task_ms: null,
      ttft_task_id: task.id,
      ttft_phases: null,
    };
  }

  const ttftMs = task.reviewedAt.getTime() - dispatchTime.getTime();
  return {
    time_to_first_reviewed_task_ms: ttftMs >= 0 ? ttftMs : null,
    ttft_task_id: task.id,
    ttft_phases: {
      dispatched_at: dispatchTime.toISOString(),
      claimed_at: task.claimedAt?.toISOString() ?? null,
      completed_at: task.completedAt?.toISOString() ?? null,
      reviewed_at: task.reviewedAt.toISOString(),
    },
  };
}

async function getWorkloadIndicators(projectId: string): Promise<{ waitingReview: number; blocked: number }> {
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);
  const rows = await taskRepo
    .createQueryBuilder('task')
    .select('task.status', 'status')
    .addSelect('COUNT(*)', 'count')
    .where('task.projectId = :projectId', { projectId })
    .andWhere('task.status IN (:...statuses)', {
      statuses: [ProjectOrchestrationTaskStatus.READY_FOR_REVIEW, ProjectOrchestrationTaskStatus.BLOCKED],
    })
    .groupBy('task.status')
    .getRawMany();

  let waitingReview = 0;
  let blocked = 0;
  for (const row of rows) {
    if (row.status === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW) waitingReview = Number(row.count);
    if (row.status === ProjectOrchestrationTaskStatus.BLOCKED) blocked = Number(row.count);
  }
  return { waitingReview, blocked };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export async function getProjectNotificationMetrics(projectId: string): Promise<NotificationMetrics> {
  const agentRepo = AppDataSource.getRepository(Agent);
  const agents = await agentRepo.find({
    where: { projectId },
    order: { name: 'ASC' },
  });

  const [inboxMetrics, reviewLatencies, workloadIndicators, ttft] = await Promise.all([
    getInboxMetrics(projectId),
    getTaskReviewMetrics(projectId),
    getWorkloadIndicators(projectId),
    getTtftMetric(projectId),
  ]);

  let onlineCount = 0;
  let staleCount = 0;
  let offlineCount = 0;
  let pendingTotal = 0;

  const agentMetricsList: AgentMetrics[] = agents.map((agent) => {
    const presence = getAgentPresence(agent);
    const pendingCount = inboxMetrics.pendingByAgent.get(agent.id) ?? 0;
    pendingTotal += pendingCount;

    if (presence.presence === 'online') onlineCount++;
    else if (presence.presence === 'stale') staleCount++;
    else offlineCount++;

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      presence: presence.presence,
      last_heartbeat_at: presence.lastHeartbeatAt?.toISOString() ?? null,
      pending_inbox_count: pendingCount,
      pending_by_type: inboxMetrics.pendingByTypeByAgent.get(agent.id) ?? [],
      oldest_unacked_age_seconds: inboxMetrics.oldestUnackedByAgent.get(agent.id) ?? null,
    };
  });

  const ackLatencyMax = inboxMetrics.ackLatencies.length > 0 ? inboxMetrics.ackLatencies[inboxMetrics.ackLatencies.length - 1] : null;
  const ackP95 = percentile(inboxMetrics.ackLatencies, 95);
  const reviewLatencyMax = reviewLatencies.length > 0 ? reviewLatencies[reviewLatencies.length - 1] : null;
  const reviewP95 = percentile(reviewLatencies, 95);

  const summary: NotificationMetricsSummary = {
    total_agents: agents.length,
    online_count: onlineCount,
    stale_count: staleCount,
    offline_count: offlineCount,
    pending_inbox_total: pendingTotal,
    oldest_unacked_age_seconds: inboxMetrics.globalOldestUnacked,
    ack_latency_p50_seconds: percentile(inboxMetrics.ackLatencies, 50),
    ack_latency_p95_seconds: ackP95,
    ack_latency_max_seconds: ackLatencyMax,
    ack_latency_sla_pass: ackP95 !== null && ackP95 < 45,
    task_review_latency_p50_seconds: percentile(reviewLatencies, 50),
    task_review_latency_p95_seconds: reviewP95,
    task_review_latency_max_seconds: reviewLatencyMax,
    task_review_latency_sla_pass: reviewP95 !== null && reviewP95 < 90,
    waiting_review_count: workloadIndicators.waitingReview,
    blocked_task_count: workloadIndicators.blocked,
    time_to_first_reviewed_task_ms: ttft.time_to_first_reviewed_task_ms,
    ttft_task_id: ttft.ttft_task_id,
    ttft_phases: ttft.ttft_phases,
  };

  return {
    project_id: projectId,
    agents: agentMetricsList,
    summary,
  };
}

export async function getAdminNotificationMetrics(userId: string): Promise<{ projects: NotificationMetrics[]; aggregate: NotificationMetricsSummary }> {
  const { ProjectMember, ProjectRole } = await import('../entities/project-member.entity');
  const memberRepo = AppDataSource.getRepository(ProjectMember);

  const memberships = await memberRepo.find({
    where: [
      { userId, role: ProjectRole.OWNER },
      { userId, role: ProjectRole.ADMIN },
    ],
  });

  const projectIds = [...new Set(memberships.map((m) => m.projectId))];
  const allMetrics = await Promise.all(
    projectIds.map((pid) => getProjectNotificationMetrics(pid)),
  );

  const aggregate: NotificationMetricsSummary = {
    total_agents: 0,
    online_count: 0,
    stale_count: 0,
    offline_count: 0,
    pending_inbox_total: 0,
    oldest_unacked_age_seconds: null,
    ack_latency_p50_seconds: null,
    ack_latency_p95_seconds: null,
    ack_latency_max_seconds: null,
    ack_latency_sla_pass: false,
    task_review_latency_p50_seconds: null,
    task_review_latency_p95_seconds: null,
    task_review_latency_max_seconds: null,
    task_review_latency_sla_pass: false,
    waiting_review_count: 0,
    blocked_task_count: 0,
    time_to_first_reviewed_task_ms: null,
    ttft_task_id: null,
    ttft_phases: null,
  };

  const allAckLatencies: number[] = [];
  const allReviewLatencies: number[] = [];

  for (const m of allMetrics) {
    aggregate.total_agents += m.summary.total_agents;
    aggregate.online_count += m.summary.online_count;
    aggregate.stale_count += m.summary.stale_count;
    aggregate.offline_count += m.summary.offline_count;
    aggregate.pending_inbox_total += m.summary.pending_inbox_total;
    aggregate.waiting_review_count += m.summary.waiting_review_count;
    aggregate.blocked_task_count += m.summary.blocked_task_count;

    if (m.summary.oldest_unacked_age_seconds !== null) {
      if (aggregate.oldest_unacked_age_seconds === null ||
          m.summary.oldest_unacked_age_seconds > aggregate.oldest_unacked_age_seconds) {
        aggregate.oldest_unacked_age_seconds = m.summary.oldest_unacked_age_seconds;
      }
    }
    if (m.summary.ack_latency_max_seconds !== null) {
      if (aggregate.ack_latency_max_seconds === null ||
          m.summary.ack_latency_max_seconds > aggregate.ack_latency_max_seconds) {
        aggregate.ack_latency_max_seconds = m.summary.ack_latency_max_seconds;
      }
    }
    if (m.summary.task_review_latency_max_seconds !== null) {
      if (aggregate.task_review_latency_max_seconds === null ||
          m.summary.task_review_latency_max_seconds > aggregate.task_review_latency_max_seconds) {
        aggregate.task_review_latency_max_seconds = m.summary.task_review_latency_max_seconds;
      }
    }
    if (m.summary.ack_latency_p50_seconds !== null) allAckLatencies.push(m.summary.ack_latency_p50_seconds, m.summary.ack_latency_p95_seconds ?? 0);
    if (m.summary.task_review_latency_p50_seconds !== null) allReviewLatencies.push(m.summary.task_review_latency_p50_seconds, m.summary.task_review_latency_p95_seconds ?? 0);

    // TTFT aggregate: pick the earliest (smallest) TTFT across projects
    if (m.summary.time_to_first_reviewed_task_ms !== null) {
      if (aggregate.time_to_first_reviewed_task_ms === null ||
          m.summary.time_to_first_reviewed_task_ms < aggregate.time_to_first_reviewed_task_ms) {
        aggregate.time_to_first_reviewed_task_ms = m.summary.time_to_first_reviewed_task_ms;
        aggregate.ttft_task_id = m.summary.ttft_task_id;
        aggregate.ttft_phases = m.summary.ttft_phases;
      }
    }
  }

  // Recompute percentiles across all projects from raw data
  // For admin aggregate, use the per-project medians as a coarse estimate
  if (allAckLatencies.length > 0) {
    allAckLatencies.sort((a, b) => a - b);
    aggregate.ack_latency_p50_seconds = percentile(allAckLatencies, 50);
    aggregate.ack_latency_p95_seconds = percentile(allAckLatencies, 95);
  }
  if (allReviewLatencies.length > 0) {
    allReviewLatencies.sort((a, b) => a - b);
    aggregate.task_review_latency_p50_seconds = percentile(allReviewLatencies, 50);
    aggregate.task_review_latency_p95_seconds = percentile(allReviewLatencies, 95);
  }

  // Aggregate SLA: pass if we have data AND p95 meets target
  if (aggregate.ack_latency_p95_seconds !== null) {
    aggregate.ack_latency_sla_pass = aggregate.ack_latency_p95_seconds < 45;
  }
  if (aggregate.task_review_latency_p95_seconds !== null) {
    aggregate.task_review_latency_sla_pass = aggregate.task_review_latency_p95_seconds < 90;
  }

  return { projects: allMetrics, aggregate };
}
