import { Router, Request, Response } from 'express';
import { authenticate, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { ProjectIncident, ProjectIncidentStatus } from '../entities/project-incident.entity';
import { Agent } from '../entities/agent.entity';
import { getAgentPresence } from '../services/agent-presence.service';

const router = Router();
const incidentRepo = AppDataSource.getRepository(ProjectIncident);
const agentRepo = AppDataSource.getRepository(Agent);

function rollupStatus(statuses: Array<'healthy' | 'degraded' | 'down'>): 'healthy' | 'degraded' | 'down' {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'healthy';
}

function metricsArray(metricsJson: Record<string, unknown> | undefined): unknown[] {
  if (!metricsJson) return [];
  if (Array.isArray(metricsJson.metrics)) return metricsJson.metrics;
  return Object.entries(metricsJson)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
    .map(([name, value]) => ({ name, value }));
}

/**
 * GET /v1/health
 * Platform-wide, project, or agent health check. No authentication is still
 * accepted for the basic probe and V1 demo compatibility.
 */
router.get('/v1/health', async (req: Request, res: Response) => {
  try {
    const projectId = req.query.project_id as string | undefined;
    const agentId = req.query.agent_id as string | undefined;

    if (agentId || projectId) {
      const agents = await agentRepo.find({
        where: {
          ...(agentId ? { id: agentId } : {}),
          ...(projectId ? { projectId } : {}),
        },
      });

      if (agentId && agents.length === 0) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      const snapshots = agents.map((agent) => getAgentPresence(agent));
      const statuses = snapshots.map((snapshot) => snapshot.healthStatus);
      const checkedAt = new Date().toISOString();

      if (agentId && agents[0]) {
        const agent = agents[0];
        const presence = snapshots[0];
        res.json({
          project_id: agent.projectId,
          agent_id: agent.id,
          status: presence.healthStatus,
          presence: presence.presence,
          is_online: presence.isOnline,
          dispatchable: presence.dispatchable,
          last_seen_at: presence.lastHeartbeatAt,
          heartbeat_age_ms: presence.heartbeatAgeMs,
          metrics: metricsArray(agent.metricsJson),
          checked_at: checkedAt,
        });
        return;
      }

      res.json({
        project_id: projectId,
        status: rollupStatus(statuses),
        metrics: agents.flatMap((agent) =>
          metricsArray(agent.metricsJson).map((metric) => ({
            ...(typeof metric === 'object' && metric !== null ? metric : { value: metric }),
            agent_id: agent.id,
          })),
        ),
        checked_at: checkedAt,
      });
      return;
    }

    const dbHealthy = await checkDatabaseHealth();

    const status = dbHealthy ? 'healthy' : 'degraded';
    res.json({
      status,
      version: '2.0.0',
      uptime_seconds: Math.floor(process.uptime()),
      checked_at: new Date().toISOString(),
      metrics: [
        { name: 'uptime_seconds', value: Math.floor(process.uptime()), unit: 's' },
      ],
    });
  } catch (err) {
    console.error('Health check error:', err);
    res.json({
      status: 'degraded',
      version: '2.0.0',
      uptime_seconds: Math.floor(process.uptime()),
    });
  }
});

/**
 * GET /v1/projects/:project_id/health
 * Get project health status.
 */
router.get(
  '/v1/projects/:project_id/health',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewHealth),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;

      // Count open incidents for severity assessment
      const openIncidents = await incidentRepo.count({
        where: { projectId, status: ProjectIncidentStatus.ACTIVE },
      });

      const status = openIncidents > 0 ? 'degraded' : 'healthy';
      const statusEnum = openIncidents > 0 ? 'degraded' : 'healthy';

      res.json({
        project_id: projectId,
        status: statusEnum,
        last_check: new Date().toISOString(),
        metrics: {
          open_incidents: openIncidents,
          uptime_seconds: Math.floor(process.uptime()),
        },
      });
    } catch (err) {
      console.error('Project health error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/projects/:project_id/health/incidents
 * List incidents for a project (filterable by status and severity).
 */
router.get(
  '/v1/projects/:project_id/health/incidents',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewHealth),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const status = req.query.status as string | undefined;
      const severity = req.query.severity as string | undefined;

      const where: Record<string, unknown> = { projectId };
      if (status) where.status = status;
      if (severity) where.severity = severity;

      const [incidents, total] = await incidentRepo.findAndCount({
        where,
        skip,
        take: Math.min(limit, 100),
        order: { createdAt: 'DESC' },
      });

      res.json({
        data: incidents.map((inc) => ({
          id: inc.id,
          project_id: inc.projectId,
          type: inc.severity,
          severity: inc.severity,
          status: inc.status,
          details: inc.descriptionJson || {},
          created_at: inc.createdAt,
          resolved_at: inc.resolvedAt || null,
        })),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List incidents error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * PATCH /v1/projects/:project_id/health/incidents/:iid
 * Update an incident's status, severity, or details.
 */
router.patch(
  '/v1/projects/:project_id/health/incidents/:iid',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewHealth),
  async (req: Request, res: Response) => {
    try {
      const incident = await incidentRepo.findOne({
        where: { id: req.params.iid, projectId: req.params.project_id },
      });

      if (!incident) {
        res.status(404).json({ detail: 'Incident not found' });
        return;
      }

      const { status, severity, details } = req.body;

      if (status !== undefined) {
        incident.status = status as ProjectIncidentStatus;
        if (status === 'resolved' || status === ProjectIncidentStatus.RESOLVED) {
          incident.resolvedAt = new Date();
        }
      }

      if (severity !== undefined) {
        incident.severity = severity as any;
      }

      if (details !== undefined) {
        incident.descriptionJson = {
          ...(incident.descriptionJson || {}),
          ...details,
        };
      }

      await incidentRepo.save(incident);

      res.json({
        id: incident.id,
        project_id: incident.projectId,
        type: incident.severity,
        severity: incident.severity,
        status: incident.status,
        details: incident.descriptionJson || {},
        created_at: incident.createdAt,
        resolved_at: incident.resolvedAt || null,
      });
    } catch (err) {
      console.error('Update incident error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * Check if the database is reachable.
 */
async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const ds = AppDataSource;
    if (ds.isInitialized) {
      await ds.query('SELECT 1');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export default router;
