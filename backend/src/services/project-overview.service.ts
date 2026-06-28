import { AppDataSource } from '../data-source';
import { Agent, AgentStatus, AgentLifecycleStatus } from '../entities/agent.entity';
import { Project } from '../entities/project.entity';
import { ProjectOrchestration, ProjectOrchestrationStatus } from '../entities/project-orchestration.entity';
import {
  ProjectOrchestrationTask,
  ProjectOrchestrationTaskStatus,
} from '../entities/project-orchestration-task.entity';
import { ProjectFile } from '../entities/project-file.entity';
import { AgentInboxItem, InboxItemStatus } from '../entities/agent-inbox-item.entity';
import { AgentWorkUnit, WorkUnitStatus } from '../entities/agent-work-unit.entity';
import { HealthMetric } from '../entities/health-metric.entity';
import { getAgentPresence } from './agent-presence.service';
import { Brackets } from 'typeorm';

export interface ProjectOverviewOptions {
  agentId?: string | null;
  limits?: {
    attention?: number;
    recentOrchestrations?: number;
    recentFiles?: number;
    recentHealthSignals?: number;
  };
}

export interface ProjectOverview {
  project: {
    id: string;
    name: string;
    description: string | null;
    visibility: string;
    status: string;
    topics: string[];
  };
  summary: {
    agents: {
      total: number;
      online: number;
      stale: number;
      offline: number;
    };
    orchestrations: Record<string, number> & { total: number };
    tasks: Record<string, number> & {
      total: number;
      open_work: number;
      ready_for_review: number;
      blocked_failed: number;
    };
    files: {
      total_count: number;
      recent_count: number;
    };
    inbox: {
      pending_total: number;
      unacked_total: number;
    };
  };
  attention: {
    ready_for_review: TaskAttentionItem[];
    blocked_failed: TaskAttentionItem[];
    stale_inbox: InboxAttentionItem[];
  };
  recent: {
    orchestrations: RecentOrchestrationItem[];
    files: RecentFileItem[];
  };
  workload: {
    total_units: number;
    reviewed_units: number;
    total_final_work_units: number;
  };
  health: {
    signals: HealthSignalItem[];
  };
  generated_at: string;
}

interface TaskAttentionItem {
  task_id: string;
  orchestration_id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
  updated_at: string;
}

interface InboxAttentionItem {
  inbox_id: string;
  recipient_agent_id: string;
  event_type: string;
  title: string;
  status: string;
  age_seconds: number;
}

interface RecentOrchestrationItem {
  id: string;
  title: string;
  status: string;
  main_agent_id: string | null;
  task_count: number;
  created_at: string;
  updated_at: string;
}

interface RecentFileItem {
  file_id: string;
  path: string;
  content_type: string;
  size_bytes: number;
  updated_by: string;
  updated_at: string;
}

interface HealthSignalItem {
  signal_id: string;
  agent_id: string | null;
  name: string;
  value: number;
  unit: string | null;
  status: string | null;
  recorded_at: string;
}

const DEFAULT_LIMITS = {
  attention: 5,
  recentOrchestrations: 5,
  recentFiles: 10,
  recentHealthSignals: 5,
};

const TASK_OPEN_WORK_STATUSES = new Set([
  ProjectOrchestrationTaskStatus.PENDING,
  ProjectOrchestrationTaskStatus.DISPATCHED,
  ProjectOrchestrationTaskStatus.RUNNING,
  ProjectOrchestrationTaskStatus.CHANGES_REQUESTED,
]);

const TASK_BLOCKED_FAILED_STATUSES = new Set([
  ProjectOrchestrationTaskStatus.BLOCKED,
  ProjectOrchestrationTaskStatus.FAILED,
]);

const STALE_INBOX_SECONDS = 5 * 60;

