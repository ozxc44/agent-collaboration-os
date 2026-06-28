import crypto from 'node:crypto';

/**
 * Canonical content hash for ProjectFile/ProjectFileRevision.
 *
 * NOTE: This is a content SHA-256 (hex). Git's own blob object id is a SHA-1 of
 * `blob <size>\0<content>` — a different value. We keep the content SHA-256 as
 * the DB-facing `content_hash` (API contract + rename-detection), and store the
 * git blob sha separately on ProjectCommit (gitSha) once the git backend is live.
 * Centralizing here so all writers share one definition.
 */
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** SHA-256 of a binary Buffer (used by file upload / raw bytes). */
export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
