import { Router, Request, Response } from 'express';
import { authenticate, authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { buildProjectOverview, ProjectNotFoundError } from '../services/project-overview.service';
import { detectProjectLicense } from '../services/project-license.service';
import { materializeAndVerifyProjectAuditChain } from '../services/project-audit.service';
import { findProjectReadmeCandidates } from './project-space.routes';
import { createInboxItem } from './agent-inbox.routes';
import { AppDataSource } from '../data-source';
import { Project, ProjectVisibility, ProjectStatus } from '../entities/project.entity';
import { User } from '../entities/user.entity';
import { ProjectMember, ProjectRole } from '../entities/project-member.entity';
import { ProjectAuditEvent, ProjectAuditAction } from '../entities/project-audit-event.entity';
import { ProjectFile } from '../entities/project-file.entity';
import { ProjectFileRevision } from '../entities/project-file-revision.entity';
import { ProjectWebhookDelivery, WebhookDeliveryStatus } from '../entities/project-webhook-delivery.entity';
import { Brackets } from 'typeorm';

const router = Router();
const projectRepo = AppDataSource.getRepository(Project);
const memberRepo = AppDataSource.getRepository(ProjectMember);
const auditRepo = AppDataSource.getRepository(ProjectAuditEvent);
const deliveryRepo = AppDataSource.getRepository(ProjectWebhookDelivery);
const ASSIGNABLE_MEMBER_ROLES = [
  ProjectRole.ADMIN,
  ProjectRole.MEMBER,
  ProjectRole.VIEWER,
] as const;
const MIN_AUDIT_RETENTION_DAYS = 30;
const MAX_AUDIT_RETENTION_DAYS = 3650;

// ─── Topic validation constants ────────────────────────────────────────────────
const TOPICS_MAX_COUNT = 20;
const TOPIC_MAX_LENGTH = 50;
const DANGEROUS_CONTROL_CHAR_RE = /[\x00-\x08\x0e-\x1f\x7f]/;

function isAssignableMemberRole(role: unknown): role is (typeof ASSIGNABLE_MEMBER_ROLES)[number] {
  return typeof role === 'string' && (ASSIGNABLE_MEMBER_ROLES as readonly string[]).includes(role);
}

type TopicsValidation =
  | { ok: true; topics: string[] }
  | { ok: false; detail: string };

/**
 * Validate and normalize a topics array.
 * - Must be an array.
 * - Each entry is trimmed; empty entries are dropped.
 * - Rejects control characters and entries exceeding 50 visible characters.
 * - Deduplicates case-insensitively (first occurrence wins).
 * - Rejects if more than 20 unique topics remain.
 */
function validateTopics(raw: unknown): TopicsValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, detail: 'topics must be an array' };
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { ok: false, detail: 'each topic must be a string' };
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue; // silently drop empty entries
    if (DANGEROUS_CONTROL_CHAR_RE.test(trimmed)) {
      return { ok: false, detail: 'topics must not contain control characters' };
    }
    if (trimmed.length > TOPIC_MAX_LENGTH) {
      return { ok: false, detail: `each topic must be at most ${TOPIC_MAX_LENGTH} characters` };
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue; // collapse duplicates
    seen.add(key);
    result.push(trimmed);
  }

  if (result.length > TOPICS_MAX_COUNT) {
    return { ok: false, detail: `topics must contain at most ${TOPICS_MAX_COUNT} entries` };
  }

  return { ok: true, topics: result };
}

// ─── Audit trail helpers ──────────────────────────────────────────────────────

async function recordMemberAudit(
  projectId: string,
  actorUserId: string,
  action: ProjectAuditAction,
  targetUserId: string | null,
  previousRole: ProjectRole | null,
  newRole: ProjectRole | null,
): Promise<void> {
  await auditRepo.save(
    auditRepo.create({
      projectId,
      actorUserId,
      action,
      targetUserId: targetUserId ?? null,
      previousRole,
      newRole,
    }),
  );
}

const SENSITIVE_METADATA_KEYS = new Set([
  'webhook_secret',
  'secret',
  'token',
  'password',
  'api_key',
  'api_secret',
  'body',
  'markdown',
  'content',
  'raw',
]);

function isSensitiveMetadataKey(key: string): boolean {
  return SENSITIVE_METADATA_KEYS.has(key.toLowerCase());
}

function redactMetadata(metadata: unknown): unknown {
  if (metadata === null || metadata === undefined) return metadata;
  if (Array.isArray(metadata)) {
    return metadata.map((item) => redactMetadata(item));
  }
  if (typeof metadata !== 'object') return metadata;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (isSensitiveMetadataKey(key)) {
      continue;
    }
    result[key] = redactMetadata(value);
  }
  return result;
}

function serializeAuditEvent(event: ProjectAuditEvent) {
  return {
    id: event.id,
    project_id: event.projectId,
    actor_user_id: event.actorUserId,
    actor_display_name: event.actor?.displayName ?? null,
    actor_email: event.actor?.email ?? null,
    target_user_id: event.targetUserId ?? null,
    target_display_name: event.target?.displayName ?? null,
    target_email: event.target?.email ?? null,
    action: event.action,
    previous_role: event.previousRole ?? null,
    new_role: event.newRole ?? null,
    metadata: redactMetadata(event.metadataJson) ?? null,
    created_at: event.createdAt,
  };
}

function searchableMetadataText(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return '';
  if (Array.isArray(metadata)) {
    return metadata.map((item) => searchableMetadataText(item)).join(' ');
  }
  if (typeof metadata === 'string') return metadata;
  if (typeof metadata === 'number' || typeof metadata === 'boolean') return String(metadata);
  if (typeof metadata !== 'object') return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (isSensitiveMetadataKey(key)) continue;
    parts.push(searchableMetadataText(value));
  }
  return parts.join(' ');
}

