import crypto from 'crypto';
import { EntityManager } from 'typeorm';
import {
  ProjectFile,
  ProjectFileRevision,
  ProjectOrchestration,
  ProjectOrchestrationTask,
} from '../entities';

/**
 * MD Artifact Service — writes durable Markdown artifacts for the
 * MD-driven traceability contract.
 *
 * Each artifact is a ProjectFile stored under ${basePath}/<convention>.
 * Paths are recorded in orchestration/task metadata under `md_artifacts`
 * so they survive DB queries without recomputation.
 *
 * Convention (per orchestration):
 *   GOAL.md    →  ${basePath}/goal.md         (existing)
 *   PLAN.md    →  ${basePath}/plan.md          (existing)
 *   TRACE.md   →  ${basePath}/TRACE.md         (new)
 *
 * Convention (per task, stored at ${taskMdDir} = ${basePath}/tasks/${taskId}/):
 *   TASK.md    →  ${taskMdDir}/TASK.md         (new)
 *   RESULT.md  →  ${taskMdDir}/RESULT.md       (new)
 *   EVIDENCE.md→  ${taskMdDir}/EVIDENCE.md     (new)
 *   REVIEW.md  →  ${taskMdDir}/REVIEW.md       (new)
 *   CHANGELOG.md→ ${taskMdDir}/CHANGELOG.md    (new)
 *
 * Path convention note: uppercase GOAL.md/PLAN.md are the logical artifact
 * names used in the traceability contract. The canonical project-space storage
 * paths are the existing lowercase `goal.md` and `plan.md`. All trace references
 * and artifact links point to those lowercase files.
 */

const MAX_FILE_BYTES = 1024 * 1024;
const REDACTED = '<REDACTED>';

/* ─── Redaction helpers ────────────────────────────────────────── */

const SENSITIVE_KEY_RE = /token|secret|password|api[_-]?key|apikey|authorization/i;
const SENSITIVE_LABEL_SOURCE = String.raw`(?:token|secret|password|api[_-]?key|apikey|authorization)`;
const COLON_QUOTED_SECRET_RE = new RegExp(
  `((?:["']?\\b${SENSITIVE_LABEL_SOURCE}\\b["']?\\s*:\\s*))(["'])([^\\r\\n]*?)(\\2)`,
  'gi',
);
// Unquoted colon-style secret labels carry the whole value to end of line or a
// structural boundary. Splitting on whitespace (as the prior form did) leaks
// trailing tokens of multi-word secrets such as the base64 credential in
// "Authorization: Basic dXNlcjpwYXNz". Stop at line breaks or JSON/YAML/CSV
// delimiters instead of spaces.
const COLON_UNQUOTED_SECRET_RE = new RegExp(
  `((?:["']?\\b${SENSITIVE_LABEL_SOURCE}\\b["']?\\s*:\\s*))(?:[^\\r\\n\\]})>,;]+)`,
  'gi',
);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

/**
 * Redact obvious secret-like patterns in a free-form string while keeping
 * the surrounding text readable.
 */
function redactStringValue(value: string): string {
  return (
    value
      // Authorization / Bearer tokens
      .replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`)
      // OpenAI-style secret keys (sk-...)
      .replace(/\bsk-[a-zA-Z0-9_-]{10,}\b/g, REDACTED)
      // Environment-style secret assignments: *_TOKEN=..., *_SECRET=...,
      // PASSWORD=..., OPENAI_API_KEY=..., ANTROPIC_AUTH_TOKEN=..., etc.
      .replace(
        /\b([A-Za-z_]*(?:[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss]{2}[Ww][Oo][Rr][Dd]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]))=[^\s]+/g,
        (_match, keyName) => `${keyName}=${REDACTED}`,
      )
      // Colon-style labels in logs, YAML, and prose: password: ..., TOKEN: ...,
      // "api_key": "...", Authorization: ..., etc.
      .replace(COLON_QUOTED_SECRET_RE, (_match, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`)
      .replace(COLON_UNQUOTED_SECRET_RE, (_match, prefix) => `${prefix}${REDACTED}`)
      // JWT-looking xxxxx.yyyyy.zzzzz
      .replace(/\b[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,}){2,}\b/g, REDACTED)
  );
}

/**
 * Recursively redact sensitive values in an arbitrary JSON-compatible value.
 * Sensitive object keys have their values replaced entirely; string scalars
 * are also scanned for inline secret patterns.
 */
