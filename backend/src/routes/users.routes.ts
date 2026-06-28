import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { AppDataSource } from '../data-source';
import { User } from '../entities/user.entity';
import { Agent, AgentStatus, AgentLifecycleStatus } from '../entities/agent.entity';
import { ProjectMember, ProjectRole } from '../entities/project-member.entity';
import { getAgentPresence } from '../services/agent-presence.service';
import { createInboxItem } from './agent-inbox.routes';

const router = Router();
const userRepo = AppDataSource.getRepository(User);
const agentRepo = AppDataSource.getRepository(Agent);
const projectMemberRepo = AppDataSource.getRepository(ProjectMember);

/**
 * GET /v1/users/search?q=...&limit=...
 * Search registered users by email or display_name.
 * Requires authentication.
 * Returns minimal safe fields: id, email, display_name, created_at.
 */
router.get('/v1/users/search', authenticate, async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string)?.trim();
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    if (!q || q.length < 2) {
      res.status(422).json({
        detail: [
          {
            loc: ['query', 'q'],
            msg: 'Query parameter q is required and must be at least 2 characters',
            type: 'too_short',
          },
        ],
      });
      return;
    }

    const users = await userRepo
      .createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.displayName', 'user.createdAt'])
      .where(
        '(LOWER(user.displayName) LIKE LOWER(:q) OR LOWER(user.email) LIKE LOWER(:q))',
        { q: `%${q}%` }
      )
      .take(limit)
      .getMany();

    res.json({
      data: users.map((u) => ({
        id: u.id,
        email: u.email,
        display_name: u.displayName,
        created_at: u.createdAt,
      })),
    });
  } catch (err) {
    console.error('User search error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

function serializeAgentSafe(agent: Agent) {
  const config = (agent.configJson || {}) as Record<string, unknown>;
  const presence = getAgentPresence(agent);
  const identityCode = agent.identityCode ?? agent.apiKeyPrefix ?? null;
  const displayLabel = identityCode
    ? `${agent.name} [${identityCode}]`
    : agent.name;
  return {
    id: agent.id,
    project_id: agent.projectId,
    name: agent.name,
    identity_code: identityCode,
    display_label: displayLabel,
    lifecycle_status: agent.lifecycleStatus ?? AgentLifecycleStatus.ACTIVE,
    owner_user_id: agent.ownerUserId ?? null,
    superseded_by_agent_id: agent.supersededByAgentId ?? null,
    retired_at: agent.retiredAt ?? null,
    description: agent.description ?? null,
    system_prompt: typeof config.system_prompt === 'string' ? config.system_prompt : '',
    endpoint_url: typeof config.endpoint_url === 'string' ? config.endpoint_url : null,
    status: agent.status,
    presence: presence.presence,
    health_status: presence.healthStatus,
    is_online: presence.isOnline,
    dispatchable: presence.dispatchable,
    last_heartbeat_at: presence.lastHeartbeatAt,
    heartbeat_age_ms: presence.heartbeatAgeMs,
    api_key_prefix:
      agent.apiKeyPrefix
      ?? (typeof config.api_key_prefix === 'string' ? config.api_key_prefix : null)
      ?? (agent.apiKeyHash ? agent.apiKeyHash.substring(0, 8) : null),
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}

/**
 * GET /v1/users/me/owner-agent
 * Return the bound agent with recovery-friendly fields.
 * Never returns the API key.
 */
router.get('/v1/users/me/owner-agent', authenticate, async (req: Request, res: Response) => {
  try {
    const user = await userRepo.findOne({ where: { id: req.user!.userId } });
    if (!user?.ownerAgentId) {
      res.status(404).json({ detail: 'No owner agent bound' });
      return;
    }

    const agent = await agentRepo.findOne({ where: { id: user.ownerAgentId } });
    if (!agent || agent.status === AgentStatus.INACTIVE) {
      res.status(404).json({ detail: 'Bound agent not found' });
      return;
    }

    res.json(serializeAgentSafe(agent));
  } catch (err) {
    console.error('Get owner agent error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * PATCH /v1/users/me/owner-agent
 * Bind or unbind an agent. agent_id = null clears the binding.
 */
router.patch('/v1/users/me/owner-agent', authenticate, async (req: Request, res: Response) => {
  try {
    const { agent_id } = req.body;
    const user = await userRepo.findOne({ where: { id: req.user!.userId } });
    if (!user) {
      res.status(404).json({ detail: 'User not found' });
      return;
    }

    if (agent_id === null || agent_id === undefined) {
      const previousAgentId = user.ownerAgentId;
      user.ownerAgentId = null;
      await userRepo.save(user);

      // Notify previously bound agent of unbind (before response, but non-fatal)
      if (previousAgentId) {
        const previousAgent = await agentRepo.findOne({ where: { id: previousAgentId } });
        if (previousAgent) {
          try {
            await createInboxItem({
              projectId: previousAgent.projectId,
              recipientAgentId: previousAgentId,
              eventType: 'owner_agent_unbound',
              title: 'Owner agent unbound',
              body: `Your binding to user ${user.displayName ?? user.email} has been cleared.`,
              payload: { user_id: user.id },
            });
          } catch (e) {
            // ignore inbox failures
          }
        }
      }

      res.json({ owner_agent_id: null });
      return;
    }

    // Validate agent exists and user is creator OR has non-viewer project membership
    const agent = await agentRepo.findOne({ where: { id: agent_id } });
    if (!agent) {
      res.status(404).json({ detail: 'Agent not found' });
      return;
    }

    const membership = await projectMemberRepo.findOne({
      where: { projectId: agent.projectId, userId: req.user!.userId },
    });
    const canEdit = membership && membership.role !== ProjectRole.VIEWER;
    const isCreator = agent.createdBy === req.user!.userId;
    if (!canEdit && !isCreator) {
      res.status(403).json({ detail: 'You do not have permission to bind this agent' });
      return;
    }

    user.ownerAgentId = agent_id;
    await userRepo.save(user);

    // Notify bound agent (before response, but non-fatal)
    try {
      await createInboxItem({
        projectId: agent.projectId,
        recipientAgentId: agent_id,
        eventType: 'owner_agent_bound',
        title: 'Owner agent bound',
        body: `You have been bound as the owner agent for user ${user.displayName ?? user.email}.`,
        payload: { user_id: user.id },
      });
    } catch (e) {
      // ignore inbox failures
    }

    res.json({ owner_agent_id: agent_id });
  } catch (err) {
    console.error('Patch owner agent error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

export default router;
