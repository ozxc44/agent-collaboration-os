import { Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { authenticate, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { Incident, IncidentStatus } from '../entities/incident.entity';
import { Agent } from '../entities/agent.entity';
import { ProjectMember } from '../entities/project-member.entity';
import { ProjectRole } from '../entities/project-member.entity';
import { alertRoutingService } from '../services/alert-routing.service';

const router = Router();
const incidentRepo = AppDataSource.getRepository(Incident);
const agentRepo = AppDataSource.getRepository(Agent);
const memberRepo = AppDataSource.getRepository(ProjectMember);

/**
 * GET /v1/incidents
 * List incidents for agents in projects the user can view health for.
 * Requires JWT (not agent API key).
 * Query params: status, severity, agent_id, skip, limit
 */
router.get(
  '/v1/incidents',
  authenticate,
  async (req: Request, res: Response) => {
    // Reject agent API keys on JWT-only platform route
    if (req.agent) {
      res.status(401).json({ detail: 'Agent API key cannot access platform incident routes' });
      return;
    }

    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
      const status = req.query.status as IncidentStatus | undefined;
      const severity = req.query.severity as string | undefined;
      const agentId = req.query.agent_id as string | undefined;

      // Find projects where user has ViewHealth permission
      const memberships = await memberRepo.find({ where: { userId } });
      const viewerProjectIds = new Set<string>();
      for (const m of memberships) {
        if (m.role === ProjectRole.OWNER || m.role === ProjectRole.ADMIN ||
            m.role === ProjectRole.MEMBER || m.role === ProjectRole.VIEWER) {
          viewerProjectIds.add(m.projectId);
        }
      }

      if (viewerProjectIds.size === 0) {
        res.json({ data: [], meta: { total: 0, skip, limit } });
        return;
      }

      // Find agents in those projects
      const agents = await agentRepo
        .createQueryBuilder('agent')
        .where('agent.projectId IN (:...projectIds)', { projectIds: Array.from(viewerProjectIds) })
        .select(['agent.id'])
        .getMany();
      const agentIds = new Set(agents.map((a) => a.id));

      if (agentIds.size === 0) {
        res.json({ data: [], meta: { total: 0, skip, limit } });
        return;
      }

      const where: Record<string, unknown> = { agentId: In(Array.from(agentIds)) };
      if (status) where.status = status;
      if (severity) where.severity = severity;
      if (agentId) {
        // If filtering by a specific agent, verify it belongs to an accessible project
        if (!agentIds.has(agentId)) {
          res.json({ data: [], meta: { total: 0, skip, limit } });
          return;
        }
        where.agentId = agentId;
      }

      const [incidents, total] = await incidentRepo.findAndCount({
        where,
        skip,
        take: limit,
        order: { createdAt: 'DESC' },
      });

      res.json({
        data: incidents.map(formatIncident),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List incidents error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:project_id/agents/:agent_id/incidents
 * List incidents for a specific agent within a project.
 */
router.get(
  '/v1/projects/:project_id/agents/:agent_id/incidents',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewHealth),
  async (req: Request, res: Response) => {
    try {
      const agentId = req.params.agent_id;
      const status = req.query.status as IncidentStatus | undefined;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = parseInt(req.query.limit as string, 10) || 50;

      const where: Record<string, unknown> = { agentId };
      if (status) where.status = status;

      const [incidents, total] = await incidentRepo.findAndCount({
        where,
        skip,
        take: Math.min(limit, 100),
        order: { createdAt: 'DESC' },
      });

      res.json({
        data: incidents.map(formatIncident),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List agent incidents error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/incidents/:id
 * Get a single incident. Requires JWT (not agent API key) and ViewHealth
 * access to the incident's agent project.
 */
router.get(
  '/v1/incidents/:id',
  authenticate,
  async (req: Request, res: Response) => {
    // Reject agent API keys on JWT-only platform route
    if (req.agent) {
      res.status(401).json({ detail: 'Agent API key cannot access platform incident routes' });
      return;
    }

    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const incident = await incidentRepo.findOne({ where: { id: req.params.id } });
      if (!incident) {
        res.status(404).json({ detail: 'Incident not found' });
        return;
      }

      // Check if user has ViewHealth on the incident's agent's project
      const agent = await agentRepo.findOne({ where: { id: incident.agentId } });
      if (!agent) {
        res.status(404).json({ detail: 'Incident agent not found' });
        return;
      }

      const membership = await memberRepo.findOne({
        where: { projectId: agent.projectId, userId },
      });
      if (!membership) {
        res.status(403).json({ detail: 'Not authorized to view this incident' });
        return;
      }

      const role = membership.role;
      if (role !== ProjectRole.OWNER && role !== ProjectRole.ADMIN &&
          role !== ProjectRole.MEMBER && role !== ProjectRole.VIEWER) {
        res.status(403).json({ detail: 'Insufficient permissions to view incident' });
        return;
      }

      res.json({ data: formatIncident(incident) });
    } catch (err) {
      console.error('Get incident error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * PATCH /v1/incidents/:id
 * Update an incident (acknowledge, resolve, dismiss).
 * Requires JWT (not agent API key) and Owner/Admin on the incident's agent project.
 * Body: { status: 'acknowledged' | 'resolved' | 'dismissed' }
 */
router.patch(
  '/v1/incidents/:id',
  authenticate,
  async (req: Request, res: Response) => {
    // Reject agent API keys on JWT-only platform route
    if (req.agent) {
      res.status(401).json({ detail: 'Agent API key cannot access platform incident routes' });
      return;
    }

    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const incident = await incidentRepo.findOne({ where: { id: req.params.id } });
      if (!incident) {
        res.status(404).json({ detail: 'Incident not found' });
        return;
      }

      // Require Owner/Admin on the incident's agent project
      const agent = await agentRepo.findOne({ where: { id: incident.agentId } });
      if (!agent) {
        res.status(404).json({ detail: 'Incident agent not found' });
        return;
      }

      const membership = await memberRepo.findOne({
        where: { projectId: agent.projectId, userId },
      });
      if (!membership) {
        res.status(403).json({ detail: 'Not authorized to modify this incident' });
        return;
      }

      if (membership.role !== ProjectRole.OWNER && membership.role !== ProjectRole.ADMIN) {
        res.status(403).json({ detail: 'Owner or Admin required to modify incidents' });
        return;
      }

      const { status } = req.body;
      if (!status || !['acknowledged', 'resolved', 'dismissed'].includes(status)) {
        res.status(400).json({ detail: 'Invalid status. Must be: acknowledged, resolved, or dismissed' });
        return;
      }

      if (status === 'resolved') {
        const resolved = await alertRoutingService.resolve(incident.id, userId);
        if (!resolved) {
          res.status(500).json({ detail: 'Failed to resolve incident' });
          return;
        }
        res.json({ data: formatIncident(resolved) });
        return;
      }

      incident.status = status as IncidentStatus;
      if (status === 'dismissed') {
        incident.resolvedAt = new Date();
      }
      await incidentRepo.save(incident);

      res.json({ data: formatIncident(incident) });
    } catch (err) {
      console.error('Update incident error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/agents/:agent_id/health-check
 * Manually trigger a health check for a specific agent.
 */
router.post(
  '/v1/projects/:project_id/agents/:agent_id/health-check',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewHealth),
  async (req: Request, res: Response) => {
    try {
      const { healthMonitorService } = await import('../services/health-monitor.service');
      const agentId = req.params.agent_id;

      const newIncidents = await healthMonitorService.checkAgent(agentId);

      // Route each new incident through the alert routing service
      const { alertRoutingService } = await import('../services/alert-routing.service');
      for (const incident of newIncidents) {
        await alertRoutingService.route(incident);
      }

      res.json({
        agent_id: agentId,
        checked_at: new Date().toISOString(),
        new_incidents: newIncidents.length,
        data: newIncidents.map(formatIncident),
      });
    } catch (err) {
      console.error('Manual health check error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatIncident(inc: Incident) {
  return {
    id: inc.id,
    agent_id: inc.agentId,
    type: inc.type,
    severity: inc.severity,
    status: inc.status,
    message: inc.message,
    details: inc.details || {},
    resolved_at: inc.resolvedAt || null,
    resolved_by: inc.resolvedBy || null,
    created_at: inc.createdAt,
    updated_at: inc.updatedAt,
  };
}

export default router;