export async function buildProjectOverview(
  projectId: string,
  options: ProjectOverviewOptions = {},
): Promise<ProjectOverview> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const agentId = options.agentId ?? null;

  const projectRepo = AppDataSource.getRepository(Project);
  const project = await projectRepo.findOne({ where: { id: projectId } });
  if (!project) {
    throw new ProjectNotFoundError();
  }

  const visibleOrchestrationIds = agentId
    ? await getVisibleOrchestrationIds(projectId, agentId)
    : null;

  const [
    agentSummary,
    orchestrationSummary,
    taskSummary,
    fileSummary,
    inboxSummary,
    attention,
    recentOrchestrations,
    recentFiles,
    workloadSummary,
    healthSignals,
  ] = await Promise.all([
    getAgentSummary(projectId),
    getOrchestrationSummary(projectId, visibleOrchestrationIds),
    getTaskSummary(projectId, visibleOrchestrationIds, agentId),
    getFileSummary(projectId, visibleOrchestrationIds, agentId),
    getInboxSummary(projectId, agentId),
    getAttention(projectId, visibleOrchestrationIds, agentId, limits.attention),
    getRecentOrchestrations(projectId, visibleOrchestrationIds, limits.recentOrchestrations),
    getRecentFiles(projectId, visibleOrchestrationIds, agentId, limits.recentFiles),
    getWorkloadSummary(projectId),
    getRecentHealthSignals(projectId, limits.recentHealthSignals),
  ]);

  return {
    project: {
      id: project.id,
      name: project.name,
      description: project.description ?? null,
      visibility: project.visibility,
      status: project.status ?? 'active',
      topics: project.topics ?? [],
    },
    summary: {
      agents: agentSummary,
      orchestrations: orchestrationSummary,
      tasks: taskSummary,
      files: fileSummary,
      inbox: inboxSummary,
    },
    attention,
    recent: {
      orchestrations: recentOrchestrations,
      files: recentFiles,
    },
    workload: workloadSummary,
    health: {
      signals: healthSignals,
    },
    generated_at: new Date().toISOString(),
  };
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found');
  }
}

async function getVisibleOrchestrationIds(
  projectId: string,
  agentId: string,
): Promise<Set<string>> {
  const orchestrationRepo = AppDataSource.getRepository(ProjectOrchestration);
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);

  const [asMain, asWorker] = await Promise.all([
    orchestrationRepo
      .createQueryBuilder('o')
      .select('o.id', 'id')
      .where('o.projectId = :projectId', { projectId })
      .andWhere('o.mainAgentId = :agentId', { agentId })
      .getRawMany(),
    taskRepo
      .createQueryBuilder('t')
      .select('DISTINCT t.orchestrationId', 'id')
      .where('t.projectId = :projectId', { projectId })
      .andWhere('t.assignedAgentId = :agentId', { agentId })
      .getRawMany(),
  ]);

  return new Set([...asMain, ...asWorker].map((row: any) => row.id));
}

async function getAgentSummary(projectId: string): Promise<{ total: number; online: number; stale: number; offline: number }> {
  // Agents are loaded row-by-row rather than aggregated in SQL because presence
  // depends on environment-variable TTLs and lifecycle/status rules evaluated at
  // request time. This keeps the semantics identical to the rest of the system
  // while only selecting the columns presence computation needs.
  const agentRepo = AppDataSource.getRepository(Agent);
  const agents = await agentRepo.find({
    where: { projectId },
    select: ['id', 'status', 'lifecycleStatus', 'lastHeartbeatAt'],
  });

  let online = 0;
  let stale = 0;
  let offline = 0;

  for (const agent of agents) {
    const presence = getAgentPresence(agent);
    if (presence.presence === 'online') online++;
    else if (presence.presence === 'stale') stale++;
    else offline++;
  }

  return { total: agents.length, online, stale, offline };
}

async function getOrchestrationSummary(
  projectId: string,
  visibleOrchestrationIds: Set<string> | null,
): Promise<Record<string, number> & { total: number }> {
  const repo = AppDataSource.getRepository(ProjectOrchestration);
  const qb = repo
    .createQueryBuilder('o')
    .select('o.status', 'status')
    .addSelect('COUNT(*)', 'count')
    .where('o.projectId = :projectId', { projectId })
    .groupBy('o.status');

  if (visibleOrchestrationIds) {
    qb.andWhere('o.id IN (:...ids)', { ids: [...visibleOrchestrationIds] });
  }

  const rows = await qb.getRawMany();
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const count = Number(row.count);
    byStatus[row.status] = count;
    total += count;
  }
  return { ...byStatus, total };
}

