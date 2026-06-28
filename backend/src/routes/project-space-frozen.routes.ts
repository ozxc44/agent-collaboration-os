import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { authenticate, authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import {
  Project,
  ProjectFile,
  ProjectFileProposal,
  ProjectFileProposalStatus,
  ProjectFileRevision,
  ProjectMember,
  ProjectRole,
  ProjectVisibility,
} from '../entities';
import { validateProjectPath, normalizeContentType, sha256 } from './project-space.utils';

const router = Router();

// ─── Clone ────────────────────────────────────────────────────────────────────

router.post(
  '/v1/projects/:project_id/clone',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const source = await AppDataSource.getRepository(Project).findOne({
        where: { id: req.params.project_id },
      });
      if (!source) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }

      const userId = req.user!.userId;
      const canClone = source.visibility === ProjectVisibility.PUBLIC
        || Boolean(await AppDataSource.getRepository(ProjectMember).findOne({
          where: { projectId: source.id, userId },
        }));
      if (!canClone) {
        res.status(403).json({ detail: 'Project is private' });
        return;
      }

      const name = typeof req.body.name === 'string' && req.body.name.trim()
        ? req.body.name.trim()
        : `${source.name} clone`;
      const visibility = req.body.visibility === ProjectVisibility.PUBLIC
        ? ProjectVisibility.PUBLIC
        : ProjectVisibility.PRIVATE;

      const cloned = await AppDataSource.transaction(async (manager) => {
        const targetProject = await manager.save(Project, manager.create(Project, {
          name,
          description: typeof req.body.description === 'string'
            ? req.body.description.trim()
            : source.description,
          visibility,
          cloneSourceProjectId: source.id,
          ownerId: userId,
        }));
        await manager.save(ProjectMember, manager.create(ProjectMember, {
          projectId: targetProject.id,
          userId,
          role: ProjectRole.OWNER,
        }));

        const sourceFiles = await manager.find(ProjectFile, {
          where: { projectId: source.id },
          order: { path: 'ASC' },
        });
        for (const sourceFile of sourceFiles) {
          const file = await manager.save(ProjectFile, manager.create(ProjectFile, {
            projectId: targetProject.id,
            path: sourceFile.path,
            content: sourceFile.content,
            contentType: sourceFile.contentType,
            contentHash: sourceFile.contentHash,
            sizeBytes: sourceFile.sizeBytes,
            createdBy: userId,
            updatedBy: userId,
          }));
          const revision = await manager.save(ProjectFileRevision, manager.create(ProjectFileRevision, {
            projectId: targetProject.id,
            fileId: file.id,
            path: file.path,
            revisionNumber: 1,
            content: file.content,
            contentType: file.contentType,
            contentHash: file.contentHash,
            message: `Cloned from ${source.id}`,
            createdBy: userId,
          }));
          file.currentRevisionId = revision.id;
          await manager.save(ProjectFile, file);
        }

        return targetProject;
      });

      res.status(201).json(serializeProject(cloned));
    } catch (err) {
      console.error('Clone project error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── File Proposals ──────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 1024 * 1024;

router.post(
  '/v1/projects/:project_id/file-proposals',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user?.userId ?? null;
      const agentId = req.agent?.id ?? null;

      if (!userId && !agentId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const path = validateProjectPath(req.body.path);
      if (!path.ok) {
        res.status(422).json({ detail: path.error });
        return;
      }

      const proposedContent = req.body.proposed_content;
      if (typeof proposedContent !== 'string') {
        res.status(422).json({ detail: 'proposed_content is required and must be a string' });
        return;
      }
      const sizeBytes = Buffer.byteLength(proposedContent, 'utf8');
      if (sizeBytes > MAX_FILE_BYTES) {
        res.status(413).json({ detail: `Proposed content exceeds ${MAX_FILE_BYTES} bytes` });
        return;
      }

      const contentType = normalizeContentType(req.body.content_type);
      const contentHash = sha256(proposedContent);
      const title = typeof req.body.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 512)
        : null;
      const description = typeof req.body.description === 'string' && req.body.description.trim()
        ? req.body.description.trim()
        : null;
      const baseRevisionId = typeof req.body.base_revision_id === 'string'
        ? req.body.base_revision_id
        : null;

      // Auto-detect file_id if a file exists at this path
      const existingFile = await AppDataSource.getRepository(ProjectFile).findOne({
        where: { projectId, path: path.value },
      });
      const fileId = existingFile?.id ?? null;

      const proposal = await AppDataSource.getRepository(ProjectFileProposal).save(
        AppDataSource.getRepository(ProjectFileProposal).create({
          projectId,
          fileId,
          path: path.value,
          proposedContent,
          contentType,
          contentHash,
          baseRevisionId,
          title,
          description,
          status: ProjectFileProposalStatus.PENDING,
          createdByUserId: userId,
          createdByAgentId: agentId,
        }),
      );

      res.status(201).json(serializeProposal(proposal));
    } catch (err) {
      console.error('Create file proposal error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/file-proposals',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const pathFilter = typeof req.query.path === 'string' ? req.query.path.trim() : undefined;

      const qb = AppDataSource.getRepository(ProjectFileProposal)
        .createQueryBuilder('proposal')
        .where('proposal.projectId = :projectId', { projectId })
        .orderBy('proposal.createdAt', 'DESC');

      if (status && Object.values(ProjectFileProposalStatus).includes(status as ProjectFileProposalStatus)) {
        qb.andWhere('proposal.status = :status', { status });
      }
      if (pathFilter) {
        qb.andWhere('proposal.path = :pathFilter', { pathFilter });
      }

      const proposals = await qb.getMany();
      res.json({ data: proposals.map(serializeProposal) });
    } catch (err) {
      console.error('List file proposals error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/file-proposals/:proposal_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const proposal = await AppDataSource.getRepository(ProjectFileProposal).findOne({
        where: { id: req.params.proposal_id, projectId: req.params.project_id },
      });
      if (!proposal) {
        res.status(404).json({ detail: 'Proposal not found' });
        return;
      }
      res.json(serializeProposal(proposal));
    } catch (err) {
      console.error('Get file proposal error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/file-proposals/:proposal_id/review',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ManageMembers),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const proposalRepo = AppDataSource.getRepository(ProjectFileProposal);
      const proposal = await proposalRepo.findOne({
        where: { id: req.params.proposal_id, projectId },
      });
      if (!proposal) {
        res.status(404).json({ detail: 'Proposal not found' });
        return;
      }
      if (proposal.status !== ProjectFileProposalStatus.PENDING) {
        res.status(409).json({ detail: 'Proposal has already been reviewed' });
        return;
      }

      const status = req.body.status;
      if (status !== ProjectFileProposalStatus.APPROVED && status !== ProjectFileProposalStatus.REJECTED) {
        res.status(422).json({ detail: 'status must be approved or rejected' });
        return;
      }

      const reviewMessage = typeof req.body.message === 'string' && req.body.message.trim()
        ? req.body.message.trim().slice(0, 1024)
        : null;

      const reviewerId = req.user!.userId;

      if (status === ProjectFileProposalStatus.REJECTED) {
        proposal.status = ProjectFileProposalStatus.REJECTED;
        proposal.reviewedBy = reviewerId;
        proposal.reviewedAt = new Date();
        proposal.reviewMessage = reviewMessage;
        await proposalRepo.save(proposal);
        res.json(serializeProposal(proposal));
        return;
      }

      // Approval: merge into project_files / project_file_revisions
      const result = await AppDataSource.transaction(async (manager) => {
        const fileRepo = manager.getRepository(ProjectFile);

        const existing = await fileRepo.findOne({
          where: { projectId, path: proposal.path },
        });

        // Stale base_revision_id check (kept before the delegated write).
        if (existing && proposal.baseRevisionId && existing.currentRevisionId !== proposal.baseRevisionId) {
          return { conflict: true as const, file: existing };
        }
        if (!existing && proposal.baseRevisionId) {
          return { conflict: true as const, file: null };
        }

        // Delegate the file+revision write to the shared core so the proposal's
        // approved content is mirrored into the real-git index (same path every
        // other writer takes). Previously this inlined a ProjectFile/Revision
        // write that bypassed the git backend entirely.
        const { upsertProjectFileContent } = await import('../services/project-file.service');
        const { file, revision } = await upsertProjectFileContent(manager, {
          projectId,
          path: proposal.path,
          content: proposal.proposedContent,
          contentType: proposal.contentType,
          message: proposal.title || `Proposal ${proposal.id} approved`,
          actorId: reviewerId,
        });

        proposal.status = ProjectFileProposalStatus.APPROVED;
        proposal.reviewedBy = reviewerId;
        proposal.reviewedAt = new Date();
        proposal.reviewMessage = reviewMessage;
        proposal.mergedRevisionId = revision.id;
        proposal.fileId = file.id;
        await manager.save(ProjectFileProposal, proposal);

        return { conflict: false as const, file, revision, proposal };
      });

      if (result.conflict) {
        res.status(409).json({
          detail: 'File revision conflict — base_revision_id is stale',
          current_revision_id: result.file?.currentRevisionId ?? null,
        });
        return;
      }

      res.json(serializeProposal(result.proposal));
    } catch (err) {
      console.error('Review file proposal error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Serializers ──────────────────────────────────────────────────────────────

function serializeProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    clone_source_project_id: project.cloneSourceProjectId ?? null,
    owner_id: project.ownerId,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

function serializeProposal(proposal: ProjectFileProposal) {
  return {
    id: proposal.id,
    project_id: proposal.projectId,
    file_id: proposal.fileId ?? null,
    path: proposal.path,
    proposed_content: proposal.proposedContent,
    content_type: proposal.contentType,
    content_hash: proposal.contentHash,
    base_revision_id: proposal.baseRevisionId ?? null,
    title: proposal.title ?? null,
    description: proposal.description ?? null,
    status: proposal.status,
    created_by_user_id: proposal.createdByUserId ?? null,
    created_by_agent_id: proposal.createdByAgentId ?? null,
    reviewed_by: proposal.reviewedBy ?? null,
    reviewed_at: proposal.reviewedAt ?? null,
    review_message: proposal.reviewMessage ?? null,
    merged_revision_id: proposal.mergedRevisionId ?? null,
    created_at: proposal.createdAt,
    updated_at: proposal.updatedAt,
  };
}

export default router;