export function redactValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && isSensitiveKey(key)) {
      return REDACTED;
    }
    return redactStringValue(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]),
    );
  }

  return value;
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function redactMarkdownFence(infoString: string, body: string): string {
  const trimmedInfo = infoString.trim();
  const shouldParseJson = trimmedInfo.toLowerCase() === 'json' || (trimmedInfo === '' && looksLikeJson(body));

  if (shouldParseJson) {
    try {
      const redacted = redactValue(JSON.parse(body));
      return `\`\`\`${infoString}\n${JSON.stringify(redacted, null, 2)}\n\`\`\``;
    } catch {
      // fall through to plain-text redaction for malformed JSON fences
    }
  }

  return `\`\`\`${infoString}\n${redactStringValue(body)}\n\`\`\``;
}

/**
 * Redact secrets embedded in Markdown text. JSON code fences are parsed and
 * redacted structurally; everything else is scanned for inline patterns.
 */
export function redactMarkdown(text: string): string {
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)\n```/g;
  let redacted = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(text)) !== null) {
    redacted += redactStringValue(text.slice(lastIndex, match.index));
    redacted += redactMarkdownFence(match[1] ?? '', match[2] ?? '');
    lastIndex = match.index + match[0].length;
  }

  redacted += redactStringValue(text.slice(lastIndex));
  return redacted;
}

/* ─── Path Helpers ─────────────────────────────────────────────── */

export function taskMdDir(basePath: string, taskId: string): string {
  return `${basePath}/tasks/${taskId}`;
}

export function taskMdPath(basePath: string, taskId: string): string {
  return `${taskMdDir(basePath, taskId)}/TASK.md`;
}

export function resultMdPath(basePath: string, taskId: string): string {
  return `${taskMdDir(basePath, taskId)}/RESULT.md`;
}

export function evidenceMdPath(basePath: string, taskId: string): string {
  return `${taskMdDir(basePath, taskId)}/EVIDENCE.md`;
}

export function reviewMdPath(basePath: string, taskId: string): string {
  return `${taskMdDir(basePath, taskId)}/REVIEW.md`;
}

export function changelogMdPath(basePath: string, taskId: string): string {
  return `${taskMdDir(basePath, taskId)}/CHANGELOG.md`;
}

export function traceMdPath(basePath: string): string {
  return `${basePath}/TRACE.md`;
}

/* ─── Metadata helpers ─────────────────────────────────────────── */

export function getMdArtifactPaths(
  entity: ProjectOrchestration | ProjectOrchestrationTask,
): Record<string, string> | null {
  const meta = entity.metadata as Record<string, unknown> | null | undefined;
  if (!meta || typeof meta !== 'object') return null;
  const artifacts = meta.md_artifacts;
  if (!artifacts || typeof artifacts !== 'object') return null;
  return artifacts as Record<string, string>;
}

export function setMdArtifactPaths(
  entity: ProjectOrchestration | ProjectOrchestrationTask,
  paths: Record<string, string>,
): void {
  const meta = (entity.metadata as Record<string, unknown>) ?? {};
  meta.md_artifacts = { ...(meta.md_artifacts as Record<string, string> ?? {}), ...paths };
  entity.metadata = meta;
}

/* ─── Renderers ────────────────────────────────────────────────── */

export function renderTaskMd(
  orchestration: ProjectOrchestration,
  task: ProjectOrchestrationTask,
  scopeText: string,
): string {
  return [
    `# Task Spec: ${task.title}`,
    '',
    `- Orchestration: ${orchestration.id}`,
    `- Task ID: ${task.id}`,
    task.assignedAgentId ? `- Assigned Agent: ${task.assignedAgentId}` : '- Assigned Agent: unassigned',
    `- Status: ${task.status}`,
    '',
    '## Goal',
    '',
    redactMarkdown(task.goal),
    '',
    '## Scope',
    '',
    redactMarkdown(scopeText),
    '',
    '## Acceptance Criteria',
    '',
    ...(task.acceptanceCriteria?.length
      ? task.acceptanceCriteria.map((a) => `- ${a}`)
      : ['- Result satisfies the task goal.', '- Evidence explains how it was verified.']),
    '',
    task.dependsOn?.length
      ? [
          '## Dependencies',
          '',
          ...task.dependsOn.map((d) => `- Depends on: \`${d}\``),
          '',
        ].join('\n')
      : '',
    '## Artifact References',
    '',
    `- Goal: \`${orchestration.basePath}/goal.md\``,
    `- Plan: \`${orchestration.basePath}/plan.md\``,
    `- Task ledger: \`${orchestration.basePath}/tasks.json\``,
    '',
  ].join('\n');
}