async function getTaskSummary(
  projectId: string,
  visibleOrchestrationIds: Set<string> | null,
  agentId: string | null,
): Promise<Record<string, number> & { total: number; open_work: number; ready_for_review: number; blocked_failed: number }> {
  const repo = AppDataSource.getRepository(ProjectOrchestrationTask);
  const qb = repo
    .createQueryBuilder('t')
    .select('t.status', 'status')
    .addSelect('COUNT(*)', 'count')
    .where('t.projectId = :projectId', { projectId })
    .groupBy('t.status');

  if (visibleOrchestrationIds) {
    qb.andWhere(
      new Brackets((inner) => {
        inner.where('t.orchestrationId IN (:...ids)', { ids: [...visibleOrchestrationIds] });
        if (agentId) {
          inner.orWhere('t.assignedAgentId = :agentId', { agentId });
        }
      }),
    );
  }

  const rows = await qb.getRawMany();
  const byStatus: Record<string, number> = {};
  let total = 0;
  let openWork = 0;
  let readyForReview = 0;
  let blockedFailed = 0;

  for (const row of rows) {
    const count = Number(row.count);
    byStatus[row.status] = count;
    total += count;
    if (TASK_OPEN_WORK_STATUSES.has(row.status as ProjectOrchestrationTaskStatus)) {
      openWork += count;
    }
    if (row.status === ProjectOrchestrationTaskStatus.READY_FOR_REVIEW) {
      readyForReview += count;
    }
    if (TASK_BLOCKED_FAILED_STATUSES.has(row.status as ProjectOrchestrationTaskStatus)) {
      blockedFailed += count;
    }
  }

  return {
    ...byStatus,
    total,
    open_work: openWork,
    ready_for_review: readyForReview,
    blocked_failed: blockedFailed,
  };
}

async function getFileSummary(
  projectId: string,
  visibleOrchestrationIds: Set<string> | null,
  agentId: string | null,
): Promise<{ total_count: number; recent_count: number }> {
  const repo = AppDataSource.getRepository(ProjectFile);

  const totalQb = repo
    .createQueryBuilder('f')
    .select('COUNT(*)', 'count')
    .where('f.projectId = :projectId', { projectId });

  const recentQb = repo
    .createQueryBuilder('f')
    .where('f.projectId = :projectId', { projectId })
    .orderBy('f.updatedAt', 'DESC')
    .addOrderBy('f.path', 'ASC')
    .take(100);

  if (visibleOrchestrationIds && agentId) {
    const basePaths = await getBasePathsForOrchestrationIds(projectId, [...visibleOrchestrationIds]);
    applyAgentFileFilter(totalQb, basePaths);
    applyAgentFileFilter(recentQb, basePaths);
  }

  const [totalRow, recentFiles] = await Promise.all([
    totalQb.getRawOne<{ count: string }>(),
    recentQb.getMany(),
  ]);

  return {
    total_count: Number(totalRow?.count ?? '0'),
    recent_count: recentFiles.length,
  };
}

async function getBasePathsForOrchestrationIds(
  projectId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const repo = AppDataSource.getRepository(ProjectOrchestration);
  const rows = await repo
    .createQueryBuilder('o')
    .select('o.basePath', 'base_path')
    .where('o.projectId = :projectId', { projectId })
    .andWhere('o.id IN (:...ids)', { ids })
    .getRawMany();
  return rows.map((row: any) => row.base_path as string);
}

