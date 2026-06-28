import { Router, Request, Response, NextFunction } from 'express';
import { getDebugLogConfig, log, LogLevel, readRecentLogEntries } from '../services/logger';

const router = Router();

function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return undefined;
  return auth.slice('Bearer '.length);
}

function requireDebugLogAccess(req: Request, res: Response, next: NextFunction): void {
  const config = getDebugLogConfig();
  if (!config.apiEnabled) {
    res.status(404).json({ detail: 'Not found' });
    return;
  }

  const configuredToken = process.env.DEBUG_LOG_API_TOKEN || process.env.DEBUG_LOG_TOKEN || '';
  if (!configuredToken) {
    res.status(503).json({ detail: 'Debug log API token is not configured' });
    return;
  }

  const suppliedToken = (req.headers['x-debug-token'] as string | undefined) || bearerToken(req);
  if (suppliedToken !== configuredToken) {
    res.status(401).json({ detail: 'Invalid debug log token' });
    return;
  }

  next();
}

function parseLevel(value: unknown): LogLevel | undefined {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
    ? value
    : undefined;
}

function parseIntegerQuery(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStatusClass(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toLowerCase();
  return /^[1-5]xx$/.test(normalized) ? normalized : undefined;
}

router.get('/v1/debug/logs/config', requireDebugLogAccess, (_req: Request, res: Response) => {
  const config = getDebugLogConfig();
  res.json({
    file_enabled: config.fileEnabled,
    file_path: config.filePath,
    api_enabled: config.apiEnabled,
    level: config.level,
    max_bytes: config.maxBytes,
    max_files: config.maxFiles,
    tail_max_bytes: config.tailMaxBytes,
  });
});

router.get('/v1/debug/logs', requireDebugLogAccess, (req: Request, res: Response) => {
  const lines = Math.min(Math.max(parseInt(String(req.query.lines || '200'), 10) || 200, 1), 2000);
  const level = parseLevel(req.query.level);
  const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : undefined;
  const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id : undefined;
  const projectId = typeof req.query.project_id === 'string' ? req.query.project_id : undefined;
  const since = typeof req.query.since === 'string' ? req.query.since : undefined;
  const status = parseIntegerQuery(req.query.status);
  const statusMin = parseIntegerQuery(req.query.status_min);
  const statusMax = parseIntegerQuery(req.query.status_max);
  const statusClass = parseStatusClass(req.query.status_class);
  const minDurationMs = parseIntegerQuery(req.query.min_duration_ms);
  const path = typeof req.query.path === 'string' ? req.query.path : undefined;
  const { file, entries } = readRecentLogEntries({
    lines,
    level,
    requestId,
    agentId,
    projectId,
    since,
    status,
    statusMin,
    statusMax,
    statusClass,
    minDurationMs,
    path,
  });

  log.debug('Debug logs queried', {
    request_id: (req as any).requestId,
    lines,
    level,
    status,
    status_min: statusMin,
    status_max: statusMax,
    status_class: statusClass,
    min_duration_ms: minDurationMs,
    path,
    filtered_count: entries.length,
  });

  if (req.query.format === 'ndjson') {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.send(entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''));
    return;
  }

  res.json({
    file,
    count: entries.length,
    entries,
  });
});

export default router;