export function renderResultMd(
  task: ProjectOrchestrationTask,
  resultMd: string,
): string {
  return [
    `# Result: ${task.title}`,
    '',
    `- Task ID: ${task.id}`,
    `- Status: ${task.status}`,
    `- Completed at: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    redactMarkdown(resultMd),
    '',
  ].join('\n');
}

export function renderEvidenceMd(
  task: ProjectOrchestrationTask,
  evidence: Record<string, unknown>,
): string {
  const safeEvidence = redactValue(evidence) as Record<string, unknown>;

  const lines: string[] = [
    `# Evidence: ${task.title}`,
    '',
    `- Task ID: ${task.id}`,
    `- Generated at: ${new Date().toISOString()}`,
    '',
    '## Evidence Data',
    '',
  ];

  if (Object.keys(safeEvidence).length === 0) {
    lines.push('_No structured evidence was submitted._');
  } else {
    for (const [key, value] of Object.entries(safeEvidence)) {
      if (typeof value === 'string') {
        lines.push(`### ${key}`);
        lines.push('');
        lines.push(value);
        lines.push('');
      } else if (Array.isArray(value)) {
        lines.push(`### ${key}`);
        lines.push('');
        for (const item of value) {
          lines.push(`- ${JSON.stringify(item)}`);
        }
        lines.push('');
      } else if (typeof value === 'object' && value !== null) {
        lines.push(`### ${key}`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(value, null, 2));
        lines.push('```');
        lines.push('');
      } else {
        lines.push(`- **${key}**: ${String(value)}`);
      }
    }
  }

  // Append the raw JSON block for programmatic consumption
  lines.push('---');
  lines.push('');
  lines.push('_Machine-readable evidence JSON:_');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(safeEvidence, null, 2));
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

export function renderReviewMd(
  orchestration: ProjectOrchestration,
  task: ProjectOrchestrationTask,
  review: {
    decision: 'approved' | 'changes_requested';
    notes: string;
    requestedChanges: string;
    actorId: string;
  },
): string {
  return [
    `# Review: ${task.title}`,
    '',
    `- Orchestration: ${orchestration.id}`,
    `- Task ID: ${task.id}`,
    `- Decision: **${review.decision}**`,
    `- Reviewer: \`${review.actorId}\``,
    `- Reviewed at: ${new Date().toISOString()}`,
    '',
    review.notes
      ? [
          '## Notes',
          '',
          redactMarkdown(review.notes),
          '',
        ].join('\n')
      : '',
    review.requestedChanges
      ? [
          '## Requested Changes',
          '',
          redactMarkdown(review.requestedChanges),
          '',
        ].join('\n')
      : '',
    `## Artifact References`,
    '',
    task.resultPath ? `- Result: \`${task.resultPath}\`` : null,
    task.evidencePath ? `- Evidence: \`${task.evidencePath}\`` : null,
    '',
  ].filter(Boolean).join('\n');
}

export function renderChangelogMd(
  task: ProjectOrchestrationTask,
  resultMd: string,
  evidence: Record<string, unknown>,
): string {
  const safeResultMd = redactMarkdown(resultMd);

  // Extract file paths from result_md by looking for markdown-style file references
  const changedFiles: string[] = [];
  const fileRefPattern = /[`\*]{1,2}([a-zA-Z0-9_./-]+\.[a-z]+)[`\*]{1,2}/g;
  let match: RegExpExecArray | null;
  while ((match = fileRefPattern.exec(safeResultMd)) !== null) {
    const ref = match[1];
    if (!changedFiles.includes(ref)) {
      changedFiles.push(ref);
    }
  }

  return [
    `# Changelog: ${task.title}`,
    '',
    `- Task ID: ${task.id}`,
    `- Status: ${task.status}`,
    `- Completed at: ${new Date().toISOString()}`,
    '',
    '## Changed Files',
    '',
    changedFiles.length > 0
      ? changedFiles.map((f) => `- \`${f}\``).join('\n')
      : '_No specific file references found in result. See RESULT.md and EVIDENCE.md for details._',
    '',
    '## Completion Notes',
    '',
    safeResultMd.split('\n').slice(0, 10).join('\n'),
    '',
    '---',
    '',
    '_This changelog is auto-generated from worker result and evidence on task completion._',
    '',
  ].join('\n');
}

export function renderTraceMd(
  orchestration: ProjectOrchestration,
  tasks: ProjectOrchestrationTask[],
  summary: string,
): string {
  const lines: string[] = [
    `# Trace: ${orchestration.title}`,
    '',
    `- Orchestration: ${orchestration.id}`,
    `- Project: ${orchestration.projectId}`,
    `- Status: ${orchestration.status}`,
    `- Completed at: ${orchestration.completedAt?.toISOString() ?? new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    redactMarkdown(summary),
    '',
    '## Task Index',
    '',
    '| # | Task ID | Title | Status | Assigned Agent | TASK.md | RESULT.md | REVIEW.md | CHANGELOG.md |',
    '|---|---------|-------|--------|----------------|---------|-----------|-----------|--------------|',
  ];

  tasks.forEach((task, i) => {
    const artifacts = getMdArtifactPaths(task);
    const taskRef = artifacts?.task ? `\`${artifacts.task}\`` : '-';
    const resultRef = artifacts?.result ? `\`${artifacts.result}\`` : '-';
    const reviewRef = artifacts?.review ? `\`${artifacts.review}\`` : '-';
    const changelogRef = artifacts?.changelog ? `\`${artifacts.changelog}\`` : '-';

    lines.push(
      `| ${i + 1} | \`${task.id}\` | ${task.title} | ${task.status} | ${task.assignedAgentId ?? '-'} | ${taskRef} | ${resultRef} | ${reviewRef} | ${changelogRef} |`,
    );
  });

  lines.push('', '', '## Artifact References', '');
  lines.push(`- Goal: \`${orchestration.basePath}/goal.md\``);
  lines.push(`- Plan: \`${orchestration.basePath}/plan.md\``);
  lines.push(`- Trace: \`${orchestration.basePath}/TRACE.md\``);
  lines.push(`- Task ledger: \`${orchestration.basePath}/tasks.json\``);
  lines.push(`- PM review log: \`${orchestration.basePath}/pm-review.md\``);
  lines.push('');

  return lines.join('\n');
}