function applyAgentFileFilter<T extends { andWhere: Function }>(qb: T, basePaths: string[]): void {
  // Scope agent callers to globally visible convention files plus files under
  // orchestrations they participate in. Convention files (README, deliverables,
  // .agent result/review/trace) are intentionally visible across orchestrations
  // so agents can discover shared project context; narrowing them further would
  // be a product/security behavior change and needs explicit tests before rollout.
  qb.andWhere(
    new Brackets((inner) => {
      // Globally visible convention files
      inner.where(
        new Brackets((conv) => {
          conv.where("LOWER(f.path) = 'readme.md'");
          conv.orWhere("LOWER(f.path) LIKE '%/readme.md'");
          conv.orWhere("LOWER(f.path) LIKE 'deliverables/%'");
          conv.orWhere("LOWER(f.path) LIKE '.agent/%/result.md'");
          conv.orWhere("LOWER(f.path) LIKE '.agent/%/review.md'");
          conv.orWhere("LOWER(f.path) LIKE '.agent/%/trace.md'");
          conv.orWhere("LOWER(f.path) = '.agent/result.md'");
          conv.orWhere("LOWER(f.path) = '.agent/review.md'");
          conv.orWhere("LOWER(f.path) = '.agent/trace.md'");
        }),
      );

      // Files under visible orchestration base paths
      if (basePaths.length > 0) {
        for (const basePath of basePaths) {
          inner.orWhere('f.path LIKE :basePath', { basePath: `${basePath}/%` });
        }
      }
    }),
  );
}

async function getInboxSummary(
  projectId: string,
  agentId: string | null,
): Promise<{ pending_total: number; unacked_total: number }> {
  const repo = AppDataSource.getRepository(AgentInboxItem);

  const pendingQb = repo
    .createQueryBuilder('i')
    .select('COUNT(*)', 'count')
    .where('i.projectId = :projectId', { projectId })
    .andWhere('i.status != :acked', { acked: InboxItemStatus.ACKED });

  const unackedQb = repo
    .createQueryBuilder('i')
    .select('COUNT(*)', 'count')
    .where('i.projectId = :projectId', { projectId })
    .andWhere('i.status = :unread', { unread: InboxItemStatus.UNREAD });

  if (agentId) {
    pendingQb.andWhere('i.recipientAgentId = :agentId', { agentId });
    unackedQb.andWhere('i.recipientAgentId = :agentId', { agentId });
  }

  const [pendingRow, unackedRow] = await Promise.all([
    pendingQb.getRawOne<{ count: string }>(),
    unackedQb.getRawOne<{ count: string }>(),
  ]);

  return {
    pending_total: Number(pendingRow?.count ?? '0'),
    unacked_total: Number(unackedRow?.count ?? '0'),
  };
}

async function getAttention(
  projectId: string,
  visibleOrchestrationIds: Set<string> | null,
  agentId: string | null,
  limit: number,
): Promise<ProjectOverview['attention']> {
  const taskRepo = AppDataSource.getRepository(ProjectOrchestrationTask);

  const readyForReviewQb = taskRepo
    .createQueryBuilder('t')
    .select([
      't.id',
      't.orchestrationId',
      't.title',
      't.status',
      't.assignedAgentId',
      't.updatedAt',
    ])
    .where('t.projectId = :projectId', { projectId })
    .andWhere('t.status = :status', { status: ProjectOrchestrationTaskStatus.READY_FOR_REVIEW })
    .orderBy('t.updatedAt', 'DESC')
    .addOrderBy('t.title', 'ASC')
    .take(limit);

  const blockedFailedQb = taskRepo
    .createQueryBuilder('t')
    .select([
      't.id',
      't.orchestrationId',
      't.title',
      't.status',
      't.assignedAgentId',
      't.updatedAt',
    ])
    .where('t.projectId = :projectId', { projectId })
    .andWhere('t.status IN (:...statuses)', {
      statuses: [ProjectOrchestrationTaskStatus.BLOCKED, ProjectOrchestrationTaskStatus.FAILED],
    })
    .orderBy('t.updatedAt', 'DESC')
    .addOrderBy('t.title', 'ASC')
    .take(limit);

  if (visibleOrchestrationIds) {
    applyTaskScopeFilter(readyForReviewQb, visibleOrchestrationIds, agentId);
    applyTaskScopeFilter(blockedFailedQb, visibleOrchestrationIds, agentId);
  }

  const [readyForReview, blockedFailed] = await Promise.all([
    readyForReviewQb.getMany(),
    blockedFailedQb.getMany(),
  ]);

  const staleInbox = await getStaleInbox(projectId, agentId, limit);

  return {
    ready_for_review: readyForReview.map(serializeTaskAttentionItem),
    blocked_failed: blockedFailed.map(serializeTaskAttentionItem),
    stale_inbox: staleInbox,
  };
}

