import { Router, Request, Response, NextFunction } from 'express';
import { authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission, Role } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { ProjectWorkSavedQuery, ProjectWorkSavedQueryScope } from '../entities/project-work-saved-query.entity';

const router = Router();
const queryRepo = AppDataSource.getRepository(ProjectWorkSavedQuery);

const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_QUERY_BYTES = 10_000;

const ALLOWED_STATUS_GROUPS = new Set(['open', 'review', 'blocked', 'done']);
const ALLOWED_TASK_STATUSES = new Set([
  'pending', 'dispatched', 'running', 'ready_for_review', 'approved', 'changes_requested', 'blocked', 'failed', 'cancelled',
]);
const ALLOWED_SAVED_VIEWS = new Set(['my_open', 'review', 'has_artifacts', 'linked', 'blocked']);
const ALLOWED_QUERY_KEYS = new Set([
  'status',
  'saved_view',
  'search',
  'agent',
  'has_artifacts',
  'has_links',
  'has_blockers',
]);

function canMutateSavedQueries(req: Request): boolean {
  const role = (req as any).projectRole as Role | undefined;
  return role === Role.Owner || role === Role.Admin || role === Role.Member;
}

function rejectAgentApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.agent) {
    res.status(403).json({ detail: 'Agent API keys cannot access work saved queries' });
    return;
  }
  next();
}

function serializeQuery(query: ProjectWorkSavedQuery) {
  return {
    id: query.id,
    project_id: query.projectId,
    name: query.name,
    description: query.description ?? null,
    scope: query.scope,
    query: query.query,
    created_by: query.createdBy,
    updated_by: query.updatedBy,
    created_at: query.createdAt,
    updated_at: query.updatedAt,
  };
}

function normalizeName(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'name is required' };
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `name must be ${MAX_NAME_LENGTH} characters or fewer` };
  }
  if (!/[\p{L}\p{N}]/u.test(trimmed)) {
    return { ok: false, error: 'name must contain at least one letter or number' };
  }
  return { ok: true, value: trimmed };
}

