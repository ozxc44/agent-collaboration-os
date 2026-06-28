import { Agent, AgentStatus, AgentLifecycleStatus } from '../entities/agent.entity';

export type AgentPresence = 'online' | 'stale' | 'offline';
export type AgentHealthStatus = 'healthy' | 'degraded' | 'down';

export interface AgentPresenceSnapshot {
  presence: AgentPresence;
  healthStatus: AgentHealthStatus;
  isOnline: boolean;
  dispatchable: boolean;
  lastHeartbeatAt: Date | null;
  heartbeatAgeMs: number | null;
  onlineTtlMs: number;
  staleTtlMs: number;
}

export const DEFAULT_AGENT_ONLINE_TTL_MS = 90_000;
export const DEFAULT_AGENT_STALE_TTL_MS = 5 * 60_000;

export function getAgentPresence(agent: Agent, nowMs = Date.now()): AgentPresenceSnapshot {
  const onlineTtlMs = positiveIntegerFromEnv('AGENT_ONLINE_TTL_MS', DEFAULT_AGENT_ONLINE_TTL_MS);
  const staleTtlMs = Math.max(
    onlineTtlMs,
    positiveIntegerFromEnv('AGENT_STALE_TTL_MS', DEFAULT_AGENT_STALE_TTL_MS),
  );
  const lastHeartbeatAt = agent.lastHeartbeatAt ?? null;
  const heartbeatAgeMs = lastHeartbeatAt ? Math.max(0, nowMs - lastHeartbeatAt.getTime()) : null;

  // Retired/superseded agents are never dispatchable regardless of heartbeat
  const lifecycle = (agent as any).lifecycleStatus as AgentLifecycleStatus | undefined;
  if (lifecycle === AgentLifecycleStatus.RETIRED || lifecycle === AgentLifecycleStatus.SUPERSEDED) {
    return snapshot('offline', 'down', false, lastHeartbeatAt, heartbeatAgeMs, onlineTtlMs, staleTtlMs);
  }

  if (agent.status === AgentStatus.INACTIVE) {
    return snapshot('offline', 'down', false, lastHeartbeatAt, heartbeatAgeMs, onlineTtlMs, staleTtlMs);
  }

  if (agent.status === AgentStatus.ERROR) {
    return snapshot('offline', 'degraded', false, lastHeartbeatAt, heartbeatAgeMs, onlineTtlMs, staleTtlMs);
  }

  if (heartbeatAgeMs === null) {
    return snapshot('offline', 'down', false, lastHeartbeatAt, null, onlineTtlMs, staleTtlMs);
  }

  if (heartbeatAgeMs <= onlineTtlMs) {
    return snapshot('online', 'healthy', true, lastHeartbeatAt, heartbeatAgeMs, onlineTtlMs, staleTtlMs);
  }

  if (heartbeatAgeMs <= staleTtlMs) {
    return snapshot('stale', 'degraded', false, lastHeartbeatAt, heartbeatAgeMs, onlineTtlMs, staleTtlMs);
  }

  return snapshot('offline', 'down', false, lastHeartbeatAt, heartbeatAgeMs, onlineTtlMs, staleTtlMs);
}

export function isAgentDispatchable(agent: Agent, nowMs = Date.now()): boolean {
  return getAgentPresence(agent, nowMs).dispatchable;
}

function snapshot(
  presence: AgentPresence,
  healthStatus: AgentHealthStatus,
  dispatchable: boolean,
  lastHeartbeatAt: Date | null,
  heartbeatAgeMs: number | null,
  onlineTtlMs: number,
  staleTtlMs: number,
): AgentPresenceSnapshot {
  return {
    presence,
    healthStatus,
    isOnline: presence === 'online',
    dispatchable,
    lastHeartbeatAt,
    heartbeatAgeMs,
    onlineTtlMs,
    staleTtlMs,
  };
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
