import { Router, Request, Response } from 'express';
import { authenticate, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { mcpBridgeService } from '../services/mcp-bridge.service';

const router = Router();

/**
 * POST /v1/projects/:pid/mcp/capabilities
 * Register a new MCP capability for an agent within a project.
 */
router.post(
  '/v1/projects/:pid/mcp/capabilities',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.pid;
      const { agent_id, name, description, schema } = req.body;

      if (!agent_id || typeof agent_id !== 'string') {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'agent_id'],
              msg: 'agent_id is required and must be a string',
              type: 'missing',
            },
          ],
        });
        return;
      }

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'name'],
              msg: 'name is required and must be a non-empty string',
              type: 'missing',
            },
          ],
        });
        return;
      }

      const capability = await mcpBridgeService.registerCapability(
        projectId,
        agent_id,
        {
          name: name.trim(),
          description: description?.trim(),
          schema: schema || undefined,
        },
      );

      res.status(201).json({
        id: capability.id,
        project_id: capability.projectId,
        agent_id: capability.agentId,
        name: capability.name,
        description: capability.description,
        schema: capability.schema,
        created_at: capability.createdAt,
      });
    } catch (err) {
      console.error('Register MCP capability error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * GET /v1/projects/:pid/mcp/capabilities
 * List all MCP capabilities for a project.
 */
router.get(
  '/v1/projects/:pid/mcp/capabilities',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.pid;
      const capabilities = await mcpBridgeService.listCapabilities(projectId);

      res.json({
        data: capabilities.map((c) => ({
          id: c.id,
          project_id: c.projectId,
          agent_id: c.agentId,
          name: c.name,
          description: c.description,
          schema: c.schema,
          created_at: c.createdAt,
        })),
      });
    } catch (err) {
      console.error('List MCP capabilities error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * DELETE /v1/projects/:pid/mcp/capabilities/:cid
 * Remove a specific MCP capability.
 */
router.delete(
  '/v1/projects/:pid/mcp/capabilities/:cid',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.pid;
      const capabilityId = req.params.cid;

      const deleted = await mcpBridgeService.removeCapability(projectId, capabilityId);

      if (!deleted) {
        res.status(404).json({ detail: 'Capability not found' });
        return;
      }

      res.status(204).send();
    } catch (err) {
      console.error('Delete MCP capability error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