function normalizeDescription(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') {
    return { ok: false, error: 'description must be a string' };
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` };
  }
  return { ok: true, value: trimmed || null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateQuery(value: unknown): { ok: true; query: Record<string, unknown> } | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'query must be an object' };
  }

  const keys = Object.keys(value);
  const unsupported = keys.find((key) => !ALLOWED_QUERY_KEYS.has(key));
  if (unsupported) {
    return { ok: false, error: `unsupported query field: ${unsupported}` };
  }

  const query: Record<string, unknown> = {};

  if ('status' in value) {
    const status = value.status;
    if (status !== undefined && status !== null) {
      const statuses = Array.isArray(status) ? status : (typeof status === 'string' ? status.split(',').map((s) => s.trim()).filter(Boolean) : []);
      if (!statuses.every((s) => typeof s === 'string' && (ALLOWED_STATUS_GROUPS.has(s) || ALLOWED_TASK_STATUSES.has(s)))) {
        return { ok: false, error: 'status must contain valid task status or status group values' };
      }
      if (statuses.length === 0) {
        return { ok: false, error: 'status array must not be empty' };
      }
      query.status = statuses;
    }
  }

  if ('saved_view' in value) {
    const savedView = value.saved_view;
    if (savedView !== undefined && savedView !== null) {
      if (typeof savedView !== 'string' || !ALLOWED_SAVED_VIEWS.has(savedView)) {
        return { ok: false, error: 'saved_view must be a built-in saved view key' };
      }
      query.saved_view = savedView;
    }
  }

  if ('search' in value) {
    const search = value.search;
    if (search !== undefined && search !== null) {
      if (typeof search !== 'string') {
        return { ok: false, error: 'search must be a string' };
      }
      const trimmed = search.trim();
      if (trimmed.length > 255) {
        return { ok: false, error: 'search must be 255 characters or fewer' };
      }
      if (trimmed) {
        query.search = trimmed;
      }
    }
  }

  if ('agent' in value) {
    const agent = value.agent;
    if (agent !== undefined && agent !== null) {
      if (typeof agent !== 'string' || !agent.trim()) {
        return { ok: false, error: 'agent must be a non-empty string' };
      }
      query.agent = agent.trim();
    }
  }

  if ('has_artifacts' in value) {
    const hasArtifacts = value.has_artifacts;
    if (hasArtifacts !== undefined && hasArtifacts !== null) {
      if (typeof hasArtifacts !== 'boolean') {
        return { ok: false, error: 'has_artifacts must be a boolean' };
      }
      query.has_artifacts = hasArtifacts;
    }
  }

  if ('has_links' in value) {
    const hasLinks = value.has_links;
    if (hasLinks !== undefined && hasLinks !== null) {
      if (typeof hasLinks !== 'boolean') {
        return { ok: false, error: 'has_links must be a boolean' };
      }
      query.has_links = hasLinks;
    }
  }

  if ('has_blockers' in value) {
    const hasBlockers = value.has_blockers;
    if (hasBlockers !== undefined && hasBlockers !== null) {
      if (typeof hasBlockers !== 'boolean') {
        return { ok: false, error: 'has_blockers must be a boolean' };
      }
      query.has_blockers = hasBlockers;
    }
  }

  if (Object.keys(query).length === 0) {
    return { ok: false, error: 'query must contain at least one supported filter' };
  }

  const encoded = JSON.stringify(query);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_QUERY_BYTES) {
    return { ok: false, error: `query must be ${MAX_QUERY_BYTES} bytes or fewer` };
  }

  return { ok: true, query };
}

router.get(
  '/v1/projects/:project_id/work-saved-queries',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  rejectAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const queries = await queryRepo.find({
        where: { projectId },
        order: { updatedAt: 'DESC' },
      });
      res.json({ data: queries.map(serializeQuery) });
    } catch (err) {
      console.error('List work saved queries error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/work-saved-queries',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  rejectAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      if (!canMutateSavedQueries(req)) {
        res.status(403).json({ detail: 'Only project owner, admin, or member can create saved queries' });
        return;
      }

      const projectId = req.params.project_id;
      const userId = req.user!.userId;

      const nameResult = normalizeName(req.body.name);
      if (!nameResult.ok) {
        res.status(422).json({ detail: nameResult.error });
        return;
      }

      const descriptionResult = normalizeDescription(req.body.description);
      if (!descriptionResult.ok) {
        res.status(422).json({ detail: descriptionResult.error });
        return;
      }

      const queryResult = validateQuery(req.body.query);
      if (!queryResult.ok) {
        res.status(422).json({ detail: queryResult.error });
        return;
      }

      const existing = await queryRepo.findOne({ where: { projectId, name: nameResult.value } });
      if (existing) {
        res.status(409).json({ detail: 'A saved query with this name already exists' });
        return;
      }

      const savedQuery = queryRepo.create({
        projectId,
        name: nameResult.value,
        description: descriptionResult.value,
        scope: ProjectWorkSavedQueryScope.WORK,
        query: queryResult.query as any,
        createdBy: userId,
        updatedBy: userId,
      });
      await queryRepo.save(savedQuery);

      res.status(201).json(serializeQuery(savedQuery));
    } catch (err) {
      console.error('Create work saved query error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/work-saved-queries/:query_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  rejectAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      if (!canMutateSavedQueries(req)) {
        res.status(403).json({ detail: 'Only project owner, admin, or member can update saved queries' });
        return;
      }

      const projectId = req.params.project_id;
      const queryId = req.params.query_id;
      const userId = req.user!.userId;

      const savedQuery = await queryRepo.findOne({ where: { id: queryId, projectId } });
      if (!savedQuery) {
        res.status(404).json({ detail: 'Saved query not found' });
        return;
      }

      const { name, description, query } = req.body;

      if (name !== undefined) {
        const nameResult = normalizeName(name);
        if (!nameResult.ok) {
          res.status(422).json({ detail: nameResult.error });
          return;
        }
        if (nameResult.value !== savedQuery.name) {
          const existing = await queryRepo.findOne({ where: { projectId, name: nameResult.value } });
          if (existing && existing.id !== queryId) {
            res.status(409).json({ detail: 'A saved query with this name already exists' });
            return;
          }
        }
        savedQuery.name = nameResult.value;
      }

      if (description !== undefined) {
        const descriptionResult = normalizeDescription(description);
        if (!descriptionResult.ok) {
          res.status(422).json({ detail: descriptionResult.error });
          return;
        }
        savedQuery.description = descriptionResult.value;
      }

      if (query !== undefined) {
        const queryResult = validateQuery(query);
        if (!queryResult.ok) {
          res.status(422).json({ detail: queryResult.error });
          return;
        }
        savedQuery.query = queryResult.query as any;
      }

      savedQuery.updatedBy = userId;
      await queryRepo.save(savedQuery);

      res.json(serializeQuery(savedQuery));
    } catch (err) {
      console.error('Update work saved query error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.delete(
  '/v1/projects/:project_id/work-saved-queries/:query_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  rejectAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      if (!canMutateSavedQueries(req)) {
        res.status(403).json({ detail: 'Only project owner, admin, or member can delete saved queries' });
        return;
      }

      const projectId = req.params.project_id;
      const queryId = req.params.query_id;

      const savedQuery = await queryRepo.findOne({ where: { id: queryId, projectId } });
      if (!savedQuery) {
        res.status(404).json({ detail: 'Saved query not found' });
        return;
      }

      await queryRepo.remove(savedQuery);
      res.status(204).send();
    } catch (err) {
      console.error('Delete work saved query error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
