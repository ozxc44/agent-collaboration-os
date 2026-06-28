/**
 * Shared utility functions for project-space route files.
 *
 * These helpers are used by multiple route families (GP-Required, GP-Support,
 * Frozen) and are extracted here to avoid duplication when routes are split
 * across files.
 *
 * Do NOT add route handlers or entity imports here — keep this file limited
 * to pure helper functions and small shared constants.
 */
import crypto from 'crypto';

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB (NAS: large source files OK)
export const MAX_MEMORY_CHARS = 20_000;
export const MAX_UPLOAD_FILES = 20;
export const DEFAULT_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

export const DEFAULT_FILE_LIST_LIMIT = 50;
export const MAX_FILE_LIST_LIMIT = 200;
export const DEFAULT_FILE_LIST_OFFSET = 0;

export function validateProjectPath(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: 'path is required and must be a string' };
  }
  const path = value.trim().replace(/\\/g, '/');
  if (!path || path.length > 1024) {
    return { ok: false, error: 'path must be 1-1024 characters' };
  }
  if (path.startsWith('/') || path.includes('//') || path.split('/').includes('..')) {
    return { ok: false, error: 'path must be relative and cannot contain .. or empty segments' };
  }
  return { ok: true, value: path };
}

export function normalizePathPrefix(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null;
  return normalized;
}

export function parsePaginationLimit(value: unknown, defaultValue = DEFAULT_FILE_LIST_LIMIT, max = MAX_FILE_LIST_LIMIT): number {
  if (typeof value !== 'string' && typeof value !== 'number') return defaultValue;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return defaultValue;
  if (n <= 0) return defaultValue; // zero/negative treated as invalid/default
  return Math.min(n, max);
}

export function parsePaginationOffset(value: unknown, defaultValue = DEFAULT_FILE_LIST_OFFSET): number {
  if (typeof value !== 'string' && typeof value !== 'number') return defaultValue;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return defaultValue;
  return Math.max(0, n);
}

export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function normalizeContentType(value: unknown): string {
  if (value === 'text/plain' || value === 'application/json' || value === 'text/markdown') {
    return value;
  }
  return 'text/markdown';
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
    .map((item) => item.trim());
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function normalizeUploadContentType(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return DEFAULT_UPLOAD_CONTENT_TYPE;
  }
  const trimmed = value.trim();
  if (trimmed.length > 64) {
    return DEFAULT_UPLOAD_CONTENT_TYPE;
  }
  // Reject control characters and newlines.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return DEFAULT_UPLOAD_CONTENT_TYPE;
  }
  return trimmed;
}

function isValidBase64(value: string): boolean {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export function decodeBase64Content(value: unknown): { ok: true; buffer: Buffer } | { ok: false; error: string } {
  if (typeof value !== 'string') {
    return { ok: false, error: 'content_base64 is required and must be a string' };
  }
  if (!isValidBase64(value)) {
    return { ok: false, error: 'content_base64 is not valid base64' };
  }
  try {
    const buffer = Buffer.from(value, 'base64');
    return { ok: true, buffer };
  } catch {
    return { ok: false, error: 'content_base64 is not valid base64' };
  }
}

export function isTextLikeContentType(contentType: string): boolean {
  const base = contentType.trim().toLowerCase();
  return base === 'text/plain' || base === 'text/markdown' || base === 'application/json';
}

/**
 * Convert decoded upload bytes into the string representation stored in the
 * project_files/project_file_revisions `content` text column.
 *
 * Text-like content types are stored as UTF-8 strings so existing raw endpoints
 * continue to serve them correctly. Binary content is stored as base64 text so
 * PostgreSQL `text` columns never receive NUL or invalid UTF-8 bytes.
 */
export function storeContentString(buffer: Buffer, contentType: string): string {
  if (isTextLikeContentType(contentType)) {
    return buffer.toString('utf8');
  }
  return buffer.toString('base64');
}

/**
 * Prepare stored content for raw/download responses.
 *
 * Text-like content is sent as a UTF-8 string (preserves existing behavior for
 * legacy files and new text uploads). Binary upload content is base64-decoded
 * back to a Buffer so arbitrary bytes round-trip.
 */
export function rawContentData(content: string, contentType: string): string | Buffer {
  if (isTextLikeContentType(contentType)) {
    return content;
  }
  return Buffer.from(content, 'base64');
}
