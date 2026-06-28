/**
 * Backfill real-git history for projects whose ProjectCommit rows predate the
 * git backend (gitSha is null).
 *
 * For each project, replays commits in createdAt order: for every file in the
 * commit's snapshot, re-stage its content into the project git repo, then make
 * a real git commit and backfill ProjectCommit.gitSha. Idempotent: commits that
 * already have a gitSha are skipped. rollback/forward-restore commits are
 * handled too (their snapshot is the full restored tree).
 *
 * Run inside the backend container (has AppDataSource + project-git.service):
 *   node dist/src/scripts/backfill-git-history.js [--project <id>]
 *
 * Safe to re-run; never overwrites an existing gitSha.
 */
import { AppDataSource } from '../data-source';
import { ProjectCommit } from '../entities/project-commit.entity';
import { ProjectFileRevision } from '../entities/project-file-revision.entity';
import { Project } from '../entities/project.entity';
import { ensureProjectRepo, gitAddFile, gitCommit } from '../services/project-git.service';

async function backfillProject(projectId: string): Promise<{ scanned: number; backfilled: number }> {
  const commitRepo = AppDataSource.getRepository(ProjectCommit);
  const revRepo = AppDataSource.getRepository(ProjectFileRevision);

  // Commits missing a gitSha, oldest first (preserves parent chain).
  const commits = await commitRepo.find({
    where: { projectId },
    order: { createdAt: 'ASC' },
  });
  let backfilled = 0;
  for (const commit of commits) {
    if (commit.gitSha) continue; // already has real git history
    const snapshot = commit.snapshot || {};
    for (const [path, entry] of Object.entries<any>(snapshot)) {
      const revId = entry?.revision_id;
      if (!revId) continue;
      const rev = await revRepo.findOne({ where: { id: revId } });
      if (rev) {
        await gitAddFile(projectId, path, rev.content);
      }
    }
    const sha = await gitCommit(projectId, commit.message || `Backfill ${commit.id}`);
    if (sha) {
      await commitRepo.update({ id: commit.id }, { gitSha: sha });
      backfilled++;
    }
  }
  return { scanned: commits.length, backfilled };
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const onlyProject = process.argv.includes('--project')
    ? process.argv[process.argv.indexOf('--project') + 1]
    : null;

  const projects = onlyProject
    ? [{ id: onlyProject }]
    : await AppDataSource.getRepository(Project).find({ select: ['id', 'name'] });

  for (const p of projects) {
    await ensureProjectRepo(p.id);
    const res = await backfillProject(p.id);
    if (res.backfilled > 0) {
      console.log(`project ${p.id}: scanned ${res.scanned} commits, backfilled ${res.backfilled} into git`);
    }
  }
  await AppDataSource.destroy();
  console.log('backfill complete');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