function applyTaskScopeFilter<T extends { andWhere: Function }>(
  qb: T,
  visibleOrchestrationIds: Set<string>,
  agentId: string | null,
): void {
  qb.andWhere(
    new Brackets((inner) => {
      inner.where('t.orchestrationId IN (:...ids)', { ids: [...visibleOrchestrationIds] });
      if (agentId) {
        inner.orWhere('t.assignedAgentId = :agentId', { agentId });
      }
    }),
  );
}

async function getStaleInbox(
  projectId: string,
  agentId: string | null,
  limit: number,
): Promise<InboxAttentionItem[]> {
  const repo = AppDataSource.getRepository(AgentInboxItem);
  const now = new Date();
  const threshold = new Date(now.getTime() - STALE_INBOX_SECONDS * 1000);

  const qb = repo
    .createQueryBuilder('i')
    .where('i.projectId = :projectId', { projectId })
    .andWhere('i.status != :acked', { acked: InboxItemStatus.ACKED })
    .andWhere('i.createdAt <= :threshold', { threshold })
    .orderBy('i.createdAt', 'ASC')
    .take(limit);

  if (agentId) {
    qb.andWhere('i.recipientAgentId = :agentId', { agentId });
  }

  const items = await qb.getMany();
  return items.map((item) => ({
    inbox_id: item.id,
    recipient_agent_id: item.recipientAgentId,
    event_type: item.eventType,
    title: item.title,
    status: item.status,
    age_seconds: Math.floor((now.getTime() - item.createdAt.getTime()) / 1000),
  }));
}

async function getRecentOrchestrations(
  projectId: string,
  visibleOrchestrationIds: Set<string> | null,
  limit: number,
): Promise<RecentOrchestrationItem[]> {
  const repo = AppDataSource.getRepository(ProjectOrchestration);
  const qb = repo
    .createQueryBuilder('o')
    .where('o.projectId = :projectId', { projectId })
    .orderBy('o.updatedAt', 'DESC')
    .addOrderBy('o.createdAt', 'DESC')
    .take(limit);

  if (visibleOrchestrationIds) {
    qb.andWhere('o.id IN (:...ids)', { ids: [...visibleOrchestrationIds] });
  }

  const orchestrations = await qb.getMany();

  const taskCounts = await getTaskCountsForOrchestrations(
    projectId,
    orchestrations.map((o) => o.id),
  );

  return orchestrations.map((o) => ({
    id: o.id,
    title: o.title,
    status: o.status,
    main_agent_id: o.mainAgentId ?? null,
    task_count: taskCounts.get(o.id) ?? 0,
    created_at: o.createdAt.toISOString(),
    updated_at: o.updatedAt.toISOString(),
  }));
}

async function getTaskCountsForOrchestrations(
  projectId: string,
  orchestrationIds: string[],
): Promise<Map<string, number>> {
  if (orchestrationIds.length === 0) return new Map();
  const repo = AppDataSource.getRepository(ProjectOrchestrationTask);
  const rows = await repo
    .createQueryBuilder('t')
    .select('t.orchestrationId', 'orchestration_id')
    .addSelect('COUNT(*)', 'count')
    .where('t.projectId = :projectId', { projectId })
    .andWhere('t.orchestrationId IN (:...ids)', { ids: orchestrationIds })
    .groupBy('t.orchestrationId')
    .getRawMany();

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.orchestration_id, Number(row.count));
  }
  return map;
}

