import { Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { authenticate, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { ProjectRelease } from '../entities/project-release.entity';
import { ProjectCommit } from '../entities/project-commit.entity';
import { ProjectAuditAction } from '../entities/project-audit-event.entity';
import { recordProjectModuleAudit } from '../services/project-audit.service';

const router = Router();
const releaseRepo = AppDataSource.getRepository(ProjectRelease);
const commitRepo = AppDataSource.getRepository(ProjectCommit);

// ─── Constants ─────────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 255;
const MAX_TAG_LENGTH = 255;
const MAX_BODY_LENGTH = 1_000_000;
const MAX_COMMIT_ID_LENGTH = 255;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Normalize a tag name: lowercase, trim, collapse whitespace to hyphens.
 * This ensures consistent storage and comparison.
 */
function normalizeTagName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

/**
 * Serialize a release for API response (snake_case keys).
 */
function serializeRelease(release: ProjectRelease) {
  return {
    id: release.id,
    project_id: release.projectId,
    title: release.title,
    tag_name: release.tagName,
    target_commit_id: release.targetCommitId,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    created_by: release.createdBy,
    updated_by: release.updatedBy,
    created_at: release.createdAt,
    updated_at: release.updatedAt,
    published_at: release.publishedAt,
  };
}

/**
 * Serialize a release summary for list responses (no body).
 */
function serializeReleaseSummary(release: ProjectRelease) {
  return {
    id: release.id,
    project_id: release.projectId,
    title: release.title,
    tag_name: release.tagName,
    target_commit_id: release.targetCommitId,
    draft: release.draft,
    prerelease: release.prerelease,
    created_by: release.createdBy,
    updated_by: release.updatedBy,
    created_at: release.createdAt,
    updated_at: release.updatedAt,
    published_at: release.publishedAt,
  };
}

function serializeTagCommitSummary(commit: ProjectCommit) {
  return {
    id: commit.id,
    project_id: commit.projectId,
    branch_id: commit.branchId,
    parent_commit_id: commit.parentCommitId ?? null,
    message: commit.message,
    changed_files: commit.changedFiles,
    changeset_id: commit.changesetId ?? null,
    created_by_user_id: commit.createdByUserId ?? null,
    created_by_agent_id: commit.createdByAgentId ?? null,
    created_at: commit.createdAt,
  };
}

function serializeProjectTag(release: ProjectRelease, commit?: ProjectCommit) {
  return {
    tag_name: release.tagName,
    release_id: release.id,
    release_title: release.title,
    target_commit_id: release.targetCommitId,
    target_commit: commit ? serializeTagCommitSummary(commit) : null,
    draft: release.draft,
    prerelease: release.prerelease,
    published_at: release.publishedAt,
    created_at: release.createdAt,
    updated_at: release.updatedAt,
  };
}

// ─── Routes ────────────────────────────────────────────────────────────────

/**
 * GET /v1/projects/:project_id/releases
 * List releases for a project (summary fields only, no body).
 * Requires ViewProject permission.
 * Sorted by created_at DESC.
 */
router.get(
  '/v1/projects/:project_id/releases',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);

      const [releases, total] = await releaseRepo.findAndCount({
        where: { projectId },
        order: { createdAt: 'DESC' },
        skip,
        take: limit,
      });

      res.json({
        data: releases.map(serializeReleaseSummary),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List releases error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:project_id/tags
 * List release-backed tags for a project.
 * Requires ViewProject permission.
 * Sorted by release recency.
 */
router.get(
  '/v1/projects/:project_id/tags',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);

      const [releases, total] = await releaseRepo.findAndCount({
        where: { projectId },
        order: { publishedAt: 'DESC', createdAt: 'DESC' },
        skip,
        take: limit,
      });

      const targetCommitIds = Array.from(
        new Set(releases.map((release) => release.targetCommitId).filter((id): id is string => !!id)),
      );
      const commits = targetCommitIds.length > 0
        ? await commitRepo.find({ where: { projectId, id: In(targetCommitIds) } })
        : [];
      const commitById = new Map(commits.map((commit) => [commit.id, commit]));

      res.json({
        data: releases.map((release) => serializeProjectTag(
          release,
          release.targetCommitId ? commitById.get(release.targetCommitId) : undefined,
        )),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List project tags error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:project_id/releases/:release_id
 * Get a single release by ID (full content including body).
 * Requires ViewProject permission.
 */
router.get(
  '/v1/projects/:project_id/releases/:release_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const releaseId = req.params.release_id;

      const release = await releaseRepo.findOne({
        where: { id: releaseId, projectId },
      });

      if (!release) {
        res.status(404).json({ detail: 'Release not found' });
        return;
      }

      res.json(serializeRelease(release));
    } catch (err) {
      console.error('Get release error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/releases
 * Create a new release.
 * Requires EditProject permission (owner/admin).
 * Returns 409 if normalized tag_name already exists.
 */
router.post(
  '/v1/projects/:project_id/releases',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user!.userId;
      const { title, tag_name, target_commit_id, body, draft, prerelease } = req.body;

      // Validate title
      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        res.status(422).json({
          detail: [{ loc: ['body', 'title'], msg: 'Title is required', type: 'missing' }],
        });
        return;
      }
      if (title.length > MAX_TITLE_LENGTH) {
        res.status(422).json({
          detail: [{ loc: ['body', 'title'], msg: `Title must be ${MAX_TITLE_LENGTH} characters or fewer`, type: 'too_long' }],
        });
        return;
      }

      // Validate tag_name
      if (!tag_name || typeof tag_name !== 'string' || tag_name.trim().length === 0) {
        res.status(422).json({
          detail: [{ loc: ['body', 'tag_name'], msg: 'Tag name is required', type: 'missing' }],
        });
        return;
      }
      const normalizedTag = normalizeTagName(tag_name);
      if (!normalizedTag) {
        res.status(422).json({
          detail: [{ loc: ['body', 'tag_name'], msg: 'Tag name must contain at least one alphanumeric character', type: 'invalid' }],
        });
        return;
      }

      // Validate body (optional, defaults to '')
      const releaseBody = body !== undefined ? body : '';
      if (typeof releaseBody !== 'string') {
        res.status(422).json({
          detail: [{ loc: ['body', 'body'], msg: 'Body must be a string', type: 'invalid' }],
        });
        return;
      }
      if (releaseBody.length > MAX_BODY_LENGTH) {
        res.status(422).json({
          detail: [{ loc: ['body', 'body'], msg: `Body must be ${MAX_BODY_LENGTH} characters or fewer`, type: 'too_long' }],
        });
        return;
      }

      // Validate optional target_commit_id
      if (target_commit_id !== undefined && target_commit_id !== null) {
        if (typeof target_commit_id !== 'string') {
          res.status(422).json({
            detail: [{ loc: ['body', 'target_commit_id'], msg: 'Target commit ID must be a string', type: 'invalid' }],
          });
          return;
        }
        if (target_commit_id.length > MAX_COMMIT_ID_LENGTH) {
          res.status(422).json({
            detail: [{ loc: ['body', 'target_commit_id'], msg: `Target commit ID must be ${MAX_COMMIT_ID_LENGTH} characters or fewer`, type: 'too_long' }],
          });
          return;
        }
      }

      // Check for duplicate normalized tag
      const existing = await releaseRepo.findOne({ where: { projectId, tagName: normalizedTag } });
      if (existing) {
        res.status(409).json({ detail: 'A release with this tag name already exists' });
        return;
      }

      const isDraft = draft !== false; // default true
      const isPrerelease = prerelease === true; // default false

      const release = releaseRepo.create({
        projectId,
        title: title.trim(),
        tagName: normalizedTag,
        targetCommitId: target_commit_id || null,
        body: releaseBody,
        draft: isDraft,
        prerelease: isPrerelease,
        createdBy: userId,
        updatedBy: userId,
        publishedAt: isDraft ? null : new Date(),
      });

      await releaseRepo.save(release);

      await recordProjectModuleAudit(
        projectId,
        userId,
        ProjectAuditAction.RELEASE_CREATED,
        { type: 'release', id: release.id, name: release.title },
        {
          tag_name: release.tagName,
          draft: release.draft,
          prerelease: release.prerelease,
          ...(release.targetCommitId ? { target_commit_id: release.targetCommitId } : {}),
        },
      ).catch((err) => console.error('Failed to record release_created audit:', err));

      res.status(201).json(serializeRelease(release));
    } catch (err) {
      console.error('Create release error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * PATCH /v1/projects/:project_id/releases/:release_id
 * Update an existing release (title, tag_name, body, draft, prerelease).
 * Requires EditProject permission (owner/admin).
 * Returns 404 if release not found.
 */
router.patch(
  '/v1/projects/:project_id/releases/:release_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user!.userId;
      const releaseId = req.params.release_id;

      const release = await releaseRepo.findOne({
        where: { id: releaseId, projectId },
      });

      if (!release) {
        res.status(404).json({ detail: 'Release not found' });
        return;
      }

      const before = {
        title: release.title,
        tagName: release.tagName,
        targetCommitId: release.targetCommitId,
        draft: release.draft,
        prerelease: release.prerelease,
      };

      const { title, tag_name, target_commit_id, body, draft, prerelease } = req.body;

      if (title !== undefined) {
        if (typeof title !== 'string' || title.trim().length === 0) {
          res.status(422).json({
            detail: [{ loc: ['body', 'title'], msg: 'Title must be a non-empty string', type: 'invalid' }],
          });
          return;
        }
        if (title.length > MAX_TITLE_LENGTH) {
          res.status(422).json({
            detail: [{ loc: ['body', 'title'], msg: `Title must be ${MAX_TITLE_LENGTH} characters or fewer`, type: 'too_long' }],
          });
          return;
        }
        release.title = title.trim();
      }

      if (tag_name !== undefined) {
        if (typeof tag_name !== 'string' || tag_name.trim().length === 0) {
          res.status(422).json({
            detail: [{ loc: ['body', 'tag_name'], msg: 'Tag name must be a non-empty string', type: 'invalid' }],
          });
          return;
        }
        const normalizedTag = normalizeTagName(tag_name);
        if (!normalizedTag) {
          res.status(422).json({
            detail: [{ loc: ['body', 'tag_name'], msg: 'Tag name must contain at least one alphanumeric character', type: 'invalid' }],
          });
          return;
        }
        // Check for duplicate normalized tag (excluding current release)
        if (normalizedTag !== release.tagName) {
          const existing = await releaseRepo.findOne({ where: { projectId, tagName: normalizedTag } });
          if (existing && existing.id !== releaseId) {
            res.status(409).json({ detail: 'A release with this tag name already exists' });
            return;
          }
        }
        release.tagName = normalizedTag;
      }

      if (target_commit_id !== undefined) {
        if (target_commit_id !== null && typeof target_commit_id !== 'string') {
          res.status(422).json({
            detail: [{ loc: ['body', 'target_commit_id'], msg: 'Target commit ID must be a string or null', type: 'invalid' }],
          });
          return;
        }
        if (target_commit_id !== null && target_commit_id.length > MAX_COMMIT_ID_LENGTH) {
          res.status(422).json({
            detail: [{ loc: ['body', 'target_commit_id'], msg: `Target commit ID must be ${MAX_COMMIT_ID_LENGTH} characters or fewer`, type: 'too_long' }],
          });
          return;
        }
        release.targetCommitId = target_commit_id || null;
      }

      let bodyChanged = false;
      if (body !== undefined) {
        if (typeof body !== 'string') {
          res.status(422).json({
            detail: [{ loc: ['body', 'body'], msg: 'Body must be a string', type: 'invalid' }],
          });
          return;
        }
        if (body.length > MAX_BODY_LENGTH) {
          res.status(422).json({
            detail: [{ loc: ['body', 'body'], msg: `Body must be ${MAX_BODY_LENGTH} characters or fewer`, type: 'too_long' }],
          });
          return;
        }
        release.body = body;
        bodyChanged = true;
      }

      if (draft !== undefined) {
        release.draft = !!draft;
      }

      if (prerelease !== undefined) {
        release.prerelease = !!prerelease;
      }

      // Set published_at when transitioning from draft to non-draft
      if (release.draft === false && !release.publishedAt) {
        release.publishedAt = new Date();
      }

      release.updatedBy = userId;

      await releaseRepo.save(release);

      const changedFields: string[] = [];
      const metadata: Record<string, unknown> = { tag_name: release.tagName };

      if (release.title !== before.title) {
        changedFields.push('title');
        metadata.previous_title = before.title;
        metadata.new_title = release.title;
      }
      if (release.tagName !== before.tagName) {
        changedFields.push('tag_name');
        metadata.previous_tag_name = before.tagName;
        metadata.new_tag_name = release.tagName;
      }
      if (release.targetCommitId !== before.targetCommitId) {
        changedFields.push('target_commit_id');
        metadata.previous_target_commit_id = before.targetCommitId ?? null;
        metadata.new_target_commit_id = release.targetCommitId ?? null;
      }
      if (bodyChanged) {
        changedFields.push('body');
      }
      if (release.draft !== before.draft) {
        changedFields.push('draft');
        metadata.previous_draft = before.draft;
        metadata.new_draft = release.draft;
      }
      if (release.prerelease !== before.prerelease) {
        changedFields.push('prerelease');
        metadata.previous_prerelease = before.prerelease;
        metadata.new_prerelease = release.prerelease;
      }

      if (changedFields.length > 0) {
        metadata.changed_fields = changedFields;
        await recordProjectModuleAudit(
          projectId,
          userId,
          ProjectAuditAction.RELEASE_UPDATED,
          { type: 'release', id: release.id, name: release.title },
          metadata,
        ).catch((err) => console.error('Failed to record release_updated audit:', err));
      }

      res.json(serializeRelease(release));
    } catch (err) {
      console.error('Update release error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
