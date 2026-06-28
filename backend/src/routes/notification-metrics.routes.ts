import { Router, Request, Response } from 'express';
import { authenticateJwtOrAgentApiKey } from '../middleware/auth';
import { AppDataSource } from '../data-source';
import { ProjectMember, ProjectRole } from '../entities/project-member.entity';
import { getProjectNotificationMetrics, getAdminNotificationMetrics } from '../services/notification-metrics.service';

const router = Router();

router.get(
  '/v1/projects/:project_id/notification-metrics',
  authenticateJwtOrAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      // Agent API keys are never allowed for notification metrics
      if (req.agent) {
        res.status(403).json({ detail: 'Agent API keys cannot access project notification metrics' });
        return;
      }

      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const projectId = req.params.project_id;
      const memberRepo = AppDataSource.getRepository(ProjectMember);
      const membership = await memberRepo.findOne({ where: { projectId, userId } });

      if (!membership) {
        res.status(403).json({ detail: 'Not a member of this project' });
        return;
      }

      if (membership.role !== ProjectRole.OWNER && membership.role !== ProjectRole.ADMIN) {
        res.status(403).json({ detail: 'Only project owner or admin can view notification metrics' });
        return;
      }

      const metrics = await getProjectNotificationMetrics(projectId);
      res.json(metrics);
    } catch (err) {
      console.error('Get notification metrics error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/admin/notification-metrics',
  authenticateJwtOrAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      // Agent API keys are never allowed for admin notification metrics
      if (req.agent) {
        res.status(403).json({ detail: 'Agent API keys cannot access admin notification metrics' });
        return;
      }

      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      const result = await getAdminNotificationMetrics(userId);
      res.json(result);
    } catch (err) {
      console.error('Get admin notification metrics error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