async function getRecentFiles(
  projectId: string,
  visibleOrchestrationIds: Set<string> | null,
  agentId: string | null,
  limit: number,
): Promise<RecentFileItem[]> {
  const repo = AppDataSource.getRepository(ProjectFile);
  const qb = repo
    .createQueryBuilder('f')
    .select([
      'f.id',
      'f.path',
      'f.contentType',
      'f.sizeBytes',
      'f.updatedBy',
      'f.updatedAt',
    ])
    .where('f.projectId = :projectId', { projectId });

  if (visibleOrchestrationIds && agentId) {
    const basePaths = await getBasePathsForOrchestrationIds(projectId, [...visibleOrchestrationIds]);
    applyAgentFileFilter(qb, basePaths);
  }

  // Prioritize convention paths, then most recently updated.
  qb.orderBy(
    `
      CASE
        WHEN LOWER(f.path) = 'readme.md' OR LOWER(f.path) LIKE '%/readme.md' THEN 0
        WHEN LOWER(f.path) LIKE 'deliverables/%' THEN 1
        WHEN LOWER(f.path) LIKE '.agent/%/result.md' OR LOWER(f.path) = '.agent/result.md' THEN 2
        WHEN LOWER(f.path) LIKE '.agent/%/review.md' OR LOWER(f.path) = '.agent/review.md' THEN 3
        WHEN LOWER(f.path) LIKE '.agent/%/trace.md' OR LOWER(f.path) = '.agent/trace.md' THEN 4
        ELSE 5
      END
    `,
    'ASC',
  );
  qb.addOrderBy('f.updatedAt', 'DESC');
  qb.addOrderBy('f.path', 'ASC');
  qb.take(limit);

  const files = await qb.getMany();
  return files.map((file) => ({
    file_id: file.id,
    path: file.path,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
    updated_by: file.updatedBy,
    updated_at: file.updatedAt.toISOString(),
  }));
}

async function getWorkloadSummary(projectId: string): Promise<{
  total_units: number;
  reviewed_units: number;
  total_final_work_units: number;
}> {
  const repo = AppDataSource.getRepository(AgentWorkUnit);
  const rows = await repo
    .createQueryBuilder('wu')
    .select('wu.status', 'status')
    .addSelect('COUNT(*)', 'count')
    .addSelect('COALESCE(SUM(wu.finalWorkUnits), 0)', 'final_work')
    .where('wu.projectId = :projectId', { projectId })
    .groupBy('wu.status')
    .getRawMany();

  let totalUnits = 0;
  let reviewedUnits = 0;
  let totalFinalWork = 0;

  for (const row of rows) {
    const count = Number(row.count);
    const finalWork = Number(row.final_work);
    totalUnits += count;
    if (row.status === WorkUnitStatus.REVIEWED_APPROVED || row.status === WorkUnitStatus.REVIEWED_CHANGES_REQUESTED) {
      reviewedUnits += count;
    }
    totalFinalWork += finalWork;
  }

  return { total_units: totalUnits, reviewed_units: reviewedUnits, total_final_work_units: totalFinalWork };
}

async function getRecentHealthSignals(
  projectId: string,
  limit: number,
): Promise<HealthSignalItem[]> {
  const repo = AppDataSource.getRepository(HealthMetric);
  const rows = await repo
    .createQueryBuilder('h')
    .select([
      'h.id',
      'h.agentId',
      'h.name',
      'h.value',
      'h.unit',
      'h.status',
      'h.recordedAt',
    ])
    .where('h.projectId = :projectId', { projectId })
    .orderBy('h.recordedAt', 'DESC')
    .addOrderBy('h.id', 'ASC')
    .take(limit)
    .getMany();

  return rows.map((row) => ({
    signal_id: row.id,
    agent_id: row.agentId ?? null,
    name: row.name,
    value: row.value,
    unit: row.unit ?? null,
    status: row.status ?? null,
    recorded_at: row.recordedAt.toISOString(),
  }));
}

function serializeTaskAttentionItem(task: ProjectOrchestrationTask): TaskAttentionItem {
  return {
    task_id: task.id,
    orchestration_id: task.orchestrationId,
    title: task.title,
    status: task.status,
    assigned_agent_id: task.assignedAgentId ?? null,
    updated_at: task.updatedAt.toISOString(),
  };
}
