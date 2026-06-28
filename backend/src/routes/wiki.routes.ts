import { Router, Request, Response } from 'express';
import { authenticate, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { WikiPage } from '../entities/wiki-page.entity';
import { ProjectAuditAction } from '../entities/project-audit-event.entity';
import { recordProjectModuleAudit } from '../services/project-audit.service';

const router = Router();
const wikiRepo = AppDataSource.getRepository(WikiPage);

/**
 * Normalize a title or raw slug into a URL-safe slug.
 * - Lowercase
 * - Replace non-alphanumeric chars with hyphens
 * - Collapse consecutive hyphens
 * - Strip leading/trailing hyphens
 * - Truncate to 255 chars
 */
function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}

/**
 * Serialize a wiki page for API response (snake_case keys).
 */
function serializePage(page: WikiPage) {
  return {
    id: page.id,
    project_id: page.projectId,
    slug: page.slug,
    title: page.title,
    content: page.content,
    revision: page.revision,
    created_by: page.createdBy,
    updated_by: page.updatedBy,
    created_at: page.createdAt,
    updated_at: page.updatedAt,
  };
}

/**
 * Serialize a wiki page summary (no content) for list responses.
 */
function serializePageSummary(page: WikiPage) {
  return {
    id: page.id,
    project_id: page.projectId,
    slug: page.slug,
    title: page.title,
    revision: page.revision,
    created_by: page.createdBy,
    updated_by: page.updatedBy,
    created_at: page.createdAt,
    updated_at: page.updatedAt,
  };
}

/**
 * GET /v1/projects/:project_id/wiki
 * List wiki pages for a project (summary fields only, no content).
 * Requires ViewProject permission.
 * Sorted by updated_at DESC, then title ASC.
 */
router.get(
  '/v1/projects/:project_id/wiki',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);

      const [pages, total] = await wikiRepo.findAndCount({
        where: { projectId },
        order: { updatedAt: 'DESC', title: 'ASC' },
        skip,
        take: limit,
      });

      res.json({
        data: pages.map(serializePageSummary),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List wiki pages error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:project_id/wiki/:slug
 * Get a single wiki page by slug (full content).
 * Requires ViewProject permission.
 */
router.get(
  '/v1/projects/:project_id/wiki/:slug',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const slug = normalizeSlug(req.params.slug);

      const page = await wikiRepo.findOne({
        where: { projectId, slug },
      });

      if (!page) {
        res.status(404).json({ detail: 'Wiki page not found' });
        return;
      }

      res.json(serializePage(page));
    } catch (err) {
      console.error('Get wiki page error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/wiki
 * Create a new wiki page.
 * Requires EditProject permission (owner/admin).
 * Returns 409 if slug already exists.
 */
router.post(
  '/v1/projects/:project_id/wiki',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user!.userId;
      const { title, content, slug: rawSlug } = req.body;

      // Validate title
      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        res.status(422).json({
          detail: [{ loc: ['body', 'title'], msg: 'Title is required', type: 'missing' }],
        });
        return;
      }

      // Validate content
      if (content === undefined || content === null || typeof content !== 'string') {
        res.status(422).json({
          detail: [{ loc: ['body', 'content'], msg: 'Content is required', type: 'missing' }],
        });
        return;
      }

      // Derive slug from title if not provided
      const slug = normalizeSlug(rawSlug || title);
      if (!slug) {
        res.status(422).json({
          detail: [{ loc: ['body', 'slug'], msg: 'Slug must contain at least one alphanumeric character', type: 'invalid' }],
        });
        return;
      }

      // Check for duplicate slug
      const existing = await wikiRepo.findOne({ where: { projectId, slug } });
      if (existing) {
        res.status(409).json({ detail: 'A wiki page with this slug already exists' });
        return;
      }

      // Enforce content/title bounds
      if (title.length > 500) {
        res.status(422).json({
          detail: [{ loc: ['body', 'title'], msg: 'Title must be 500 characters or fewer', type: 'too_long' }],
        });
        return;
      }
      if (content.length > 1_000_000) {
        res.status(422).json({
          detail: [{ loc: ['body', 'content'], msg: 'Content must be 1,000,000 characters or fewer', type: 'too_long' }],
        });
        return;
      }

      const page = wikiRepo.create({
        projectId,
        slug,
        title: title.trim(),
        content,
        revision: 1,
        createdBy: userId,
        updatedBy: userId,
      });

      await wikiRepo.save(page);

      await recordProjectModuleAudit(
        projectId,
        userId,
        ProjectAuditAction.WIKI_PAGE_CREATED,
        { type: 'wiki_page', id: page.id, name: page.title },
        { slug: page.slug },
      ).catch((err) => console.error('Failed to record wiki_page_created audit:', err));

      res.status(201).json(serializePage(page));
    } catch (err) {
      console.error('Create wiki page error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * PATCH /v1/projects/:project_id/wiki/:slug
 * Update an existing wiki page (title and/or content).
 * Requires EditProject permission (owner/admin).
 * Increments revision. Returns 404 if page not found.
 */
router.patch(
  '/v1/projects/:project_id/wiki/:slug',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user!.userId;
      const slug = normalizeSlug(req.params.slug);

      const page = await wikiRepo.findOne({
        where: { projectId, slug },
      });

      if (!page) {
        res.status(404).json({ detail: 'Wiki page not found' });
        return;
      }

      const beforeTitle = page.title;
      const { title, content } = req.body;

      if (title !== undefined) {
        if (typeof title !== 'string' || title.trim().length === 0) {
          res.status(422).json({
            detail: [{ loc: ['body', 'title'], msg: 'Title must be a non-empty string', type: 'invalid' }],
          });
          return;
        }
        if (title.length > 500) {
          res.status(422).json({
            detail: [{ loc: ['body', 'title'], msg: 'Title must be 500 characters or fewer', type: 'too_long' }],
          });
          return;
        }
        page.title = title.trim();
      }

      const contentChanged = content !== undefined;
      if (contentChanged) {
        if (typeof content !== 'string') {
          res.status(422).json({
            detail: [{ loc: ['body', 'content'], msg: 'Content must be a string', type: 'invalid' }],
          });
          return;
        }
        if (content.length > 1_000_000) {
          res.status(422).json({
            detail: [{ loc: ['body', 'content'], msg: 'Content must be 1,000,000 characters or fewer', type: 'too_long' }],
          });
          return;
        }
        page.content = content;
      }

      page.revision += 1;
      page.updatedBy = userId;

      await wikiRepo.save(page);

      const changedFields: string[] = [];
      const metadata: Record<string, unknown> = { slug: page.slug };
      if (page.title !== beforeTitle) {
        changedFields.push('title');
        metadata.previous_title = beforeTitle;
        metadata.new_title = page.title;
      }
      if (contentChanged) {
        changedFields.push('content');
      }

      if (changedFields.length > 0) {
        metadata.changed_fields = changedFields;
        await recordProjectModuleAudit(
          projectId,
          userId,
          ProjectAuditAction.WIKI_PAGE_UPDATED,
          { type: 'wiki_page', id: page.id, name: page.title },
          metadata,
        ).catch((err) => console.error('Failed to record wiki_page_updated audit:', err));
      }

      res.json(serializePage(page));
    } catch (err) {
      console.error('Update wiki page error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
