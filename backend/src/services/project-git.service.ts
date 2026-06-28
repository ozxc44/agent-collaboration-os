import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import * as git from 'isomorphic-git';
import { AppDataSource } from '../data-source';

/**
 * Per-project real Git backend (isomorphic-git).
 *
 * Each project has a real bare-ish git working directory at
 * `${PROJECT_GIT_DIR}/<projectId>` containing a `.git` plus a lightweight
 * checkout of the default branch's tree. Writes (add/rm/commit) produce real
 * git objects; reads (log/tree/blob/diff) read them. This is the "true git"
 * authority for content history, replacing the DB-simulated snapshot model.
 *
 * Design:
 *  - One on-disk dir per project (lazily initialized).
 *  - A single author identity for platform commits (provenance tracked in the
 *    DB commit row + commit message; GPG/SSH signing is a separate concern).
 *  - commit() returns the real git SHA, stored on ProjectCommit.gitSha.
 */

const PROJECT_GIT_DIR = process.env.PROJECT_GIT_DIR
  || path.join(process.cwd(), 'project-git');

const PLATFORM_AUTHOR = { name: 'Agent Platform', email: 'platform@agent.local' };

function projectDir(projectId: string): string {
  return path.join(PROJECT_GIT_DIR, projectId);
}

/** Lazily ensure a project's git repo exists (init if absent). Idempotent. */
export async function ensureProjectRepo(projectId: string): Promise<string> {
  const dir = projectDir(projectId);
  await fsp.mkdir(dir, { recursive: true });
  const isRepo = await fs.existsSync(path.join(dir, '.git'));
  if (!isRepo) {
    await git.init({ fs, dir, defaultBranch: 'main' });
  }
  return dir;
}

