import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'fs';
import { dirname, resolve } from 'path';
import { Request } from 'express';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  request_id?: string;
  method?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
  err?: string;
  [key: string]: unknown;
}

export interface DebugLogConfig {
  fileEnabled: boolean;
  filePath: string | null;
  apiEnabled: boolean;
  level: LogLevel;
  maxBytes: number;
  maxFiles: number;
  tailMaxBytes: number;
}

export interface ReadLogQuery {
  lines?: number;
  level?: LogLevel;
  requestId?: string;
  agentId?: string;
  projectId?: string;
  since?: string;
  status?: number;
  statusMin?: number;
  statusMax?: number;
  statusClass?: string;
  minDurationMs?: number;
  path?: string;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACT_KEY_RE = /(authorization|cookie|token|secret|password|api[_-]?key|jwt|credential)/i;

function envFlag(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name] || '');
}

function envInt(name: string, fallback: number): number {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function envLevel(name: string, fallback: LogLevel): LogLevel {
  const value = (process.env[name] || '').toLowerCase();
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : fallback;
}

function resolveLogFile(): string | null {
  const explicit = process.env.DEBUG_LOG_FILE || process.env.LOG_FILE;
  if (explicit) return resolve(explicit);

  if (envFlag('DEBUG_LOG_ENABLED') || envFlag('FILE_LOGGING')) {
    return resolve(process.env.LOG_DIR || './logs', 'zz-agent-debug.jsonl');
  }

  return null;
}

export function getDebugLogConfig(): DebugLogConfig {
  const filePath = resolveLogFile();
  const maxBytes = envInt('DEBUG_LOG_MAX_BYTES', 20 * 1024 * 1024);
  return {
    fileEnabled: Boolean(filePath),
    filePath,
    apiEnabled: envFlag('DEBUG_LOG_API_ENABLED'),
    level: envLevel('LOG_LEVEL', process.env.NODE_ENV === 'development' || envFlag('DEBUG') ? 'debug' : 'info'),
    maxBytes,
    maxFiles: Math.max(1, envInt('DEBUG_LOG_MAX_FILES', 5)),
    tailMaxBytes: Math.max(64 * 1024, envInt('DEBUG_LOG_TAIL_MAX_BYTES', 4 * 1024 * 1024)),
  };
}

function shouldEmit(level: LogLevel): boolean {
  const configured = getDebugLogConfig().level;
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configured];
}

