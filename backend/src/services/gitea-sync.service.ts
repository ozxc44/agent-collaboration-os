export interface GiteaSyncConfig {
  enabled: boolean;
  serverUrl: string;
  token: string;
  org: string;
  repoPrefix: string;
  dryRun: boolean;
}

export interface SyncCommitPayload {
  project_id: string;
  project_name: string;
  commit_id: string;
  parent_commit_id: string | null;
  message: string;
  author_type: 'user' | 'agent' | null;
  author_id: string | null;
  changed_files: Array<{
    op: string;
    path: string;
  }>;
  snapshot_file_count: number;
  orchestration_id: string | null;
  task_id: string | null;
  changeset_id: string | null;
  committed_at: string;
}

export interface SyncResult {
  action: 'skipped' | 'dry_run' | 'synced' | 'error';
  target: string;
  detail: string;
  projectId: string;
  commitId: string;
  giteaRepo?: string;
  giteaCommitSha?: string | null;
  error?: string;
}

export type HttpClient = (url: string, options: {
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; ok: boolean; body: string }>;

import { AppDataSource } from '../data-source';

const defaultHttpClient: HttpClient = async (url, options) => {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  const body = await response.text();
  return { status: response.status, ok: response.ok, body };
};

const DEFAULT_CONFIG: GiteaSyncConfig = {
  enabled: process.env.GITEA_SYNC_ENABLED === 'true',
  serverUrl: process.env.GITEA_URL || '',
  token: process.env.GITEA_TOKEN || '',
  org: process.env.GITEA_SYNC_ORG || '',
  repoPrefix: process.env.GITEA_SYNC_REPO_PREFIX || 'agent-',
  dryRun: process.env.GITEA_SYNC_DRY_RUN !== 'false',
};

export class GiteaSyncService {
  private config: GiteaSyncConfig;
  private httpClient: HttpClient;

  constructor(config?: Partial<GiteaSyncConfig>, httpClient?: HttpClient) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.httpClient = httpClient || defaultHttpClient;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  isDryRun(): boolean {
    return this.config.dryRun;
  }

  getConfig(): Readonly<GiteaSyncConfig> {
    return { ...this.config };
  }

  async syncCommit(
    projectId: string,
    projectName: string,
    commit: {
      id: string;
      parentCommitId?: string | null;
      message: string;
      createdByUserId?: string | null;
      createdByAgentId?: string | null;
      changedFiles: Array<Record<string, unknown>>;
      snapshot: Record<string, unknown>;
      orchestrationId?: string | null;
      taskId?: string | null;
      changesetId?: string | null;
      createdAt: Date;
    },
  ): Promise<SyncResult> {
    if (!this.config.enabled) {
      return {
        action: 'skipped',
        target: 'gitea',
        detail: 'Gitea sync is disabled (GITEA_SYNC_ENABLED != true)',
        projectId,
        commitId: commit.id,
      };
    }

    const payload: SyncCommitPayload = {
      project_id: projectId,
      project_name: projectName,
      commit_id: commit.id,
      parent_commit_id: commit.parentCommitId ?? null,
      message: commit.message,
      author_type: commit.createdByAgentId ? 'agent' : commit.createdByUserId ? 'user' : null,
      author_id: commit.createdByAgentId ?? commit.createdByUserId ?? null,
      changed_files: (commit.changedFiles || []).map((f: any) => ({
        op: String(f.op ?? 'unknown'),
        path: String(f.path ?? ''),
      })),
      snapshot_file_count: Object.keys(commit.snapshot || {}).length,
      orchestration_id: commit.orchestrationId ?? null,
      task_id: commit.taskId ?? null,
      changeset_id: commit.changesetId ?? null,
      committed_at: commit.createdAt.toISOString(),
    };

    const repoName = `${this.config.repoPrefix}${sanitizeRepoName(projectId)}`;

    if (this.config.dryRun) {
      return {
        action: 'dry_run',
        target: 'gitea',
        detail: `Would sync commit ${commit.id.slice(0, 8)} to ${this.config.serverUrl}/${this.config.org ? `${this.config.org}/` : ''}${repoName}`,
        projectId,
        commitId: commit.id,
        giteaRepo: repoName,
        giteaCommitSha: null,
      };
    }

    try {
      const baseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.config.token) {
        baseHeaders.Authorization = `token ${this.config.token}`;
      }
      const baseApiUrl = `${this.config.serverUrl.replace(/\/+$/, '')}/api/v1`;
      const orgPrefix = this.config.org ? `${this.config.org}/` : '';

      // Ensure the Gitea repository exists (create if missing)
      const repoCheck = await this.httpClient(
        `${baseApiUrl}/repos/${orgPrefix}${repoName}`,
        { method: 'GET', headers: baseHeaders },
      );

      if (repoCheck.status === 404) {
        const createPayload: Record<string, unknown> = {
          name: repoName,
          auto_init: true,
          private: true,
          description: `Mirror of agent platform project ${projectName}`,
        };
        if (this.config.org) {
          const owner = this.config.org;
          const createResult = await this.httpClient(
            `${baseApiUrl}/orgs/${owner}/repos`,
            { method: 'POST', headers: baseHeaders, body: JSON.stringify(createPayload) },
          );
          if (!createResult.ok) {
            return {
              action: 'error',
              target: 'gitea',
              detail: `Failed to create Gitea repo: ${createResult.status} ${createResult.body.slice(0, 200)}`,
              projectId,
              commitId: commit.id,
              giteaRepo: repoName,
              error: createResult.body.slice(0, 200),
            };
          }
        } else {
          const createResult = await this.httpClient(
            `${baseApiUrl}/user/repos`,
            { method: 'POST', headers: baseHeaders, body: JSON.stringify(createPayload) },
          );
          if (!createResult.ok) {
            return {
              action: 'error',
              target: 'gitea',
              detail: `Failed to create Gitea repo: ${createResult.status} ${createResult.body.slice(0, 200)}`,
              projectId,
              commitId: commit.id,
              giteaRepo: repoName,
              error: createResult.body.slice(0, 200),
            };
          }
        }
      } else if (!repoCheck.ok && repoCheck.status !== 404) {
        return {
          action: 'error',
          target: 'gitea',
          detail: `Gitea repo check failed: ${repoCheck.status}`,
          projectId,
          commitId: commit.id,
          giteaRepo: repoName,
          error: repoCheck.body.slice(0, 200),
        };
      }

      // ── Push REAL file content into the Gitea repo (not just an issue).
      // For each file in the commit snapshot, upsert its content via the
      // contents API — Gitea creates a real git commit per write. This makes
      // the repo cloneable/pushable with true git history.
      const snapshotEntries = Object.entries(commit.snapshot || {}) as Array<[string, any]>;
      let pushedFiles = 0;
      let lastGiteaSha: string | null = null;
      for (const [filePath, entry] of snapshotEntries) {
        const revisionId = entry?.revision_id;
        if (!revisionId) continue;
        // Fetch the actual file content from the platform DB.
        let content = '';
        try {
          const file = await AppDataSource.getRepository('ProjectFileRevision')
            .findOne({ where: { id: revisionId } } as any);
          content = (file as any)?.content ?? '';
        } catch { continue; }
        const b64 = Buffer.from(content, 'utf8').toString('base64');
        // Upsert file content. Try create first; if it exists (409), update with the current sha.
        const contentsUrl = `${baseApiUrl}/repos/${orgPrefix}${repoName}/contents/${encodeURIComponent(filePath)}`;
        const createBody = JSON.stringify({
          message: `${commit.message.slice(0, 60)} (${filePath})`,
          content: b64,
          branch: 'main',
        });
        let res = await this.httpClient(contentsUrl, { method: 'POST', headers: baseHeaders, body: createBody });
        if (res.status === 409 || res.status === 422) {
          // File already exists — fetch its sha, then update.
          const existing = await this.httpClient(contentsUrl, { method: 'GET', headers: baseHeaders });
          let prevSha = '';
          try { prevSha = JSON.parse(existing.body)?.sha ?? ''; } catch { /* */ }
          const updateBody = JSON.stringify({
            message: `${commit.message.slice(0, 60)} (${filePath})`,
            content: b64,
            sha: prevSha,
            branch: 'main',
          });
          res = await this.httpClient(contentsUrl, { method: 'PUT', headers: baseHeaders, body: updateBody });
        }
        if (res.ok) {
          pushedFiles++;
          try { lastGiteaSha = lastGiteaSha ?? JSON.parse(res.body)?.commit?.sha ?? null; } catch { /* */ }
        }
      }

      return {
        action: 'synced',
        target: 'gitea',
        detail: `Pushed ${pushedFiles} files to ${this.config.serverUrl}/${orgPrefix}${repoName}`,
        projectId,
        commitId: commit.id,
        giteaRepo: repoName,
        giteaCommitSha: lastGiteaSha,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        action: 'error',
        target: 'gitea',
        detail: `Gitea sync error: ${message.slice(0, 500)}`,
        projectId,
        commitId: commit.id,
        giteaRepo: `${this.config.repoPrefix}${sanitizeRepoName(projectId)}`,
        error: message.slice(0, 500),
      };
    }
  }
}

function sanitizeRepoName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
}
