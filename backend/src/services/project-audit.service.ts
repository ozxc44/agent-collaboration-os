import { AppDataSource } from '../data-source';
import { ProjectAuditEvent, ProjectAuditAction } from '../entities/project-audit-event.entity';
import crypto from 'node:crypto';

const auditRepo = AppDataSource.getRepository(ProjectAuditEvent);
const MAX_AUDIT_STRING_LENGTH = 240;
const AUDIT_CHAIN_VERSION = 'v1';
const AUDIT_CHAIN_ALGORITHM = 'sha256';
const AUDIT_CHAIN_ROOT_HASH = '0'.repeat(64);
const BLOCKED_METADATA_KEY_PARTS = [
  'secret',
  'token',
  'password',
  'api_key',
  'apikey',
  'api-secret',
  'body',
  'content',
  'description',
  'metadata',
  'references',
  'markdown',
  'raw',
  'exploit',
  'payload',
];

export interface ProjectAuditTarget {
  type: string;
  id: string;
  name: string;
}

/**
 * Record a project-scoped audit event for a non-member module (wiki, release,
 * package, security advisory, etc.).
 *
 * The helper stores target type/id/name at the top of metadata_json and merges
 * in caller-provided safe metadata (e.g. changed_fields, previous/new titles or
 * slugs, status/severity). It never captures raw secrets, tokens, API keys, or
 * large body/description/reference payloads.
 */
export async function recordProjectModuleAudit(
  projectId: string,
  actorUserId: string,
  action: ProjectAuditAction,
  target: ProjectAuditTarget,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await auditRepo.save(
    auditRepo.create({
      projectId,
      actorUserId,
      action,
      targetUserId: null,
      previousRole: null,
      newRole: null,
      metadataJson: sanitizeAuditMetadata({
        target_type: target.type,
        target_id: target.id,
        target_name: target.name,
        ...metadata,
      }),
    }),
  );
}

export interface ProjectAuditAttestationSummary {
  available: boolean;
  status: 'empty' | 'verified' | 'broken';
  verified: boolean;
  local_only: boolean;
  legal_grade: boolean;
  algorithm: string;
  version: string;
  total_events: number;
  covered_events: number;
  missing_hash_count: number;
  latest_event_id: string | null;
  latest_hash: string | null;
  broken_at_event_id: string | null;
  description: string;
}

export async function materializeAndVerifyProjectAuditChain(
  projectId: string,
): Promise<ProjectAuditAttestationSummary> {
  const events = await auditRepo.find({
    where: { projectId },
    order: { createdAt: 'ASC', id: 'ASC' },
  });

  let previousHash = AUDIT_CHAIN_ROOT_HASH;
  let coveredEvents = 0;
  let missingHashCount = 0;
  let brokenAtEventId: string | null = null;
  let latestEventId: string | null = null;
  let latestHash: string | null = null;

  for (const event of events) {
    const expectedHash = hashAuditEvent(event, previousHash);
    const storedPrevHash = event.chainPrevHash ?? null;
    const storedHash = event.chainHash ?? null;
    const storedVersion = event.chainHashVersion ?? null;

    if (!storedPrevHash || !storedHash || !storedVersion) {
      missingHashCount += 1;
      await auditRepo.update(event.id, {
        chainPrevHash: previousHash,
        chainHash: expectedHash,
        chainHashVersion: AUDIT_CHAIN_VERSION,
      });
      event.chainPrevHash = previousHash;
      event.chainHash = expectedHash;
      event.chainHashVersion = AUDIT_CHAIN_VERSION;
    } else if (
      storedPrevHash !== previousHash ||
      storedHash !== expectedHash ||
      storedVersion !== AUDIT_CHAIN_VERSION
    ) {
      brokenAtEventId = event.id;
      break;
    }

    coveredEvents += 1;
    latestEventId = event.id;
    latestHash = event.chainHash ?? expectedHash;
    previousHash = latestHash;
  }

  const verified = brokenAtEventId === null;
  const status = events.length === 0 ? 'empty' : verified ? 'verified' : 'broken';
  return {
    available: true,
    status,
    verified,
    local_only: true,
    legal_grade: false,
    algorithm: AUDIT_CHAIN_ALGORITHM,
    version: AUDIT_CHAIN_VERSION,
    total_events: events.length,
    covered_events: coveredEvents,
    missing_hash_count: missingHashCount,
    latest_event_id: latestEventId,
    latest_hash: latestHash,
    broken_at_event_id: brokenAtEventId,
    description: describeAuditAttestation(status, events.length, missingHashCount),
  };
}

function describeAuditAttestation(
  status: ProjectAuditAttestationSummary['status'],
  totalEvents: number,
  missingHashCount: number,
): string {
  if (totalEvents === 0) {
    return 'Local audit hash-chain is available; no audit events exist yet.';
  }
  if (status === 'broken') {
    return 'Local audit hash-chain verification failed; at least one stored event no longer matches its recorded hash.';
  }
  if (missingHashCount > 0) {
    return 'Local audit hash-chain was materialized for previously uncovered audit events and verified.';
  }
  return 'Local audit hash-chain verified. This is a local integrity proof, not legal-grade immutable attestation.';
}

function hashAuditEvent(event: ProjectAuditEvent, previousHash: string): string {
  const payload = stableStringify({
    version: AUDIT_CHAIN_VERSION,
    algorithm: AUDIT_CHAIN_ALGORITHM,
    previous_hash: previousHash,
    event: {
      id: event.id,
      project_id: event.projectId,
      actor_user_id: event.actorUserId,
      target_user_id: event.targetUserId ?? null,
      action: event.action,
      previous_role: event.previousRole ?? null,
      new_role: event.newRole ?? null,
      metadata_json: event.metadataJson ?? null,
      created_at: normalizeAuditTimestamp(event.createdAt),
    },
  });
  return crypto.createHash(AUDIT_CHAIN_ALGORITHM).update(payload).digest('hex');
}

function normalizeAuditTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key !== 'changed_fields' && isBlockedMetadataKey(key)) continue;
    const cleanValue = sanitizeAuditValue(key, value);
    if (cleanValue !== undefined) sanitized[key] = cleanValue;
  }
  return sanitized;
}

function isBlockedMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return BLOCKED_METADATA_KEY_PARTS.some((part) => normalized.includes(part));
}

function sanitizeAuditValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const safe = key.toLowerCase().includes('url') ? stripUrlUserInfo(value) : value;
    return safe.length > MAX_AUDIT_STRING_LENGTH ? `${safe.slice(0, MAX_AUDIT_STRING_LENGTH)}...` : safe;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      .slice(0, 32)
      .map((item) => (typeof item === 'string' ? sanitizeAuditValue(key, item) : item));
  }
  return undefined;
}

function stripUrlUserInfo(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw;
  }
}