function truncate(value: string, max = 2000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated:${value.length - max}]`;
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (REDACT_KEY_RE.test(key)) return '[REDACTED]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ? truncate(value.stack, 4000) : undefined,
    };
  }
  if (typeof value === 'string') return truncate(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 5) return '[MaxDepth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, key, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = sanitize(childValue, childKey, depth + 1);
  }
  return out;
}

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> {
  if (!meta) return {};
  return sanitize(meta) as Record<string, unknown>;
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function rotateIfNeeded(filePath: string, incomingBytes: number, config: DebugLogConfig): void {
  if (config.maxBytes <= 0 || !existsSync(filePath)) return;
  const size = statSync(filePath).size;
  if (size + incomingBytes <= config.maxBytes) return;

  for (let index = config.maxFiles - 1; index >= 1; index--) {
    const source = `${filePath}.${index}`;
    const target = `${filePath}.${index + 1}`;
    if (existsSync(source)) {
      renameSync(source, target);
    }
  }
  renameSync(filePath, `${filePath}.1`);
}

function writeFileLog(line: string): void {
  const config = getDebugLogConfig();
  if (!config.fileEnabled || !config.filePath) return;

  try {
    ensureParentDir(config.filePath);
    rotateIfNeeded(config.filePath, Buffer.byteLength(line) + 1, config);
    appendFileSync(config.filePath, `${line}\n`, { encoding: 'utf8', mode: 0o640 });
  } catch (err) {
    const fallback = JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'debug log write failed',
      err: String(err),
      log_file: config.filePath,
    });
    process.stderr.write(`${fallback}\n`);
  }
}

function emit(entry: LogEntry): void {
  if (!shouldEmit(entry.level)) return;
  const sanitized = sanitize(entry) as LogEntry;
  const line = JSON.stringify(sanitized);
  if (sanitized.level === 'error') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
  writeFileLog(line);
}

export const log = {
  info(msg: string, meta?: Record<string, unknown>): void {
    emit({ ts: new Date().toISOString(), level: 'info', msg, ...sanitizeMeta(meta) });
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    emit({ ts: new Date().toISOString(), level: 'warn', msg, ...sanitizeMeta(meta) });
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    emit({ ts: new Date().toISOString(), level: 'error', msg, ...sanitizeMeta(meta) });
  },
  debug(msg: string, meta?: Record<string, unknown>): void {
    emit({ ts: new Date().toISOString(), level: 'debug', msg, ...sanitizeMeta(meta) });
  },
};

function pathParam(req: Request, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = req.params?.[name] || (req as any)[name];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function queryKeys(req: Request): string[] | undefined {
  const keys = Object.keys(req.query || {});
  return keys.length > 0 ? keys.sort() : undefined;
}

function bodyKeys(req: Request): string[] | undefined {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  return keys.length > 0 ? keys.sort() : undefined;
}

function stripQueryString(value?: string): string | undefined {
  if (!value) return value;
  const queryIndex = value.indexOf('?');
  return queryIndex >= 0 ? value.slice(0, queryIndex) : value;
}

function requestContext(req: Request): Record<string, unknown> {
  const agent = req.agent;
  return {
    request_id: (req as any).requestId,
    method: req.method,
    path: req.path,
    original_url: stripQueryString(req.originalUrl),
    client_ip: req.ip || req.socket.remoteAddress,
    user_agent: req.get('user-agent'),
    user_id: req.user?.userId,
    agent_id: agent?.id || pathParam(req, 'agent_id', 'aid'),
    agent_name: agent?.name,
    project_id: agent?.projectId || pathParam(req, 'project_id', 'pid', 'projectId'),
    session_id: pathParam(req, 'session_id', 'sid', 'sessionId', 'id'),
    query_keys: queryKeys(req),
    body_keys: bodyKeys(req),
  };
}

export function requestLog(req: Request, status: number, durationMs: number, err?: Error): void {
  const level: LogLevel = err || status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg: err ? err.message : `${req.method} ${req.path} -> ${status}`,
    ...requestContext(req),
    status,
    duration_ms: durationMs,
  };
  if (err) {
    entry.err = err.stack || err.message;
  }
  emit(entry);
}

function readTail(filePath: string, maxBytes: number): string {
  if (!existsSync(filePath)) return '';
  const size = statSync(filePath).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function matchesQuery(entry: LogEntry, query: Required<Pick<ReadLogQuery, 'lines'>> & Omit<ReadLogQuery, 'lines'>): boolean {
  if (query.level && entry.level !== query.level) return false;
  if (query.requestId && entry.request_id !== query.requestId) return false;
  if (query.agentId && entry.agent_id !== query.agentId) return false;
  if (query.projectId && entry.project_id !== query.projectId) return false;
  if (query.path && entry.path !== query.path) return false;
  if (query.status !== undefined && entry.status !== query.status) return false;
  if (query.statusMin !== undefined && (typeof entry.status !== 'number' || entry.status < query.statusMin)) {
    return false;
  }
  if (query.statusMax !== undefined && (typeof entry.status !== 'number' || entry.status > query.statusMax)) {
    return false;
  }
  if (query.statusClass) {
    const classMin = Number.parseInt(query.statusClass[0], 10) * 100;
    if (!Number.isFinite(classMin) || typeof entry.status !== 'number' || entry.status < classMin || entry.status > classMin + 99) {
      return false;
    }
  }
  if (
    query.minDurationMs !== undefined &&
    (typeof entry.duration_ms !== 'number' || entry.duration_ms < query.minDurationMs)
  ) {
    return false;
  }
  if (query.since) {
    const sinceMs = Date.parse(query.since);
    const entryMs = Date.parse(entry.ts);
    if (Number.isFinite(sinceMs) && Number.isFinite(entryMs) && entryMs < sinceMs) return false;
  }
  return true;
}

export function readRecentLogEntries(query: ReadLogQuery = {}): { file: string | null; entries: LogEntry[] } {
  const config = getDebugLogConfig();
  if (!config.filePath) return { file: null, entries: [] };
  const lines = Math.min(Math.max(query.lines || 200, 1), 2000);
  const text = readTail(config.filePath, config.tailMaxBytes);
  const parsed: LogEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line) as LogEntry);
    } catch {
      parsed.push({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: 'unparseable log line',
        raw: truncate(line, 1000),
      });
    }
  }

  const normalizedQuery = { ...query, lines };
  return {
    file: config.filePath,
    entries: parsed.filter((entry) => matchesQuery(entry, normalizedQuery)).slice(-lines),
  };
}