/* ─── Writers (upsert ProjectFile via EntityManager) ──────────── */

async function upsertMdFile(
  manager: EntityManager,
  projectId: string,
  path: string,
  content: string,
  actorId: string,
  message: string,
): Promise<void> {
  // Delegate to the shared write core (single place for the future git `add`).
  const { upsertProjectFileContent } = await import('./project-file.service');
  await upsertProjectFileContent(manager, {
    projectId,
    path,
    content,
    contentType: 'text/markdown',
    message: message.slice(0, 512),
    actorId,
    maxFileBytes: MAX_FILE_BYTES,
  });
}

export async function writeTaskMd(
  manager: EntityManager,
  orchestration: ProjectOrchestration,
  task: ProjectOrchestrationTask,
  scopeText: string,
): Promise<void> {
  const path = taskMdPath(orchestration.basePath, task.id);
  const content = renderTaskMd(orchestration, task, scopeText);
  const actorId = task.createdByAgentId ?? task.createdByUserId ?? 'system';

  await upsertMdFile(manager, task.projectId, path, content, actorId, `Create TASK.md for ${task.id}`);
}

export async function writeResultMd(
  manager: EntityManager,
  task: ProjectOrchestrationTask,
  resultMd: string,
): Promise<string> {
  const basePath = task.orchestration.basePath;
  const path = resultMdPath(basePath, task.id);
  const content = renderResultMd(task, resultMd);
  const actorId = task.assignedAgentId ?? 'system';

  await upsertMdFile(manager, task.projectId, path, content, actorId, `Create RESULT.md for ${task.id}`);
  return path;
}

export async function writeEvidenceMd(
  manager: EntityManager,
  task: ProjectOrchestrationTask,
  evidence: Record<string, unknown>,
): Promise<string> {
  const basePath = task.orchestration.basePath;
  const path = evidenceMdPath(basePath, task.id);
  const content = renderEvidenceMd(task, evidence);
  const actorId = task.assignedAgentId ?? 'system';

  await upsertMdFile(manager, task.projectId, path, content, actorId, `Create EVIDENCE.md for ${task.id}`);
  return path;
}

export async function writeReviewMd(
  manager: EntityManager,
  orchestration: ProjectOrchestration,
  task: ProjectOrchestrationTask,
  review: {
    decision: 'approved' | 'changes_requested';
    notes: string;
    requestedChanges: string;
    actorId: string;
  },
): Promise<string> {
  const path = reviewMdPath(orchestration.basePath, task.id);
  const content = renderReviewMd(orchestration, task, review);
  const actorId = review.actorId;

  await upsertMdFile(manager, task.projectId, path, content, actorId, `PM review for ${task.id}`);
  return path;
}

export async function writeChangelogMd(
  manager: EntityManager,
  task: ProjectOrchestrationTask,
  resultMd: string,
  evidence: Record<string, unknown>,
): Promise<string> {
  const basePath = task.orchestration.basePath;
  const path = changelogMdPath(basePath, task.id);
  const content = renderChangelogMd(task, resultMd, evidence);
  const actorId = task.assignedAgentId ?? 'system';

  await upsertMdFile(manager, task.projectId, path, content, actorId, `Create CHANGELOG.md for ${task.id}`);
  return path;
}

export async function writeTraceMd(
  manager: EntityManager,
  orchestration: ProjectOrchestration,
  tasks: ProjectOrchestrationTask[],
  summary: string,
): Promise<string> {
  const path = traceMdPath(orchestration.basePath);
  const content = renderTraceMd(orchestration, tasks, summary);
  const actorId = orchestration.createdByAgentId ?? orchestration.createdByUserId ?? 'system';

  await upsertMdFile(manager, orchestration.projectId, path, content, actorId, `Create TRACE.md for ${orchestration.id}`);
  return path;
}