/** Stage a file's content at a path (creates/overwrites the working file + git add). */
export async function gitAddFile(
  projectId: string,
  filePath: string,
  content: string,
): Promise<void> {
  const dir = await ensureProjectRepo(projectId);
  const abs = path.join(dir, filePath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  await git.add({ fs, dir, filepath: filePath });
}

/** Remove a file from the working tree + index (git rm). */
export async function gitRemoveFile(projectId: string, filePath: string): Promise<void> {
  const dir = await ensureProjectRepo(projectId);
  const abs = path.join(dir, filePath);
  try {
    await git.remove({ fs, dir, filepath: filePath });
  } catch {
    // not in index — nothing to remove
  }
  if (await fileExists(abs)) await fsp.unlink(abs).catch(() => {});
}

async function fileExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Create a real git commit on HEAD capturing all staged changes.
 * Returns the commit SHA (40-hex). First commit has no parent.
 */
export async function gitCommit(
  projectId: string,
  message: string,
): Promise<string> {
  const dir = await ensureProjectRepo(projectId);
  // Determine if there's an existing HEAD commit to chain onto. We resolve the
  // 'main' branch directly (init defaultBranch is 'main'); isomorphic-git's
  // commit() will set HEAD -> refs/heads/main on the first commit.
  let parentOid: string | null = null;
  try {
    parentOid = await git.resolveRef({ fs, dir, ref: 'main' });
  } catch {
    parentOid = null;
  }
  const parents = parentOid ? [parentOid] : [];
  const sha = await git.commit({
    fs, dir, message, author: PLATFORM_AUTHOR, committer: PLATFORM_AUTHOR, ref: 'main', parent: parents,
  });
  return sha;
}

/** Read a file blob's content at the default branch HEAD (or a given ref/sha). */
export async function gitReadBlob(
  projectId: string,
  filePath: string,
  ref: string = 'main',
): Promise<string | null> {
  const dir = await ensureProjectRepo(projectId);
  try {
    // Resolve the ref to an oid; if it's already a sha, resolveRef throws and we use it as-is.
    let oid: string = ref;
    try { oid = await git.resolveRef({ fs, dir, ref }); } catch { /* ref may be a raw sha */ }
    const { blob } = await git.readBlob({ fs, dir, filepath: filePath, oid });
    return Buffer.from(blob).toString('utf8');
  } catch {
    return null;
  }
}

/** Commit history (newest first) up to `depth`. */
export async function gitLog(projectId: string, depth = 50): Promise<git.ReadCommitResult[]> {
  const dir = await ensureProjectRepo(projectId);
  try {
    return await git.log({ fs, dir, depth, ref: 'main' });
  } catch {
    return [];
  }
}

/**
 * Recursively list every file path in the tree of a given git commit (oid).
 * Used to derive the file-path set for a branch/commit context from real git
 * (replaces reading the DB ProjectCommit.snapshot). Returns [] if the oid is
 * absent or unreadable — callers MUST fall back to the DB snapshot then.
 */
export async function gitListTreeFiles(projectId: string, oid: string | null): Promise<string[]> {
  if (!oid) return [];
  const dir = await ensureProjectRepo(projectId);
  try {
    const tree = await git.readTree({ fs, dir, oid });
    const out: string[] = [];
    async function walk(entries: git.TreeEntry[], prefix: string): Promise<void> {
      for (const e of entries) {
        const p = prefix ? `${prefix}/${e.path}` : e.path;
        if (e.type === 'tree') {
          // Subtree: read its blob recursively.
          const sub = await git.readTree({ fs, dir, oid: e.oid });
          await walk(sub.tree, p);
        } else if (e.type === 'blob') {
          out.push(p);
        }
      }
    }
    await walk(tree.tree, '');
    return out;
  } catch {
    return [];
  }
}

/**
 * Read a binary file blob's content at a given oid. Unlike gitReadBlob (utf8),
 * this returns the raw Buffer so binary files (images, archives) are preserved.
 */
export async function gitReadBlobRaw(
  projectId: string,
  filePath: string,
  oid: string | null,
): Promise<Buffer | null> {
  if (!oid) return null;
  const dir = await ensureProjectRepo(projectId);
  try {
    const { blob } = await git.readBlob({ fs, dir, filepath: filePath, oid });
    return Buffer.from(blob);
  } catch {
    return null;
  }
}

/** The current HEAD commit SHA of the default branch, or null if none. */
export async function gitHeadSha(projectId: string): Promise<string | null> {
  const dir = await ensureProjectRepo(projectId);
  try {
    return await git.resolveRef({ fs, dir, ref: 'main' });
  } catch {
    return null;
  }
}

/**
 * Best common ancestor (merge base) of two git commits. Returns the oid string,
 * or null if either oid is missing or no common ancestor exists (e.g. criss-
 * cross merges, which isomorphic-git's findMergeBase rejects with multiple bases).
 * Powers true three-way diff/merge (branch compare + changeset merge base).
 */
export async function gitMergeBase(projectId: string, oidA: string, oidB: string): Promise<string | null> {
  const dir = await ensureProjectRepo(projectId);
  try {
    const bases = await git.findMergeBase({ fs, dir, oids: [oidA, oidB] });
    return Array.isArray(bases) && bases.length === 1 ? bases[0] : (bases?.[0] ?? null);
  } catch {
    return null;
  }
}

/**
 * True three-way merge of `theirOid` into the default branch (HEAD/main) using
 * isomorphic-git's diff3-based merge. Returns the resulting HEAD sha, or null
 * if the merge was a no-op (already merged / fast-forward handled by replay).
 *
 * This is invoked from the changeset-merge path AFTER the DB+replay commit, as
 * a best-effort enhancement so divergent feature lines produce a real merge
 * commit (two parents) instead of a linear replay. Failures are logged and
 * swallowed — the replayed linear commit is always the fallback source of truth.
 *
 * NOTE: isomorphic-git's merge() does NOT support criss-cross merges (multiple
 * merge bases) and will throw MergeNotSupportedError, which we catch → null.
 */
export async function gitMerge(projectId: string, theirOid: string): Promise<string | null> {
  const dir = await ensureProjectRepo(projectId);
  try {
    const result = await git.merge({
      fs,
      dir,
      ours: 'main',
      theirs: theirOid,
      author: PLATFORM_AUTHOR,
      committer: PLATFORM_AUTHOR,
      abortOnConflict: false,
    });
    // result.oid is the new HEAD (merge commit) when a merge happened.
    return result.oid ?? null;
  } catch (err: any) {
    // MergeNotSupportedError (criss-cross) or no-op — not fatal.
    return null;
  }
}

export { PROJECT_GIT_DIR };