function auditEventMatchesSearch(event: ProjectAuditEvent, q: string): boolean {
  const term = q.toLowerCase();
  const haystack = [
    event.action,
    event.actor?.displayName ?? '',
    event.actor?.email ?? '',
    event.target?.displayName ?? '',
    event.target?.email ?? '',
    searchableMetadataText(event.metadataJson),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(term);
}

function serializeWebhookDelivery(delivery: ProjectWebhookDelivery) {
  return {
    id: delivery.id,
    project_id: delivery.projectId,
    event_id: delivery.eventId,
    event_type: delivery.eventType,
    attempt: delivery.attempt,
    status: delivery.status,
    http_status_code: delivery.httpStatusCode ?? null,
    message: delivery.message ?? null,
    masked_url: delivery.maskedUrl ?? null,
    created_at: delivery.createdAt,
  };
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str) || /^[=+\-@\t]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(values: unknown[]): string {
  return values.map(escapeCsvCell).join(',') + '\n';
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseInt(value as string, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function parseAuditRetentionDays(value: unknown): { ok: true; value: number | null } | { ok: false; detail: string } {
  if (value === null) return { ok: true, value: null };
  if (!Number.isInteger(value)) {
    return { ok: false, detail: 'retention_days must be an integer or null' };
  }
  const days = value as number;
  if (days < MIN_AUDIT_RETENTION_DAYS || days > MAX_AUDIT_RETENTION_DAYS) {
    return {
      ok: false,
      detail: `retention_days must be between ${MIN_AUDIT_RETENTION_DAYS} and ${MAX_AUDIT_RETENTION_DAYS}`,
    };
  }
  return { ok: true, value: days };
}

function auditRetentionCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

function normalizeTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function serializeProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    status: project.status ?? ProjectStatus.ACTIVE,
    topics: project.topics ?? [],
    clone_source_project_id: project.cloneSourceProjectId ?? null,
    webhook_url: project.webhookUrl,
    has_webhook_secret: Boolean(project.webhookSecret),
    webhook_enabled_events: project.webhookEnabledEvents,
    owner_id: project.ownerId,
    main_agent_id: project.mainAgentId ?? null,
    audit_retention_days: project.auditRetentionDays ?? null,
    audit_legal_hold_enabled: Boolean(project.auditLegalHoldEnabled),
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * GET /v1/projects
 * List all projects visible to the current user (paginated).
 * Requires authentication.
 */
router.get('/v1/projects', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const skip = parseInt(req.query.skip as string, 10) || 0;
    const limit = parseInt(req.query.limit as string, 10) || 50;

    // Get projects where the user is a member
    const [memberships, total] = await memberRepo.findAndCount({
      where: { userId },
      relations: ['project'],
      skip,
      take: Math.min(limit, 100),
    });

    const projects = memberships.map((m) => m.project).filter(Boolean);

    res.json({
      data: projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        visibility: p.visibility,
        status: p.status ?? ProjectStatus.ACTIVE,
        topics: p.topics ?? [],
        clone_source_project_id: p.cloneSourceProjectId ?? null,
        owner_id: p.ownerId,
        main_agent_id: p.mainAgentId ?? null,
        created_at: p.createdAt,
        updated_at: p.updatedAt,
      })),
      meta: { total, skip, limit },
    });
  } catch (err) {
    console.error('List projects error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * POST /v1/projects
 * Create a new project. The creator becomes the Owner.
 * Requires authentication.
 */
router.post('/v1/projects', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { name, description } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(422).json({
        detail: [
          {
            loc: ['body', 'name'],
            msg: 'Name is required and must be a non-empty string',
            type: 'missing',
          },
        ],
      });
      return;
    }

    const project = projectRepo.create({
      name: name.trim(),
      description: description?.trim(),
      visibility: req.body.visibility === ProjectVisibility.PUBLIC
        ? ProjectVisibility.PUBLIC
        : ProjectVisibility.PRIVATE,
      ownerId: userId,
    });

    // Validate topics if supplied at creation time.
    if (req.body.topics !== undefined) {
      const tv = validateTopics(req.body.topics);
      if (!tv.ok) {
        res.status(422).json({ detail: tv.detail });
        return;
      }
      project.topics = tv.topics;
    }

    await projectRepo.save(project);

    // Add creator as Owner member
    const membership = memberRepo.create({
      projectId: project.id,
      userId,
      role: ProjectRole.OWNER,
    });
    await memberRepo.save(membership);

    res.status(201).json({
      id: project.id,
      name: project.name,
      description: project.description,
      visibility: project.visibility,
      status: project.status ?? ProjectStatus.ACTIVE,
      topics: project.topics ?? [],
      clone_source_project_id: project.cloneSourceProjectId ?? null,
      owner_id: project.ownerId,
      main_agent_id: project.mainAgentId ?? null,
      created_at: project.createdAt,
      updated_at: project.updatedAt,
    });
  } catch (err) {
    console.error('Create project error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * GET /v1/projects/:project_id
 * Get project details.
 */
router.get(
  '/v1/projects/:project_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const project = await projectRepo.findOne({
        where: { id: req.params.project_id },
      });

      if (!project) {
      res.status(404).json({ detail: 'Project not found' });
      return;
    }

      res.json(serializeProject(project));
    } catch (err) {
      console.error('Get project error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/summary
 * Lightweight project-space summary: file totals, README, recent activity,
 * and convention buckets (deliverables/, .agent/RESULT.md, etc.).
 * Requires ViewProject permission.
 */
router.get(
  '/v1/projects/:project_id/summary',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const project = await projectRepo.findOne({ where: { id: projectId } });
      const fileRepo = AppDataSource.getRepository(ProjectFile);
      const revisionRepo = AppDataSource.getRepository(ProjectFileRevision);

      // Aggregate counts/bytes without loading file metadata.
      const fileTotals = await fileRepo
        .createQueryBuilder('file')
        .where('file.projectId = :projectId', { projectId })
        .select('COUNT(*)', 'count')
        .addSelect('COALESCE(SUM(file.sizeBytes), 0)', 'totalBytes')
        .getRawOne<{ count: string; totalBytes: string }>();

      const totalCount = parseInt(fileTotals?.count ?? '0', 10) || 0;
      const totalBytes = parseInt(fileTotals?.totalBytes ?? '0', 10) || 0;

      // README: targeted query for known README variants, case-insensitive.
      const readmeCandidates = await findProjectReadmeCandidates(fileRepo, projectId);
      const readmeFile = readmeCandidates[0] ?? null;

      // License: detect root-level license files via local keyword matching.
      const license = await detectProjectLicense(projectId, fileRepo);

      // Recent files: bounded query ordered by updatedAt DESC, path ASC.
      const recentFiles = await fileRepo
        .createQueryBuilder('file')
        .where('file.projectId = :projectId', { projectId })
        .select([
          'file.id',
          'file.path',
          'file.contentType',
          'file.sizeBytes',
          'file.updatedBy',
          'file.updatedAt',
        ])
        .orderBy('file.updatedAt', 'DESC')
        .addOrderBy('file.path', 'ASC')
        .take(10)
        .getMany();

      // Recent revisions: bounded query ordered by createdAt DESC, revisionNumber DESC.
      const recentRevisions = await revisionRepo
        .createQueryBuilder('revision')
        .where('revision.projectId = :projectId', { projectId })
        .select([
          'revision.id',
          'revision.projectId',
          'revision.fileId',
          'revision.path',
          'revision.revisionNumber',
          'revision.contentType',
          'revision.contentHash',
          'revision.message',
          'revision.createdBy',
          'revision.createdAt',
        ])
        .orderBy('revision.createdAt', 'DESC')
        .addOrderBy('revision.revisionNumber', 'DESC')
        .take(10)
        .getMany();

      // Deliverables bucket: targeted path-prefix query.
      const deliverables = await fileRepo
        .createQueryBuilder('file')
        .where('file.projectId = :projectId', { projectId })
        .andWhere("(file.path = 'deliverables/' OR file.path LIKE 'deliverables/%')")
        .select(['file.id', 'file.path', 'file.updatedAt'])
        .orderBy('file.path', 'ASC')
        .getMany();

      // Agent convention files: targeted exact-path query (case-insensitive).
      const agentFiles = await fileRepo
        .createQueryBuilder('file')
        .where('file.projectId = :projectId', { projectId })
        .andWhere('LOWER(file.path) IN (:...agentPaths)', {
          agentPaths: ['.agent/result.md', '.agent/review.md', '.agent/trace.md'],
        })
        .select(['file.id', 'file.path'])
        .getMany();

      const agentResult =
        agentFiles.find((file) => file.path.toLowerCase() === '.agent/result.md') ?? null;
      const agentReview =
        agentFiles.find((file) => file.path.toLowerCase() === '.agent/review.md') ?? null;
      const agentTrace =
        agentFiles.find((file) => file.path.toLowerCase() === '.agent/trace.md') ?? null;

      // Fetch all paths once for directory and extension insight queries.
      const allPaths = await fileRepo
        .createQueryBuilder('file')
        .where('file.projectId = :projectId', { projectId })
        .select('file.path', 'path')
        .getRawMany<{ path: string }>();

      // Top-level directory count: count distinct first path segments.
      const topLevelDirs = new Set<string>();
      for (const row of allPaths) {
        const slashIdx = row.path.indexOf('/');
        if (slashIdx > 0) {
          topLevelDirs.add(row.path.slice(0, slashIdx));
        }
      }
      const topLevelDirCount = topLevelDirs.size;

      // File extension breakdown: top-10 by count, bounded.
      const TOP_N_TYPES = 10;
      const extCounts = new Map<string, number>();
      for (const row of allPaths) {
        const dotIdx = row.path.lastIndexOf('.');
        if (dotIdx > 0) {
          const ext = row.path.slice(dotIdx);
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        }
      }
      const fileTypes = [...extCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_N_TYPES)
        .map(([extension, count]) => ({ extension, count }));

      // Last updated file: reuse the most recent entry from recentFiles if available.
      const lastUpdatedFile = recentFiles.length > 0
        ? {
            file_id: recentFiles[0].id,
            path: recentFiles[0].path,
            updated_at: recentFiles[0].updatedAt,
          }
        : null;

      const bucketFilePayload = (file: ProjectFile | null) =>
        file ? { file_id: file.id, path: file.path } : null;

      res.json({
        project_id: projectId,
        status: project?.status ?? ProjectStatus.ACTIVE,
        topics: project?.topics ?? [],
        files: {
          total_count: totalCount,
          total_bytes: totalBytes,
          directory_count: topLevelDirCount,
          file_types: fileTypes,
        },
        readme: readmeFile
          ? { file_id: readmeFile.id, path: readmeFile.path }
          : null,
        license,
        last_updated_file: lastUpdatedFile,
        recent_activity: {
          files: recentFiles.map((file) => ({
            file_id: file.id,
            path: file.path,
            content_type: file.contentType,
            size_bytes: file.sizeBytes,
            updated_by: file.updatedBy,
            updated_at: file.updatedAt,
          })),
          revisions: recentRevisions.map((revision) => ({
            revision_id: revision.id,
            file_id: revision.fileId,
            path: revision.path,
            revision_number: revision.revisionNumber,
            message: revision.message ?? null,
            created_by: revision.createdBy,
            created_at: revision.createdAt,
          })),
        },
        buckets: {
          deliverables: deliverables.map((file) => ({
            file_id: file.id,
            path: file.path,
            updated_at: file.updatedAt,
          })),
          agent_result: bucketFilePayload(agentResult),
          agent_review: bucketFilePayload(agentReview),
          agent_trace: bucketFilePayload(agentTrace),
        },
      });
    } catch (err) {
      console.error('Get project summary error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/repository/summary
 * Structured repository analysis for the PM agent: file tree (top-level),
 * language breakdown, entry-point detection, package.json/requirements info,
 * README preview, and test file candidates. Powers "read project structure →
 * generate plan" in the development-run workflow.
 */
router.get(
  '/v1/projects/:project_id/repository/summary',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileRepo = AppDataSource.getRepository(ProjectFile);
      const files = await fileRepo.find({
        where: { projectId },
        select: ['id', 'path', 'sizeBytes', 'contentType'],
        order: { path: 'ASC' },
      });
      const liveFiles = files.filter((f) => !(f as any).deletedAt);
      const allPaths = liveFiles.map((f) => f.path);

      // Top-level tree (depth ≤ 2)
      const topLevel: Record<string, { files: number; dirs: string[] }> = {};
      for (const f of liveFiles) {
        const parts = f.path.split('/');
        const root = parts[0];
        if (!topLevel[root]) topLevel[root] = { files: 0, dirs: [] };
        topLevel[root].files++;
        if (parts.length > 1 && parts[1] && !topLevel[root].dirs.includes(parts[1])) {
          topLevel[root].dirs.push(parts[1]);
        }
      }
      const tree = Object.entries(topLevel).map(([name, info]) => ({
        name, type: info.dirs.length > 0 ? 'directory' : 'file', file_count: info.files, subdirs: info.dirs.slice(0, 20),
      }));

      // Language breakdown
      const langMap: Record<string, { files: number; bytes: number }> = {};
      const EXT_LANG: Record<string, string> = {
        '.ts': 'TypeScript', '.js': 'JavaScript', '.tsx': 'TypeScript', '.jsx': 'JavaScript',
        '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.c': 'C', '.cpp': 'C++',
        '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin', '.sh': 'Shell',
        '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
        '.sql': 'SQL', '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
      };
      for (const f of liveFiles) {
        const ext = '.' + (f.path.split('.').pop() || '').toLowerCase();
        const lang = EXT_LANG[ext];
        if (lang) { if (!langMap[lang]) langMap[lang] = { files: 0, bytes: 0 }; langMap[lang].files++; langMap[lang].bytes += f.sizeBytes; }
      }
      const languages = Object.entries(langMap).map(([name, info]) => ({ name, files: info.files, bytes: info.bytes })).sort((a, b) => b.files - a.files);

      // Entry points
      const entryCandidates = allPaths.filter((p) => /^(src\/)?(index|main|app|server)\.(ts|js|py|go|rs|java)$/i.test(p) || /^(src\/)?(index|main)\.(html|vue|svelte)$/i.test(p));

      // Package info
      let packageInfo: Record<string, unknown> | null = null;
      const pkgFile = liveFiles.find((f) => ['package.json', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pyproject.toml'].includes(f.path));
      if (pkgFile) {
        const full = await fileRepo.findOne({ where: { id: pkgFile.id }, select: ['path', 'content'] });
        if (full?.content) {
          try {
            if (full.path.endsWith('.json')) {
              const pkg = JSON.parse(full.content);
              packageInfo = { type: full.path, name: pkg.name || null, version: pkg.version || null, dependencies: Object.keys(pkg.dependencies || {}).slice(0, 20), devDependencies: Object.keys(pkg.devDependencies || {}).slice(0, 10), scripts: pkg.scripts ? Object.keys(pkg.scripts).slice(0, 10) : [] };
            } else { packageInfo = { type: full.path, raw: full.content.slice(0, 500) }; }
          } catch { packageInfo = { type: full.path, error: 'parse failed' }; }
        }
      }

      // README preview
      let readmePreview: string | null = null;
      const readmeFile = liveFiles.find((f) => /^readme\.(md|markdown|txt)$/i.test(f.path));
      if (readmeFile) { const full = await fileRepo.findOne({ where: { id: readmeFile.id }, select: ['content'] }); readmePreview = full?.content?.slice(0, 1000) ?? null; }

      // Test files
      const testFiles = allPaths.filter((p) => /\.(test|spec)\.(ts|js|py|go|rs)$/i.test(p) || /^tests?\//i.test(p) || /^__tests__\//i.test(p));

      // Git HEAD
      let gitHead: string | null = null;
      try { const { gitHeadSha } = await import('../services/project-git.service'); gitHead = await gitHeadSha(projectId); } catch { /* */ }

      res.json({ project_id: projectId, total_files: liveFiles.length, total_bytes: liveFiles.reduce((s, f) => s + f.sizeBytes, 0), tree, languages, entry_points: entryCandidates, package: packageInfo, readme_preview: readmePreview, test_files: testFiles.slice(0, 20), git_head_sha: gitHead });
    } catch (err) {
      console.error('Repository summary error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/repository/generate-code-map
 * Scans all source files and generates a structured code map (.agent/code-map.md).
 * The code map is auto-injected into every agent's dispatch context alongside
 * AGENTS.md, so agents don't need to read every file to understand the project.
 *
 * For each source file, extracts:
 * - File path, size, language
 * - Top-level functions/classes/types (regex-based, lightweight — no AST parser)
 * - Import dependencies (first 10 imports)
 * - A one-line summary (first comment or first meaningful line)
 *
 * Result is written to .agent/code-map.md via the shared file upsert.
 */
router.post(
  '/v1/projects/:project_id/repository/generate-code-map',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileRepo = AppDataSource.getRepository(ProjectFile);
      const userId = req.user?.userId ?? req.agent?.id ?? 'code-map';

      // Load all source files (code files only, skip binaries/images/data).
      const CODE_EXTS = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.kt', '.sh', '.vue', '.svelte', '.html', '.css', '.scss', '.sql', '.yaml', '.yml', '.json', '.toml', '.md']);
      const allFiles = await fileRepo.find({ where: { projectId }, order: { path: 'ASC' } });
      const sourceFiles = allFiles.filter((f) => {
        if ((f as any).deletedAt) return false;
        const ext = '.' + (f.path.split('.').pop() || '').toLowerCase();
        return CODE_EXTS.has(ext) && f.sizeBytes > 0 && f.sizeBytes < 200000; // skip huge files
      });

      // Generate the code map markdown.
      const lines: string[] = [
        '# Code Map',
        '',
        `> Auto-generated from ${sourceFiles.length} source files. Updated: ${new Date().toISOString()}`,
        '> Injected into every agent context — use this to find where code lives, then read only the files you need.',
        '',
        '## Files',
        '',
      ];

      for (const f of sourceFiles.slice(0, 200)) {
        const content = f.content || '';
        const ext = '.' + (f.path.split('.').pop() || '').toLowerCase();
        const sizeKB = Math.round(f.sizeBytes / 1024);

        // Extract top-level symbols (functions/classes/exports).
        const symbols: string[] = [];
        if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) {
          const funcMatches = content.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm) || [];
          const classMatches = content.match(/^(?:export\s+)?(?:default\s+)?class\s+(\w+)/gm) || [];
          const constMatches = content.match(/^(?:export\s+)?const\s+(\w+)\s*=/gm) || [];
          [...funcMatches, ...classMatches].forEach((m) => {
            const name = m.replace(/^(export\s+)?(async\s+)?(default\s+)?(function|class)\s+/, '');
            if (name) symbols.push(name);
          });
          constMatches.slice(0, 5).forEach((m) => {
            const name = m.replace(/^(export\s+)?const\s+/, '').replace(/\s*=/, '');
            if (name && name.length < 50) symbols.push(name + ' (const)');
          });
        } else if (ext === '.py') {
          const funcMatches = content.match(/^(?:async\s+)?def\s+(\w+)/gm) || [];
          const classMatches = content.match(/^class\s+(\w+)/gm) || [];
          funcMatches.forEach((m) => { const n = m.replace(/^(async\s+)?def\s+/, ''); if (n) symbols.push(n + '()'); });
          classMatches.forEach((m) => { const n = m.replace(/^class\s+/, ''); if (n) symbols.push(n); });
        }

        // Extract imports (first 5).
        const imports: string[] = [];
        const importRegex = content.match(/^(?:import|from|require|#include)\s.*$/gm) || [];
        importRegex.slice(0, 5).forEach((m) => imports.push(m.trim()));

        // One-line summary: first non-empty, non-import line.
        let summary = '';
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
            summary = trimmed.replace(/^(\/\/\s*|\/\*\*?\s*|\*\s*|#\s*)/, '').slice(0, 100);
            break;
          }
          if (!trimmed.match(/^(import|from|require|export|package|"use strict")/)) {
            summary = trimmed.slice(0, 100);
            break;
          }
        }

        lines.push(`### ${f.path} (${sizeKB}KB)`);
        if (summary) lines.push(`- **Summary**: ${summary}`);
        if (symbols.length) lines.push(`- **Symbols**: ${symbols.slice(0, 15).join(', ')}`);
        if (imports.length) lines.push(`- **Imports**: ${imports.join('; ')}`);
        lines.push('');
      }

      if (sourceFiles.length > 200) {
        lines.push(`... and ${sourceFiles.length - 200} more files. Use \`GET /repository/summary\` for the full tree.`);
      }

      const codeMapContent = lines.join('\n');

      // Write to .agent/code-map.md via shared upsert (auto-injected by loadCodeMap).
      const { upsertProjectFileContent } = await import('../services/project-file.service');
      await AppDataSource.transaction(async (manager) => {
        await upsertProjectFileContent(manager, {
          projectId,
          path: '.agent/code-map.md',
          content: codeMapContent,
          message: 'Auto-generated code map',
          actorId: userId,
        });
      });

      res.json({
        generated: true,
        path: '.agent/code-map.md',
        files_indexed: sourceFiles.length,
        content_length: codeMapContent.length,
      });
    } catch (err) {
      console.error('Generate code map error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/repository/code-graph
 * Structured code graph: symbols, imports, dependency edges, symbol index.
 * Lets agents query "which files define function X" or "what does file Y depend on"
 * without reading every file. Regex-based (no native deps like tree-sitter).
 */
router.get(
  '/v1/projects/:project_id/repository/code-graph',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const fileRepo = AppDataSource.getRepository(ProjectFile);
      const allFiles = await fileRepo.find({ where: { projectId }, order: { path: 'ASC' } });
      const sourceFiles = allFiles
        .filter((f) => !(f as any).deletedAt)
        .filter((f) => {
          const ext = '.' + (f.path.split('.').pop() || '').toLowerCase();
          return ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.sh', '.vue', '.svelte'].includes(ext)
            && f.sizeBytes > 0 && f.sizeBytes < 200000;
        })
        .map((f) => ({ path: f.path, content: f.content || '', sizeBytes: f.sizeBytes }));

      const { buildCodeGraph } = await import('../services/code-graph.service');
      const graph = buildCodeGraph(projectId, sourceFiles);
      res.json(graph);
    } catch (err) {
      console.error('Code graph error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/repository/search?q=...
 * TF-IDF semantic code search (no embedding model). Lets agents search
 * "where is the heartbeat logic" and get ranked file matches.
 */
router.get(
  '/v1/projects/:project_id/repository/search',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (!query) { res.status(422).json({ detail: 'q parameter required' }); return; }
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '10'), 10) || 10, 1), 50);

      const fileRepo = AppDataSource.getRepository(ProjectFile);
      const allFiles = await fileRepo.find({ where: { projectId }, order: { path: 'ASC' } });
      const sourceFiles = allFiles
        .filter((f) => !(f as any).deletedAt)
        .filter((f) => {
          const ext = '.' + (f.path.split('.').pop() || '').toLowerCase();
          return ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.sh', '.vue', '.svelte', '.html', '.css', '.md'].includes(ext)
            && f.sizeBytes > 0 && f.sizeBytes < 200000;
        });

      // Extract symbols for better matching.
      const { extractSymbols } = await import('../services/code-graph.service');
      const searchable = sourceFiles.map((f) => {
        const ext = '.' + (f.path.split('.').pop() || '').toLowerCase();
        const lang = { '.ts': 'TypeScript', '.js': 'JavaScript', '.tsx': 'TypeScript', '.py': 'Python' }[ext] || 'Unknown';
        const symbols = lang !== 'Unknown' ? extractSymbols(f.content || '', lang).map((s) => s.name) : [];
        return { path: f.path, content: f.content || '', symbols };
      });

      const { searchCode } = await import('../services/code-search.service');
      const result = searchCode(query, searchable, limit);
      res.json(result);
    } catch (err) {
      console.error('Code search error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

// ─── Extension-based language detection ───────────────────────────────────────
// This is intentionally conservative: we only map well-known file extensions to
// display names. Files without a recognized extension, including most binaries,
// are omitted from the language breakdown rather than guessed.
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.bash': 'Shell',
  '.c': 'C',
  '.cc': 'C++',
  '.clj': 'Clojure',
  '.cpp': 'C++',
  '.cs': 'C#',
  '.css': 'CSS',
  '.cxx': 'C++',
  '.dart': 'Dart',
  '.dockerfile': 'Dockerfile',
  '.elm': 'Elm',
  '.erl': 'Erlang',
  '.ex': 'Elixir',
  '.exs': 'Elixir',
  '.fish': 'Shell',
  '.fs': 'F#',
  '.fsx': 'F#',
  '.fsscript': 'F#',
  '.go': 'Go',
  '.gradle': 'Gradle',
  '.groovy': 'Groovy',
  '.h': 'C',
  '.hcl': 'HCL',
  '.hs': 'Haskell',
  '.html': 'HTML',
  '.ipynb': 'Jupyter Notebook',
  '.java': 'Java',
  '.js': 'JavaScript',
  '.jsx': 'JSX',
  '.json': 'JSON',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.less': 'Less',
  '.lua': 'Lua',
  '.m': 'Objective-C',
  '.makefile': 'Makefile',
  '.md': 'Markdown',
  '.mk': 'Makefile',
  '.mjs': 'JavaScript',
  '.mm': 'Objective-C++',
  '.nim': 'Nim',
  '.pas': 'Pascal',
  '.php': 'PHP',
  '.pl': 'Perl',
  '.pm': 'Perl',
  '.pp': 'Pascal',
  '.ps1': 'PowerShell',
  '.py': 'Python',
  '.r': 'R',
  '.rb': 'Ruby',
  '.rs': 'Rust',
  '.scala': 'Scala',
  '.scss': 'SCSS',
  '.sh': 'Shell',
  '.sql': 'SQL',
  '.styl': 'Stylus',
  '.svelte': 'Svelte',
  '.svg': 'SVG',
  '.swift': 'Swift',
  '.tcl': 'Tcl',
  '.tf': 'HCL',
  '.ts': 'TypeScript',
  '.tsx': 'TSX',
  '.v': 'Verilog',
  '.vhd': 'VHDL',
  '.vue': 'Vue',
  '.xml': 'XML',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.zsh': 'Shell',
};

function detectLanguageByPath(filePath: string): string | null {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex <= 0) {
    return null;
  }
  const ext = filePath.slice(dotIndex).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

/**
 * GET /v1/projects/:project_id/languages
 * Read-only language breakdown for the project, derived from real project files.
 * Requires ViewProject permission.
 *
 * Language detection is extension-only and conservative: files without a
 * recognized extension (including most binaries) are omitted from the totals
 * rather than guessed. Counts are based on stored file byte lengths.
 */
router.get(
  '/v1/projects/:project_id/languages',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const project = await projectRepo.findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const fileRepo = AppDataSource.getRepository(ProjectFile);
      const files = await fileRepo
        .createQueryBuilder('file')
        .where('file.projectId = :projectId', { projectId })
        .andWhere('file.deletedAt IS NULL')
        .select(['file.path', 'file.sizeBytes'])
        .getMany();

      const languageBytes = new Map<string, number>();
      let totalBytes = 0;

      for (const file of files) {
        const language = detectLanguageByPath(file.path);
        if (!language) {
          continue;
        }
        const bytes = file.sizeBytes ?? 0;
        languageBytes.set(language, (languageBytes.get(language) ?? 0) + bytes);
        totalBytes += bytes;
      }

      const sortedLanguages = [...languageBytes.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

      const languages: Record<string, number> = {};
      for (const [language, bytes] of sortedLanguages) {
        languages[language] = bytes;
      }

      res.json({
        languages,
        total_bytes: totalBytes,
        source: 'project_files',
        limitations: [
          'extension-based local estimate',
          'files without a recognized extension are omitted',
        ],
      });
    } catch (err) {
      console.error('Get project languages error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/overview
 * Compact project home overview: summary counts, attention items, recent
 * orchestrations/files, workload, and health signals. Supports JWT users and
 * agent API keys; agent callers only see orchestrations/tasks/files within
 * their visible scope.
 */
router.get(
  '/v1/projects/:project_id/overview',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const agentId = req.agent?.id ?? null;

      const limits = {
        attention: parseInt(req.query.attention_limit as string, 10) || undefined,
        recentOrchestrations: parseInt(req.query.recent_orchestrations_limit as string, 10) || undefined,
        recentFiles: parseInt(req.query.recent_files_limit as string, 10) || undefined,
        recentHealthSignals: parseInt(req.query.recent_health_limit as string, 10) || undefined,
      };

      const overview = await buildProjectOverview(projectId, {
        agentId,
        limits,
      });
      res.json(overview);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }
      console.error('Get project overview error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * PATCH /v1/projects/:project_id
 * Update project (owner/admin only).
 */
router.patch(
  '/v1/projects/:project_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const project = await projectRepo.findOne({
        where: { id: req.params.project_id },
      });

      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      // Capture safe pre-update values for the audit trail. Raw webhook_secret
      // is never persisted in audit metadata; only its presence is recorded.
      const before = {
        name: project.name,
        description: project.description ?? null,
        visibility: project.visibility,
        status: project.status ?? ProjectStatus.ACTIVE,
        topics: project.topics ?? [],
        webhookUrl: project.webhookUrl ?? null,
        webhookEnabledEvents: project.webhookEnabledEvents ?? [],
        webhookSecret: project.webhookSecret ?? null,
        hadWebhookSecret: Boolean(project.webhookSecret),
        mainAgentId: project.mainAgentId ?? null,
      };

      const { name, description, visibility, status, webhook_url, webhook_secret, webhook_enabled_events, main_agent_id } = req.body;
      if (name !== undefined) project.name = name.trim();
      if (description !== undefined) project.description = description.trim();

      if (req.body.topics !== undefined) {
        const tv = validateTopics(req.body.topics);
        if (!tv.ok) {
          res.status(422).json({ detail: tv.detail });
          return;
        }
        project.topics = tv.topics;
      }
      if (visibility !== undefined) {
        if (!Object.values(ProjectVisibility).includes(visibility as ProjectVisibility)) {
          res.status(422).json({ detail: 'Invalid visibility. Must be private or public' });
          return;
        }
        project.visibility = visibility as ProjectVisibility;
      }
      if (status !== undefined) {
        if (!Object.values(ProjectStatus).includes(status as ProjectStatus)) {
          res.status(422).json({ detail: 'Invalid status. Must be active or archived' });
          return;
        }
        project.status = status as ProjectStatus;
      }
      if (webhook_url !== undefined) project.webhookUrl = webhook_url;
      if (webhook_secret !== undefined) project.webhookSecret = webhook_secret;
      if (webhook_enabled_events !== undefined) project.webhookEnabledEvents = webhook_enabled_events as any;
      if (main_agent_id !== undefined) project.mainAgentId = main_agent_id || null;

      await projectRepo.save(project);

      // Record a settings audit event when at least one audited field materially changes.
      const changedFields: string[] = [];
      const metadata: Record<string, unknown> = {};

      if (project.name !== before.name) {
        changedFields.push('name');
        metadata.previous_name = before.name;
        metadata.new_name = project.name;
      }

      const afterDescription = project.description ?? null;
      if (afterDescription !== before.description) {
        changedFields.push('description');
        metadata.previous_description = before.description;
        metadata.new_description = afterDescription;
      }

      if (project.visibility !== before.visibility) {
        changedFields.push('visibility');
        metadata.previous_visibility = before.visibility;
        metadata.new_visibility = project.visibility;
      }

      const afterStatus = project.status ?? ProjectStatus.ACTIVE;
      if (afterStatus !== before.status) {
        changedFields.push('status');
        metadata.previous_status = before.status;
        metadata.new_status = afterStatus;
      }

      const afterTopics = project.topics ?? [];
      if (!arraysEqual(afterTopics, before.topics)) {
        changedFields.push('topics');
        metadata.previous_topics = before.topics;
        metadata.new_topics = afterTopics;
      }

      const afterWebhookUrl = project.webhookUrl ?? null;
      if (afterWebhookUrl !== before.webhookUrl) {
        changedFields.push('webhook_url');
        metadata.previous_webhook_url = before.webhookUrl;
        metadata.new_webhook_url = afterWebhookUrl;
      }

      const afterWebhookEnabledEvents = project.webhookEnabledEvents ?? [];
      if (!arraysEqual(afterWebhookEnabledEvents, before.webhookEnabledEvents)) {
        changedFields.push('webhook_enabled_events');
        metadata.previous_webhook_enabled_events = before.webhookEnabledEvents;
        metadata.new_webhook_enabled_events = afterWebhookEnabledEvents;
      }

      const hasWebhookSecret = Boolean(project.webhookSecret);
      const afterWebhookSecret = project.webhookSecret ?? null;
      if (webhook_secret !== undefined && afterWebhookSecret !== before.webhookSecret) {
        changedFields.push('webhook_secret');
        metadata.had_webhook_secret = before.hadWebhookSecret;
        metadata.has_webhook_secret = hasWebhookSecret;
      }

      if (changedFields.length > 0) {
        metadata.changed_fields = changedFields;
        await auditRepo.save(
          auditRepo.create({
            projectId: project.id,
            actorUserId: req.user!.userId,
            action: ProjectAuditAction.PROJECT_SETTINGS_UPDATED,
            targetUserId: null,
            previousRole: null,
            newRole: null,
            metadataJson: metadata,
          }),
        ).catch((err) => console.error('Failed to record project_settings_updated audit:', err));
      }

      // Notify the agent when it is promoted to project-level main agent (PM role).
      // This is the moment the agent learns it now owns dispatch/review/merge across
      // the whole project, plus AGENTS.md maintenance. Best-effort: never fail the
      // settings update on a notification error.
      if (main_agent_id !== undefined && project.mainAgentId && project.mainAgentId !== before.mainAgentId) {
        createInboxItem({
          projectId: project.id,
          recipientAgentId: project.mainAgentId,
          eventType: 'promoted_to_main_agent',
          title: `You are now the main agent (PM) for project ${project.name}`,
          body: [
            `Project: ${project.name} (${project.id})`,
            '',
            'As the project-level main agent you now own these PM functions across ALL orchestrations:',
            '- Dispatch tasks to worker agents (POST .../orchestrations/:id/tasks with assigned_agent_id).',
            '- Review worker submissions: approve or request changes (PATCH .../tasks/:id/review).',
            '- Reassign stalled tasks (POST .../tasks/:id/reassign).',
            '- Review & merge changesets (PATCH .../changesets/:id/review + merge).',
            '- Maintain AGENTS.md (project rules every agent must follow).',
            '',
            'Workers receive tasks via their inbox (GET /v1/agent/inbox?unread=true). Keep your heartbeat alive.',
          ].join('\n'),
          payload: { project_id: project.id, project_name: project.name, role: 'main_agent' },
        }).catch((err) => console.error('Failed to notify promoted main agent:', err));
      }

      res.json(serializeProject(project));
    } catch (err) {
      console.error('Update project error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/archive
 * Archive project (owner/admin only). Requires exact project name confirmation.
 */
router.post(
  '/v1/projects/:project_id/archive',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const project = await projectRepo.findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const { confirm_project_name } = req.body;
      if (confirm_project_name !== project.name) {
        res.status(422).json({ detail: 'Project name confirmation does not match' });
        return;
      }

      if ((project.status ?? ProjectStatus.ACTIVE) === ProjectStatus.ARCHIVED) {
        res.json(serializeProject(project));
        return;
      }

      project.status = ProjectStatus.ARCHIVED;
      await projectRepo.save(project);

      await auditRepo.save(
        auditRepo.create({
          projectId: project.id,
          actorUserId: req.user!.userId,
          action: ProjectAuditAction.PROJECT_ARCHIVED,
          targetUserId: null,
          previousRole: null,
          newRole: null,
          metadataJson: { previous_status: ProjectStatus.ACTIVE, new_status: ProjectStatus.ARCHIVED },
        }),
      ).catch((err) => console.error('Failed to record project_archived audit:', err));

      res.json(serializeProject(project));
    } catch (err) {
      console.error('Archive project error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/unarchive
 * Unarchive project (owner/admin only). Requires exact project name confirmation.
 */
router.post(
  '/v1/projects/:project_id/unarchive',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const project = await projectRepo.findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const { confirm_project_name } = req.body;
      if (confirm_project_name !== project.name) {
        res.status(422).json({ detail: 'Project name confirmation does not match' });
        return;
      }

      if ((project.status ?? ProjectStatus.ACTIVE) !== ProjectStatus.ARCHIVED) {
        res.json(serializeProject(project));
        return;
      }

      project.status = ProjectStatus.ACTIVE;
      await projectRepo.save(project);

      await auditRepo.save(
        auditRepo.create({
          projectId: project.id,
          actorUserId: req.user!.userId,
          action: ProjectAuditAction.PROJECT_UNARCHIVED,
          targetUserId: null,
          previousRole: null,
          newRole: null,
          metadataJson: { previous_status: ProjectStatus.ARCHIVED, new_status: ProjectStatus.ACTIVE },
        }),
      ).catch((err) => console.error('Failed to record project_unarchived audit:', err));

      res.json(serializeProject(project));
    } catch (err) {
      console.error('Unarchive project error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/topics
 * Read project topics.
 * Requires ViewProject permission.
 */
router.get(
  '/v1/projects/:project_id/topics',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const project = await projectRepo.findOne({
        where: { id: req.params.project_id },
      });

      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      res.json({ topics: project.topics ?? [] });
    } catch (err) {
      console.error('Get project topics error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * PUT /v1/projects/:project_id/topics
 * Replace project topics.
 * Requires EditProject permission.
 */
router.put(
  '/v1/projects/:project_id/topics',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const project = await projectRepo.findOne({
        where: { id: req.params.project_id },
      });

      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const tv = validateTopics(req.body.topics);
      if (!tv.ok) {
        res.status(422).json({ detail: tv.detail });
        return;
      }

      const beforeTopics = project.topics ?? [];
      project.topics = tv.topics;

      await projectRepo.save(project);

      if (!arraysEqual(project.topics, beforeTopics)) {
        await auditRepo.save(
          auditRepo.create({
            projectId: project.id,
            actorUserId: req.user!.userId,
            action: ProjectAuditAction.PROJECT_SETTINGS_UPDATED,
            targetUserId: null,
            previousRole: null,
            newRole: null,
            metadataJson: {
              changed_fields: ['topics'],
              previous_topics: beforeTopics,
              new_topics: project.topics,
            },
          }),
        ).catch((err) => console.error('Failed to record project_settings_updated audit for topics:', err));
      }

      res.json({ topics: project.topics });
    } catch (err) {
      console.error('Update project topics error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/topics/search
 * Search distinct topics across projects visible to the caller.
 * Currently limited to projects where the caller is a member.
 */
router.get('/v1/projects/topics/search', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const q = (req.query.q as string)?.trim().toLowerCase();
    const limit = parseBoundedInt(req.query.limit, 20, 1, 100);
    const offset = parseBoundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const memberships = await memberRepo.find({
      where: { userId },
      select: ['projectId'],
    });
    const projectIds = memberships.map((m) => m.projectId);

    if (projectIds.length === 0) {
      res.json({ data: [], meta: { total: 0, limit, offset } });
      return;
    }

    const projects = await projectRepo.find({
      where: projectIds.map((id) => ({ id })),
      select: ['id', 'topics'],
    });

    const seen = new Set<string>();
    const distinctTopics: string[] = [];
    for (const project of projects) {
      for (const topic of project.topics ?? []) {
        const key = topic.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!q || key.includes(q)) {
          distinctTopics.push(topic);
        }
      }
    }

    distinctTopics.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    const total = distinctTopics.length;
    const paginated = distinctTopics.slice(offset, offset + limit);

    res.json({
      data: paginated,
      meta: { total, limit, offset },
    });
  } catch (err) {
    console.error('Search project topics error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * DELETE /v1/projects/:project_id
 * Delete project (owner only).
 */
router.delete(
  '/v1/projects/:project_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.DeleteProject),
  async (req: Request, res: Response) => {
    try {
      const project = await projectRepo.findOne({
        where: { id: req.params.project_id },
      });

      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      await projectRepo.remove(project);
      res.status(204).send();
    } catch (err) {
      console.error('Delete project error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/members
 * List project members with their roles and user info.
 * Requires ViewProject permission.
 */
router.get(
  '/v1/projects/:project_id/members',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const q = (req.query.q as string)?.trim();

      let members: ProjectMember[];

      if (q) {
        members = await memberRepo
          .createQueryBuilder('m')
          .leftJoinAndSelect('m.user', 'user')
          .where('m.projectId = :projectId', { projectId })
          .andWhere(
            '(LOWER(user.displayName) LIKE LOWER(:q) OR LOWER(user.email) LIKE LOWER(:q))',
            { q: `%${q}%` }
          )
          .getMany();
      } else {
        members = await memberRepo.find({
          where: { projectId },
          relations: ['user'],
        });
      }

      res.json({
        data: members.map((m) => ({
          id: m.id,
          user_id: m.userId,
          role: m.role,
          display_name: m.user?.displayName || null,
          email: m.user?.email || null,
          created_at: m.createdAt,
        })),
      });
    } catch (err) {
      console.error('List members error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/members
 * Invite a user to the project (Owner/Admin only).
 * Requires ManageMembers permission.
 */
router.post(
  '/v1/projects/:project_id/members',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ManageMembers),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const { user_id, role } = req.body;

      if (!user_id || typeof user_id !== 'string') {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'user_id'],
              msg: 'user_id is required and must be a string',
              type: 'missing',
            },
          ],
        });
        return;
      }

      let memberRole = ProjectRole.MEMBER;
      if (role) {
        if (!isAssignableMemberRole(role)) {
          res.status(422).json({
            detail: [
              {
                loc: ['body', 'role'],
                msg: `Invalid role. Must be one of: ${ASSIGNABLE_MEMBER_ROLES.join(', ')}`,
                type: 'invalid',
              },
            ],
          });
          return;
        }
        memberRole = role as ProjectRole;
      }

      // Check if user exists
      const userRepo = AppDataSource.getRepository(User);
      const user = await userRepo.findOne({ where: { id: user_id } });
      if (!user) {
        res.status(404).json({ detail: 'User not found' });
        return;
      }

      // Check if user is already a member
      const existing = await memberRepo.findOne({
        where: { projectId, userId: user_id },
      });
      if (existing) {
        res.status(409).json({ detail: 'User is already a member of this project' });
        return;
      }

      const member = memberRepo.create({
        projectId,
        userId: user_id,
        role: memberRole,
      });
      await memberRepo.save(member);

      // Record audit entry for member addition
      await recordMemberAudit(
        projectId,
        req.user!.userId,
        ProjectAuditAction.MEMBER_ADDED,
        user_id,
        null,
        memberRole,
      ).catch((err) => console.error('Failed to record member_added audit:', err));

      res.status(201).json({
        id: member.id,
        user_id: member.userId,
        role: member.role,
        created_at: member.createdAt,
      });
    } catch (err) {
      console.error('Invite member error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/owner-transfer
 * Transfer project ownership to an existing member (current owner only).
 * Requires explicit project-name confirmation.
 */
router.post(
  '/v1/projects/:project_id/owner-transfer',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ManageMembers),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const actorUserId = req.user!.userId;
      const { target_user_id, confirm_project_name } = req.body;

      if (!target_user_id || typeof target_user_id !== 'string') {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'target_user_id'],
              msg: 'target_user_id is required and must be a string',
              type: 'missing',
            },
          ],
        });
        return;
      }

      const project = await projectRepo.findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      if (project.ownerId !== actorUserId) {
        res.status(403).json({ detail: 'Only the current owner can transfer project ownership' });
        return;
      }

      if (confirm_project_name !== project.name) {
        res.status(422).json({ detail: 'Project name confirmation does not match' });
        return;
      }

      if (target_user_id === actorUserId) {
        res.status(422).json({ detail: 'Target user is already the project owner' });
        return;
      }

      const previousOwnerMember = await memberRepo.findOne({
        where: { projectId, userId: actorUserId },
      });
      const targetMember = await memberRepo.findOne({
        where: { projectId, userId: target_user_id },
      });

      if (!previousOwnerMember || previousOwnerMember.role !== ProjectRole.OWNER) {
        res.status(409).json({ detail: 'Current owner membership is inconsistent' });
        return;
      }
      if (!targetMember) {
        res.status(404).json({ detail: 'Target user must already be a project member' });
        return;
      }
      if (targetMember.role === ProjectRole.OWNER) {
        res.status(422).json({ detail: 'Target user is already the project owner' });
        return;
      }

      await AppDataSource.transaction(async (manager) => {
        const txProjectRepo = manager.getRepository(Project);
        const txMemberRepo = manager.getRepository(ProjectMember);
        const txAuditRepo = manager.getRepository(ProjectAuditEvent);

        project.ownerId = target_user_id;
        await txProjectRepo.save(project);

        previousOwnerMember.role = ProjectRole.ADMIN;
        targetMember.role = ProjectRole.OWNER;
        await txMemberRepo.save([previousOwnerMember, targetMember]);

        await txAuditRepo.save(
          txAuditRepo.create({
            projectId,
            actorUserId,
            action: ProjectAuditAction.OWNER_TRANSFERRED,
            targetUserId: target_user_id,
            previousRole: ProjectRole.OWNER,
            newRole: ProjectRole.OWNER,
            metadataJson: {
              previous_owner_user_id: actorUserId,
              new_owner_user_id: target_user_id,
            },
          }),
        );
      });

      const members = await memberRepo.find({
        where: { projectId },
        relations: ['user'],
      });
      const updatedProject = await projectRepo.findOneOrFail({ where: { id: projectId } });

      res.json({
        project: serializeProject(updatedProject),
        members: members.map((m) => ({
          id: m.id,
          user_id: m.userId,
          role: m.role,
          display_name: m.user?.displayName || null,
          email: m.user?.email || null,
          created_at: m.createdAt,
        })),
      });
    } catch (err) {
      console.error('Transfer owner error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * PATCH /v1/projects/:project_id/members/:user_id
 * Update a member's role (Owner/Admin only).
 * Requires ManageMembers permission.
 */
router.patch(
  '/v1/projects/:project_id/members/:user_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ManageMembers),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const targetUserId = req.params.user_id;
      const { role } = req.body;

      if (!role) {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'role'],
              msg: 'Role is required',
              type: 'missing',
            },
          ],
        });
        return;
      }

      if (!isAssignableMemberRole(role)) {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'role'],
              msg: `Invalid role. Must be one of: ${ASSIGNABLE_MEMBER_ROLES.join(', ')}`,
              type: 'invalid',
            },
          ],
        });
        return;
      }

      const member = await memberRepo.findOne({
        where: { projectId, userId: targetUserId },
      });
      if (!member) {
        res.status(404).json({ detail: 'Member not found' });
        return;
      }

      // Prevent demoting the sole owner
      if (member.role === ProjectRole.OWNER) {
        const ownerCount = await memberRepo.count({
          where: { projectId, role: ProjectRole.OWNER },
        });
        if (ownerCount <= 1) {
          res.status(422).json({ detail: 'Cannot demote the sole owner of the project' });
          return;
        }
      }

      const previousRole = member.role;
      member.role = role as ProjectRole;
      await memberRepo.save(member);

      // Record audit entry for role change
      await recordMemberAudit(
        projectId,
        req.user!.userId,
        ProjectAuditAction.MEMBER_ROLE_CHANGED,
        targetUserId,
        previousRole,
        role,
      ).catch((err) => console.error('Failed to record role_change audit:', err));

      res.json({
        id: member.id,
        user_id: member.userId,
        role: member.role,
        created_at: member.createdAt,
      });
    } catch (err) {
      console.error('Update member role error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * DELETE /v1/projects/:project_id/members/:user_id
 * Remove a member from the project (Owner/Admin only).
 * Requires ManageMembers permission.
 */
router.delete(
  '/v1/projects/:project_id/members/:user_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ManageMembers),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const targetUserId = req.params.user_id;

      const member = await memberRepo.findOne({
        where: { projectId, userId: targetUserId },
      });
      if (!member) {
        res.status(404).json({ detail: 'Member not found' });
        return;
      }

      // Prevent removing the sole owner, regardless of who sends the request.
      if (member.role === ProjectRole.OWNER) {
        const ownerCount = await memberRepo.count({
          where: { projectId, role: ProjectRole.OWNER },
        });
        if (ownerCount <= 1) {
          res.status(422).json({ detail: 'Cannot remove the sole owner of the project' });
          return;
        }
      }

      const removedRole = member.role;
      await memberRepo.remove(member);

      // Record audit entry for member removal
      await recordMemberAudit(
        projectId,
        req.user!.userId,
        ProjectAuditAction.MEMBER_REMOVED,
        targetUserId,
        removedRole,
        null,
      ).catch((err) => console.error('Failed to record member_removed audit:', err));

      res.status(204).send();
    } catch (err) {
      console.error('Remove member error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/audit-events
 * List project audit events, most recent first.
 * Requires ViewProject permission.
 *
 * Query parameters:
 * - limit:  max rows to return (default 20, max 100).
 * - offset: number of rows to skip before returning results (default 0).
 * - action: filter to a specific ProjectAuditAction value.
 * - q:      free-text search across action, actor/target display names and emails,
 *           and non-sensitive metadata values.
 */
router.get(
  '/v1/projects/:project_id/audit-events',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const limit = parseBoundedInt(req.query.limit, 20, 1, 100);
      const offset = parseBoundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const action = req.query.action as string | undefined;
      const q = (req.query.q as string)?.trim();

      const qb = auditRepo
        .createQueryBuilder('ae')
        .leftJoinAndSelect('ae.actor', 'actor')
        .leftJoinAndSelect('ae.target', 'target')
        .where('ae.projectId = :projectId', { projectId })
        .orderBy('ae.createdAt', 'DESC')
        .addOrderBy('ae.id', 'DESC');

      if (action && Object.values(ProjectAuditAction).includes(action as ProjectAuditAction)) {
        qb.andWhere('ae.action = :action', { action });
      }

      // Fetch a bounded superset so in-memory text search stays predictable.
      const FETCH_CAP = 1000;
      const [rawEvents, rawTotal] = await qb.skip(0).take(FETCH_CAP).getManyAndCount();

      let events = rawEvents;
      if (q) {
        events = events.filter((event) => auditEventMatchesSearch(event, q));
      }

      const total = q ? events.length : rawTotal;
      const paginated = events.slice(offset, offset + limit);

      res.json({
        data: paginated.map(serializeAuditEvent),
        total,
        limit,
        offset,
      });
    } catch (err) {
      console.error('List audit events error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/audit-events/compliance
 * Read-only compliance summary for the project audit trail.
 * Requires ViewProject permission.
 *
 * Returns deterministic aggregates derived from real ProjectAuditEvent rows:
 * total event count, oldest/newest timestamps, per-action counts, and policy
 * metadata for export availability, redaction, retention, and attestation.
 * No raw metadata values, secrets, or bodies are exposed.
 */
router.get(
  '/v1/projects/:project_id/audit-events/compliance',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const project = await projectRepo.findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const totalEvents = await auditRepo.count({ where: { projectId } });
      const retentionDays = project.auditRetentionDays ?? null;
      const legalHoldEnabled = Boolean(project.auditLegalHoldEnabled);
      const cutoff = retentionDays ? auditRetentionCutoff(retentionDays) : null;
      const retentionEligibleEvents = cutoff
        ? await auditRepo
            .createQueryBuilder('ae')
            .where('ae.projectId = :projectId', { projectId })
            .andWhere('ae.createdAt < :cutoff', { cutoff })
            .getCount()
        : 0;

      const range = await auditRepo
        .createQueryBuilder('ae')
        .select('MIN(ae.createdAt)', 'oldest')
        .addSelect('MAX(ae.createdAt)', 'newest')
        .where('ae.projectId = :projectId', { projectId })
        .getRawOne<{ oldest: Date | string | null; newest: Date | string | null }>();

      const rawActionCounts = await auditRepo
        .createQueryBuilder('ae')
        .select('ae.action', 'action')
        .addSelect('COUNT(*)', 'count')
        .where('ae.projectId = :projectId', { projectId })
        .groupBy('ae.action')
        .orderBy('ae.action', 'ASC')
        .getRawMany<{ action: string; count: string | number }>();

      const actionCounts: Record<string, number> = {};
      for (const row of rawActionCounts) {
        actionCounts[row.action] = parseInt(String(row.count), 10) || 0;
      }

      const attestation = await materializeAndVerifyProjectAuditChain(projectId);

      res.json({
        project_id: projectId,
        total_events: totalEvents,
        oldest_event_at: normalizeTimestamp(range?.oldest),
        newest_event_at: normalizeTimestamp(range?.newest),
        action_counts: actionCounts,
        export: {
          available: true,
          formats: ['json', 'csv'],
        },
        redaction_policy: {
          strategy: 'key_based',
          sensitive_keys: Array.from(SENSITIVE_METADATA_KEYS).sort(),
          description:
            'Metadata values for sensitive keys are removed before export and summary views.',
        },
        retention_policy: {
          configured: retentionDays !== null,
          status: retentionDays === null
            ? 'not_configured'
            : legalHoldEnabled
              ? 'blocked_by_legal_hold'
              : 'active',
          retention_days: retentionDays,
          cutoff_at: cutoff ? cutoff.toISOString() : null,
          eligible_event_count: retentionEligibleEvents,
          description:
            retentionDays === null
              ? 'No retention period is configured; audit events are retained indefinitely until explicitly removed.'
              : legalHoldEnabled
                ? 'Retention pruning is configured but blocked while legal hold is enabled.'
                : 'Audit events older than the configured retention period are eligible for explicit pruning.',
        },
        legal_hold: {
          enabled: legalHoldEnabled,
          status: legalHoldEnabled ? 'enabled' : 'disabled',
          description: legalHoldEnabled
            ? 'Legal hold blocks audit retention pruning for this project.'
            : 'Legal hold is disabled; configured retention pruning may be run explicitly by project admins.',
        },
        immutable_attestation: attestation,
      });
    } catch (err) {
      console.error('Get audit compliance summary error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:project_id/audit-events/attestation
 * Verify the local audit hash chain for the project.
 */
router.get(
  '/v1/projects/:project_id/audit-events/attestation',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const project = await projectRepo.findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const attestation = await materializeAndVerifyProjectAuditChain(projectId);
      res.json({
        project_id: projectId,
        immutable_attestation: attestation,
      });
    } catch (err) {
      console.error('Get audit attestation error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * PATCH /v1/projects/:project_id/audit-events/compliance-policy
 * Configure local audit retention and legal hold policy.
 */
router.patch(
  '/v1/projects/:project_id/audit-events/compliance-policy',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const project = await projectRepo.findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const before = {
        retentionDays: project.auditRetentionDays ?? null,
        legalHoldEnabled: Boolean(project.auditLegalHoldEnabled),
      };

      if (Object.prototype.hasOwnProperty.call(req.body, 'retention_days')) {
        const parsed = parseAuditRetentionDays(req.body.retention_days);
        if (!parsed.ok) {
          res.status(422).json({ detail: parsed.detail });
          return;
        }
        project.auditRetentionDays = parsed.value;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'legal_hold_enabled')) {
        if (typeof req.body.legal_hold_enabled !== 'boolean') {
          res.status(422).json({ detail: 'legal_hold_enabled must be a boolean' });
          return;
        }
        project.auditLegalHoldEnabled = req.body.legal_hold_enabled;
      }

      await projectRepo.save(project);

      const after = {
        retentionDays: project.auditRetentionDays ?? null,
        legalHoldEnabled: Boolean(project.auditLegalHoldEnabled),
      };
      const changedFields: string[] = [];
      const metadata: Record<string, unknown> = {};

      if (after.retentionDays !== before.retentionDays) {
        changedFields.push('retention_days');
        metadata.previous_retention_days = before.retentionDays;
        metadata.new_retention_days = after.retentionDays;
      }
      if (after.legalHoldEnabled !== before.legalHoldEnabled) {
        changedFields.push('legal_hold_enabled');
        metadata.previous_legal_hold_enabled = before.legalHoldEnabled;
        metadata.new_legal_hold_enabled = after.legalHoldEnabled;
      }

      if (changedFields.length > 0) {
        metadata.changed_fields = changedFields;
        await auditRepo.save(
          auditRepo.create({
            projectId,
            actorUserId: req.user!.userId,
            action: ProjectAuditAction.AUDIT_RETENTION_POLICY_UPDATED,
            targetUserId: null,
            previousRole: null,
            newRole: null,
            metadataJson: metadata,
          }),
        ).catch((err) => console.error('Failed to record audit_retention_policy_updated audit:', err));
      }

      res.json({
        project_id: projectId,
        retention_policy: {
          configured: after.retentionDays !== null,
          retention_days: after.retentionDays,
          status: after.retentionDays === null
            ? 'not_configured'
            : after.legalHoldEnabled
              ? 'blocked_by_legal_hold'
              : 'active',
        },
        legal_hold: {
          enabled: after.legalHoldEnabled,
          status: after.legalHoldEnabled ? 'enabled' : 'disabled',
        },
      });
    } catch (err) {
      console.error('Update audit compliance policy error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/audit-events/retention-prune
 * Explicitly prune audit events older than the configured retention period.
 */
router.post(
  '/v1/projects/:project_id/audit-events/retention-prune',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const project = await projectRepo.findOne({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const retentionDays = project.auditRetentionDays ?? null;
      if (retentionDays === null) {
        res.status(409).json({
          detail: 'Audit retention policy is not configured',
          code: 'audit_retention_not_configured',
        });
        return;
      }

      if (project.auditLegalHoldEnabled) {
        res.status(409).json({
          detail: 'Audit retention pruning is blocked by legal hold',
          code: 'audit_legal_hold_enabled',
        });
        return;
      }

      const cutoff = auditRetentionCutoff(retentionDays);
      const pruneResult = await auditRepo
        .createQueryBuilder()
        .delete()
        .from(ProjectAuditEvent)
        .where('project_id = :projectId', { projectId })
        .andWhere('created_at < :cutoff', { cutoff })
        .execute();
      const prunedCount = pruneResult.affected ?? 0;

      await auditRepo.save(
        auditRepo.create({
          projectId,
          actorUserId: req.user!.userId,
          action: ProjectAuditAction.AUDIT_RETENTION_PRUNED,
          targetUserId: null,
          previousRole: null,
          newRole: null,
          metadataJson: {
            retention_days: retentionDays,
            cutoff_at: cutoff.toISOString(),
            pruned_count: prunedCount,
          },
        }),
      );

      res.json({
        project_id: projectId,
        retention_days: retentionDays,
        cutoff_at: cutoff.toISOString(),
        pruned_count: prunedCount,
        legal_hold_enabled: false,
      });
    } catch (err) {
      console.error('Prune audit retention events error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:project_id/audit-events/export
 * Export project audit events as JSON or CSV.
 * Requires ViewProject permission.
 *
 * Query parameters:
 * - format: required, either `json` or `csv`.
 * - limit:  max rows to export (default 100, cap 1000).
 * - offset: rows to skip after filtering (default 0).
 * - action: filter to a specific ProjectAuditAction value.
 * - q:      free-text search across action, actor/target display names and emails,
 *           and non-sensitive metadata values.
 */
router.get(
  '/v1/projects/:project_id/audit-events/export',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const format = (req.query.format as string)?.toLowerCase();
      const limit = parseBoundedInt(req.query.limit, 100, 1, 1000);
      const offset = parseBoundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const action = req.query.action as string | undefined;
      const q = (req.query.q as string)?.trim();

      if (!format || (format !== 'json' && format !== 'csv')) {
        res.status(422).json({ detail: 'Invalid or missing format. Must be json or csv' });
        return;
      }

      const qb = auditRepo
        .createQueryBuilder('ae')
        .leftJoinAndSelect('ae.actor', 'actor')
        .leftJoinAndSelect('ae.target', 'target')
        .where('ae.projectId = :projectId', { projectId })
        .orderBy('ae.createdAt', 'DESC')
        .addOrderBy('ae.id', 'DESC');

      if (action && Object.values(ProjectAuditAction).includes(action as ProjectAuditAction)) {
        qb.andWhere('ae.action = :action', { action });
      }

      const FETCH_CAP = 5000;
      const rawEvents = await qb.skip(0).take(FETCH_CAP).getMany();

      let events = rawEvents;
      if (q) {
        events = events.filter((event) => auditEventMatchesSearch(event, q));
      }

      const paginated = events.slice(offset, offset + limit);

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="audit-events.json"');
        res.send(JSON.stringify(paginated.map(serializeAuditEvent), null, 2));
        return;
      }

      // CSV export
      const columns = [
        'id',
        'project_id',
        'actor_user_id',
        'actor_display_name',
        'actor_email',
        'target_user_id',
        'target_display_name',
        'target_email',
        'action',
        'previous_role',
        'new_role',
        'metadata',
        'created_at',
      ];
      let csv = toCsvRow(columns);
      for (const event of paginated) {
        const serialized = serializeAuditEvent(event);
        csv += toCsvRow([
          serialized.id,
          serialized.project_id,
          serialized.actor_user_id,
          serialized.actor_display_name,
          serialized.actor_email,
          serialized.target_user_id,
          serialized.target_display_name,
          serialized.target_email,
          serialized.action,
          serialized.previous_role,
          serialized.new_role,
          JSON.stringify(serialized.metadata),
          serialized.created_at,
        ]);
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-events.csv"');
      res.send(csv);
    } catch (err) {
      console.error('Export audit events error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/webhook-deliveries
 * List project webhook delivery history, newest first.
 * Requires ViewProject permission.
 *
 * Query parameters:
 * - limit:  max rows to return (default 20, max 100).
 * - offset: number of rows to skip before returning results (default 0).
 * - status: filter to a specific WebhookDeliveryStatus value.
 */
router.get(
  '/v1/projects/:project_id/webhook-deliveries',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const limit = parseBoundedInt(req.query.limit, 20, 1, 100);
      const offset = parseBoundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const status = req.query.status as string | undefined;

      const qb = deliveryRepo
        .createQueryBuilder('wd')
        .where('wd.projectId = :projectId', { projectId })
        .orderBy('wd.createdAt', 'DESC')
        .addOrderBy('wd.id', 'DESC');

      if (status && Object.values(WebhookDeliveryStatus).includes(status as WebhookDeliveryStatus)) {
        qb.andWhere('wd.status = :status', { status });
      }

      const [rawDeliveries, total] = await qb.skip(offset).take(limit).getManyAndCount();

      res.json({
        data: rawDeliveries.map(serializeWebhookDelivery),
        total,
        limit,
        offset,
      });
    } catch (err) {
      console.error('List webhook deliveries error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
