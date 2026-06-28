import { EntityManager } from 'typeorm';
import { ProjectFile } from '../entities/project-file.entity';
import { ProjectFileRevision } from '../entities/project-file-revision.entity';
import { sha256 } from '../utils/content-hash';

/**
 * Shared project-file write core.
 *
 * All writers of project files converge here (previously 5 near-duplicate
 * upsert implementations: project-space, versioning-merge, orchestrations,
 * md-artifact, proposal-merge). Centralizing means the future git backend
 * (isomorphic-git) has ONE place to add `git add`/`git rm` — phase 1 of the
 * DB→git migration.
 *
 * Semantics (matches the existing behavior):
 *  - If file does not exist: create ProjectFile + first revision.
 *  - If file exists: append a new revision (revisionNumber+1), point
 *    currentRevisionId at it, re-activate if soft-deleted.
 *  - Returns { file, revision, created }.
 *
 * Guards (optimistic-lock base_revision_id, branch protection, agent path
 * safety) are intentionally NOT here — each caller enforces its own policy
 * before calling, preserving their existing 403/409 contracts.
 */
export interface UpsertFileInput {
  projectId: string;
  path: string;
  content: string;
  contentType?: string;
  message?: string | null;
  /** Actor id that wrote it (user id or agent id depending on caller). */
  actorId: string;
  /** Normalize content type to a canonical form (caller may pass its own). */
  normalizeContentType?: (raw?: string) => string;
  maxFileBytes?: number;
}

export interface UpsertFileResult {
  file: ProjectFile;
  revision: ProjectFileRevision;
  created: boolean;
}

const DEFAULT_CONTENT_TYPE = 'text/plain';

export function normalizeContentType(raw?: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_CONTENT_TYPE;
  return raw.trim();
}

/**
 * Upsert a project file's content: create-or-activate the ProjectFile row and
 * append a new ProjectFileRevision. Single transactional write point.
 */
export async function upsertProjectFileContent(
  manager: EntityManager,
  input: UpsertFileInput,
): Promise<UpsertFileResult> {
  const contentType = (input.normalizeContentType ?? normalizeContentType)(input.contentType);
  const contentHash = sha256(input.content);
  const sizeBytes = Buffer.byteLength(input.content, 'utf8');
  const maxBytes = input.maxFileBytes ?? 1024 * 1024; // 1MB default
  if (sizeBytes > maxBytes) {
    throw new Error(`File content exceeds ${maxBytes} bytes`);
  }

  const fileRepo = manager.getRepository(ProjectFile);
  const revisionRepo = manager.getRepository(ProjectFileRevision);

  let file = await fileRepo.findOne({ where: { projectId: input.projectId, path: input.path } });
  let created = false;
  if (!file) {
    file = fileRepo.create({
      projectId: input.projectId,
      path: input.path,
      content: input.content,
      contentType,
      contentHash,
      sizeBytes,
      createdBy: input.actorId,
      updatedBy: input.actorId,
      deletedAt: null,
    });
    await fileRepo.save(file);
    created = true;
  } else {
    // re-activate if previously soft-deleted
    if (file.deletedAt) file.deletedAt = null;
  }

  const latest = await revisionRepo
    .createQueryBuilder('revision')
    .where('revision.file_id = :fileId', { fileId: file.id })
    .orderBy('revision.revision_number', 'DESC')
    .getOne();

  const revision = revisionRepo.create({
    projectId: input.projectId,
    fileId: file.id,
    path: input.path,
    revisionNumber: (latest?.revisionNumber ?? 0) + 1,
    content: input.content,
    contentType,
    contentHash,
    message: input.message ?? null,
    createdBy: input.actorId,
  });
  await revisionRepo.save(revision);

  file.content = input.content;
  file.contentType = contentType;
  file.contentHash = contentHash;
  file.sizeBytes = sizeBytes;
  file.currentRevisionId = revision.id;
  file.updatedBy = input.actorId;
  await fileRepo.save(file);

  // Real-git backend (best-effort mirror of direct writes). Failures never
  // affect the DB write — git is the future authority but DB stays source of
  // truth during the transition. Commits here are created on the git index and
  // rolled into the next changeset merge's gitCommit, OR the caller may commit.
  try {
    const { gitAddFile } = await import('./project-git.service');
    await gitAddFile(input.projectId, input.path, input.content);
  } catch (gitErr) {
    console.error('Git add mirror failed (DB write succeeded):', gitErr);
  }

  return { file, revision, created };
}

/**
 * Soft-delete a project file (sets deletedAt). Single delete point for the
 * future git `rm` integration.
 */
export async function softDeleteProjectFile(
  manager: EntityManager,
  projectId: string,
  path: string,
): Promise<ProjectFile | null> {
  const file = await manager.getRepository(ProjectFile).findOne({ where: { projectId, path } });
  if (!file) return null;
  file.deletedAt = new Date();
  await manager.getRepository(ProjectFile).save(file);
  // Real-git backend: mirror the removal (best-effort).
  try {
    const { gitRemoveFile } = await import('./project-git.service');
    await gitRemoveFile(projectId, path);
  } catch (gitErr) {
    console.error('Git rm mirror failed (DB write succeeded):', gitErr);
  }
  return file;
}
