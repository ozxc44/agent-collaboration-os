import { Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { AppDataSource } from '../data-source';
import { authenticate, authenticateJwtOrAgentApiKey, authenticateAgentApiKey } from '../middleware/auth';
import {
  CollaborationRequest,
  CollaborationRequestType,
  CollaborationRequestStatus,
  Project,
  ProjectMember,
  ProjectRole,
  ProjectJoinRequest,
  ProjectJoinRequestStatus,
  User,
  Agent,
} from '../entities';
import { createInboxItem } from './agent-inbox.routes';

const router = Router();

const collabRepo = () => AppDataSource.getRepository(CollaborationRequest);
const userRepo = () => AppDataSource.getRepository(User);
const projectRepo = () => AppDataSource.getRepository(Project);
const agentRepo = () => AppDataSource.getRepository(Agent);
const memberRepo = () => AppDataSource.getRepository(ProjectMember);
const joinReqRepo = () => AppDataSource.getRepository(ProjectJoinRequest);

function serializeCollaborationRequest(req: CollaborationRequest) {
  return {
    id: req.id,
    request_type: req.requestType,
    status: req.status,
    project_id: req.projectId ?? null,
    requested_by_user_id: req.requestedByUserId ?? null,
    target_user_id: req.targetUserId ?? null,
    target_agent_id: req.targetAgentId ?? null,
    requested_role: req.requestedRole ?? null,
    note: req.note ?? null,
    reviewed_by: req.reviewedBy ?? null,
    reviewed_at: req.reviewedAt ?? null,
    legacy_join_request_id: req.legacyJoinRequestId ?? null,
    created_at: req.createdAt,
    updated_at: req.updatedAt,
  };
}

// POST /v1/requests
router.post('/v1/requests', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { request_type, project_id, target_agent_id, target_user_id, requested_role, note } = req.body;

    if (!Object.values(CollaborationRequestType).includes(request_type)) {
      res.status(422).json({ detail: 'request_type must be project_join, project_invite, or owner_agent_bind' });
      return;
    }

    if (request_type === CollaborationRequestType.PROJECT_JOIN) {
      if (!project_id) {
        res.status(422).json({ detail: 'project_id is required for project_join requests' });
        return;
      }
      const project = await projectRepo().findOne({ where: { id: project_id } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }
      const existing = await memberRepo().findOne({ where: { projectId: project_id, userId } });
      if (existing) {
        res.status(409).json({ detail: 'Already a project member' });
        return;
      }
      const existingReq = await collabRepo().findOne({
        where: { projectId: project_id, requestedByUserId: userId, requestType: CollaborationRequestType.PROJECT_JOIN, status: In([CollaborationRequestStatus.PENDING_OWNER, CollaborationRequestStatus.PENDING_AGENT]) },
      });
      if (existingReq) {
        res.status(409).json(serializeCollaborationRequest(existingReq));
        return;
      }

      const role = requested_role === ProjectRole.VIEWER ? ProjectRole.VIEWER : ProjectRole.MEMBER;
      const request = collabRepo().create({
        requestType: CollaborationRequestType.PROJECT_JOIN,
        status: CollaborationRequestStatus.PENDING_OWNER,
        projectId: project_id,
        requestedByUserId: userId,
        targetUserId: project.ownerId,
        requestedRole: role,
        note: typeof note === 'string' ? note.slice(0, 1000) : null,
      });
      await collabRepo().save(request);

      // Notify project owner's bound agents
      try {
        const ownerAdmins = await memberRepo().find({
          where: { projectId: project_id, role: In([ProjectRole.OWNER, ProjectRole.ADMIN]) },
        });
        const userIds = new Set<string>(ownerAdmins.map(m => m.userId));
        userIds.add(project.ownerId);
        const users = await userRepo().find({ where: { id: In([...userIds]) } });
        const recipientAgentIds = new Set<string>();
        for (const u of users) {
          if (u.ownerAgentId) recipientAgentIds.add(u.ownerAgentId);
        }
        for (const recipientAgentId of recipientAgentIds) {
          await createInboxItem({
            projectId: project_id,
            recipientAgentId,
            eventType: 'collaboration_request_created',
            title: 'New collaboration request',
            body: `User requested to join project as ${role}.`,
            payload: { collaboration_request_id: request.id, request_type: 'project_join', project_id, user_id: userId },
          });
        }
      } catch (e) { /* ignore inbox failures */ }

      res.status(201).json(serializeCollaborationRequest(request));
      return;
    }

    if (request_type === CollaborationRequestType.OWNER_AGENT_BIND) {
      if (!target_agent_id) {
        res.status(422).json({ detail: 'target_agent_id is required for owner_agent_bind requests' });
        return;
      }
      const agent = await agentRepo().findOne({ where: { id: target_agent_id } });
      if (!agent) {
        res.status(404).json({ detail: 'Target agent not found' });
        return;
      }

      const request = collabRepo().create({
        requestType: CollaborationRequestType.OWNER_AGENT_BIND,
        status: CollaborationRequestStatus.PENDING_AGENT,
        projectId: agent.projectId,
        requestedByUserId: userId,
        targetAgentId: target_agent_id,
        targetUserId: userId,
        note: typeof note === 'string' ? note.slice(0, 1000) : null,
      });
      await collabRepo().save(request);

      // Notify the target agent via durable inbox
      try {
        await createInboxItem({
          projectId: agent.projectId,
          recipientAgentId: target_agent_id,
          eventType: 'owner_agent_bind_requested',
          title: 'Owner agent bind request',
          body: `User requested to bind you as their owner agent.`,
          payload: { collaboration_request_id: request.id, user_id: userId },
        });
      } catch (e) { /* ignore inbox failures */ }

      res.status(201).json(serializeCollaborationRequest(request));
      return;
    }

    if (request_type === CollaborationRequestType.PROJECT_INVITE) {
      if (!project_id || !target_user_id) {
        res.status(422).json({ detail: 'project_id and target_user_id are required for project_invite requests' });
        return;
      }
      const project = await projectRepo().findOne({ where: { id: project_id } });
      if (!project) {
        res.status(404).json({ detail: 'Project not found' });
        return;
      }
      // Only owner/admin can invite
      const membership = await memberRepo().findOne({ where: { projectId: project_id, userId } });
      if (!membership || (membership.role !== ProjectRole.OWNER && membership.role !== ProjectRole.ADMIN)) {
        res.status(403).json({ detail: 'Only project owner or admin can invite' });
        return;
      }
      const targetUser = await userRepo().findOne({ where: { id: target_user_id } });
      if (!targetUser) {
        res.status(404).json({ detail: 'Target user not found' });
        return;
      }
      const existingMember = await memberRepo().findOne({ where: { projectId: project_id, userId: target_user_id } });
      if (existingMember) {
        res.status(409).json({ detail: 'Target user is already a member' });
        return;
      }

      const role = requested_role === ProjectRole.ADMIN || requested_role === ProjectRole.VIEWER
        ? requested_role : ProjectRole.MEMBER;
      const request = collabRepo().create({
        requestType: CollaborationRequestType.PROJECT_INVITE,
        status: CollaborationRequestStatus.PENDING_OWNER,
        projectId: project_id,
        requestedByUserId: userId,
        targetUserId: target_user_id,
        requestedRole: role,
        note: typeof note === 'string' ? note.slice(0, 1000) : null,
      });
      await collabRepo().save(request);

      // Notify target user's bound agent
      try {
        if (targetUser.ownerAgentId) {
          await createInboxItem({
            projectId: project_id,
            recipientAgentId: targetUser.ownerAgentId,
            eventType: 'project_invite_created',
            title: 'Project invitation',
            body: `You have been invited to join a project as ${role}.`,
            payload: { collaboration_request_id: request.id, project_id, invited_by: userId },
          });
        }
      } catch (e) { /* ignore inbox failures */ }

      res.status(201).json(serializeCollaborationRequest(request));
      return;
    }

    res.status(422).json({ detail: 'Unsupported request_type' });
  } catch (err) {
    console.error('Create collaboration request error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// GET /v1/requests?scope=owner|project|agent&project_id=...&status=...
router.get('/v1/requests', authenticateJwtOrAgentApiKey, async (req: Request, res: Response) => {
  try {
    const qb = collabRepo().createQueryBuilder('cr');

    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'owner';

    if (req.agent) {
      // Agent-scoped: show requests targeting this agent
      qb.where('cr.targetAgentId = :agentId', { agentId: req.agent.id });
    } else if (req.user) {
      if (scope === 'project' && req.query.project_id) {
        qb.where('cr.projectId = :projectId', { projectId: req.query.project_id });
      } else {
        qb.where('cr.targetUserId = :userId OR cr.requestedByUserId = :userId', { userId: req.user.userId });
      }
    }

    if (req.query.status && typeof req.query.status === 'string') {
      const statuses = req.query.status.split(',').filter(s =>
        Object.values(CollaborationRequestStatus).includes(s as CollaborationRequestStatus)
      );
      if (statuses.length > 0) {
        qb.andWhere('cr.status IN (:...statuses)', { statuses });
      }
    }

    if (req.query.request_type && typeof req.query.request_type === 'string') {
      qb.andWhere('cr.requestType = :requestType', { requestType: req.query.request_type });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    qb.orderBy('cr.createdAt', 'DESC').take(limit);

    const requests = await qb.getMany();
    res.json({ data: requests.map(serializeCollaborationRequest) });
  } catch (err) {
    console.error('List collaboration requests error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// POST /v1/requests/:request_id/approve
router.post('/v1/requests/:request_id/approve', authenticateJwtOrAgentApiKey, async (req: Request, res: Response) => {
  try {
    const request = await collabRepo().findOne({ where: { id: req.params.request_id } });
    if (!request) {
      res.status(404).json({ detail: 'Request not found' });
      return;
    }

    const isTerminal = [CollaborationRequestStatus.APPROVED, CollaborationRequestStatus.REJECTED,
      CollaborationRequestStatus.CANCELLED, CollaborationRequestStatus.EXPIRED].includes(request.status);
    if (isTerminal) {
      res.status(409).json({ detail: `Request has already been ${request.status}` });
      return;
    }

    // Authorization check
    if (req.agent) {
      // Agent can only approve requests targeting them
      if (request.targetAgentId !== req.agent.id) {
        res.status(403).json({ detail: 'Not authorized to approve this request' });
        return;
      }
    } else if (req.user) {
      if (request.requestType === CollaborationRequestType.OWNER_AGENT_BIND) {
        // Agent-initiated bind (requestedByUserId is null, status PENDING_OWNER):
        // human target user can approve
        if (!request.requestedByUserId && request.targetUserId === req.user.userId) {
          // allowed — human approves agent-initiated binding
        } else {
          // Human-initiated bind: must be approved by the target agent
          res.status(403).json({ detail: 'Owner agent bind requests must be approved by the target agent' });
          return;
        }
      } else if (request.projectId) {
        const membership = await memberRepo().findOne({
          where: { projectId: request.projectId, userId: req.user.userId },
        });
        if (!membership || (membership.role !== ProjectRole.OWNER && membership.role !== ProjectRole.ADMIN)) {
          res.status(403).json({ detail: 'Only project owner or admin can approve' });
          return;
        }
      }
    }

    // Process approval
    if (request.requestType === CollaborationRequestType.OWNER_AGENT_BIND) {
      const agent = await agentRepo().findOne({ where: { id: request.targetAgentId! } });
      if (!agent) {
        res.status(404).json({ detail: 'Target agent no longer exists' });
        return;
      }
      // Agent-initiated: bind target user to this agent
      // Human-initiated: bind requesting user to this agent
      const userIdToBind = request.targetUserId ?? request.requestedByUserId;
      if (!userIdToBind) {
        res.status(422).json({ detail: 'Cannot determine user to bind' });
        return;
      }
      const user = await userRepo().findOne({ where: { id: userIdToBind } });
      if (!user) {
        res.status(404).json({ detail: 'User to bind no longer exists' });
        return;
      }
      user.ownerAgentId = request.targetAgentId!;
      await userRepo().save(user);
    }

    if (request.requestType === CollaborationRequestType.PROJECT_JOIN && request.projectId && request.requestedByUserId) {
      const existingMember = await memberRepo().findOne({
        where: { projectId: request.projectId, userId: request.requestedByUserId },
      });
      if (!existingMember) {
        await memberRepo().save(memberRepo().create({
          projectId: request.projectId,
          userId: request.requestedByUserId,
          role: request.requestedRole || ProjectRole.MEMBER,
        }));
      }
    }

    if (request.requestType === CollaborationRequestType.PROJECT_INVITE && request.projectId && request.targetUserId) {
      const existingMember = await memberRepo().findOne({
        where: { projectId: request.projectId, userId: request.targetUserId },
      });
      if (!existingMember) {
        await memberRepo().save(memberRepo().create({
          projectId: request.projectId,
          userId: request.targetUserId,
          role: request.requestedRole || ProjectRole.MEMBER,
        }));
      }
    }

    request.status = CollaborationRequestStatus.APPROVED;
    request.reviewedBy = req.user?.userId ?? req.agent?.id ?? null;
    request.reviewedAt = new Date();
    await collabRepo().save(request);

    // Back-sync legacy join request when this is a bridged collaboration request
    if (request.legacyJoinRequestId && request.requestType === CollaborationRequestType.PROJECT_JOIN) {
      try {
        const legacy = await joinReqRepo().findOne({ where: { id: request.legacyJoinRequestId } });
        if (legacy && legacy.status === ProjectJoinRequestStatus.PENDING) {
          legacy.status = ProjectJoinRequestStatus.APPROVED;
          legacy.reviewedBy = request.reviewedBy;
          legacy.reviewedAt = request.reviewedAt;
          await joinReqRepo().save(legacy);
        }
      } catch (e) { /* ignore back-sync failures */ }
    }

    // Notify requester / bound agent
    try {
      if (request.requestType === CollaborationRequestType.OWNER_AGENT_BIND && request.targetAgentId) {
        // Notify the agent of successful binding (covers both human-initiated and agent-initiated)
        const agent = await agentRepo().findOne({ where: { id: request.targetAgentId } });
        if (agent) {
          await createInboxItem({
            projectId: agent.projectId,
            recipientAgentId: request.targetAgentId,
            eventType: 'owner_agent_bound',
            title: 'Owner agent bind approved',
            body: `Your owner-agent bind request has been approved.`,
            payload: { collaboration_request_id: request.id, user_id: request.targetUserId ?? request.requestedByUserId },
          });
        }
      } else if (request.requestedByUserId && request.projectId) {
        const requester = await userRepo().findOne({ where: { id: request.requestedByUserId } });
        if (requester?.ownerAgentId) {
          await createInboxItem({
            projectId: request.projectId,
            recipientAgentId: requester.ownerAgentId,
            eventType: 'collaboration_request_approved',
            title: 'Request approved',
            body: `Your ${request.requestType} request has been approved.`,
            payload: { collaboration_request_id: request.id, request_type: request.requestType },
          });
        }
      }
    } catch (e) { /* ignore */ }

    res.json(serializeCollaborationRequest(request));
  } catch (err) {
    console.error('Approve collaboration request error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// POST /v1/requests/:request_id/reject
router.post('/v1/requests/:request_id/reject', authenticateJwtOrAgentApiKey, async (req: Request, res: Response) => {
  try {
    const request = await collabRepo().findOne({ where: { id: req.params.request_id } });
    if (!request) {
      res.status(404).json({ detail: 'Request not found' });
      return;
    }

    const isTerminal = [CollaborationRequestStatus.APPROVED, CollaborationRequestStatus.REJECTED,
      CollaborationRequestStatus.CANCELLED, CollaborationRequestStatus.EXPIRED].includes(request.status);
    if (isTerminal) {
      res.status(409).json({ detail: `Request has already been ${request.status}` });
      return;
    }

    // Authorization
    if (req.agent) {
      if (request.targetAgentId !== req.agent.id) {
        res.status(403).json({ detail: 'Not authorized to reject this request' });
        return;
      }
    } else if (req.user) {
      if (request.requestType === CollaborationRequestType.OWNER_AGENT_BIND) {
        // Agent-initiated bind: human target user can reject
        if (!request.requestedByUserId && request.targetUserId === req.user.userId) {
          // allowed — human rejects agent-initiated binding
        } else {
          res.status(403).json({ detail: 'Owner agent bind requests must be rejected by the target agent' });
          return;
        }
      } else if (request.projectId) {
        const membership = await memberRepo().findOne({
          where: { projectId: request.projectId, userId: req.user.userId },
        });
        if (!membership || (membership.role !== ProjectRole.OWNER && membership.role !== ProjectRole.ADMIN)) {
          res.status(403).json({ detail: 'Only project owner or admin can reject' });
          return;
        }
      }
    }

    request.status = CollaborationRequestStatus.REJECTED;
    request.reviewedBy = req.user?.userId ?? req.agent?.id ?? null;
    request.reviewedAt = new Date();
    await collabRepo().save(request);

    // Back-sync legacy join request when this is a bridged collaboration request
    if (request.legacyJoinRequestId && request.requestType === CollaborationRequestType.PROJECT_JOIN) {
      try {
        const legacy = await joinReqRepo().findOne({ where: { id: request.legacyJoinRequestId } });
        if (legacy && legacy.status === ProjectJoinRequestStatus.PENDING) {
          legacy.status = ProjectJoinRequestStatus.REJECTED;
          legacy.reviewedBy = request.reviewedBy;
          legacy.reviewedAt = request.reviewedAt;
          await joinReqRepo().save(legacy);
        }
      } catch (e) { /* ignore back-sync failures */ }
    }

    // Notify requester
    try {
      if (request.requestedByUserId && request.projectId) {
        const requester = await userRepo().findOne({ where: { id: request.requestedByUserId } });
        if (requester?.ownerAgentId) {
          await createInboxItem({
            projectId: request.projectId,
            recipientAgentId: requester.ownerAgentId,
            eventType: 'collaboration_request_rejected',
            title: 'Request rejected',
            body: `Your ${request.requestType} request has been rejected.`,
            payload: { collaboration_request_id: request.id, request_type: request.requestType },
          });
        }
      }
    } catch (e) { /* ignore */ }

    res.json(serializeCollaborationRequest(request));
  } catch (err) {
    console.error('Reject collaboration request error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// POST /v1/requests/:request_id/cancel
router.post('/v1/requests/:request_id/cancel', authenticate, async (req: Request, res: Response) => {
  try {
    const request = await collabRepo().findOne({ where: { id: req.params.request_id } });
    if (!request) {
      res.status(404).json({ detail: 'Request not found' });
      return;
    }

    const isTerminal = [CollaborationRequestStatus.APPROVED, CollaborationRequestStatus.REJECTED,
      CollaborationRequestStatus.CANCELLED, CollaborationRequestStatus.EXPIRED].includes(request.status);
    if (isTerminal) {
      res.status(409).json({ detail: `Request has already been ${request.status}` });
      return;
    }

    // Only the requester can cancel
    if (request.requestedByUserId !== req.user!.userId) {
      res.status(403).json({ detail: 'Only the requester can cancel' });
      return;
    }

    request.status = CollaborationRequestStatus.CANCELLED;
    await collabRepo().save(request);

    res.json(serializeCollaborationRequest(request));
  } catch (err) {
    console.error('Cancel collaboration request error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

// POST /v1/agent/request-owner-bind
// Agent-initiated binding: agent requests to become a target user's owner agent.
// No secrets required — agent identifies the human by email or user_id.
router.post('/v1/agent/request-owner-bind', authenticateAgentApiKey, async (req: Request, res: Response) => {
  try {
    const agentId = req.agent!.id;
    const { target_user_email, target_user_id } = req.body;

    // Look up target user by email or ID
    let targetUser: User | null = null;
    if (target_user_email && typeof target_user_email === 'string') {
      targetUser = await userRepo().findOne({ where: { email: target_user_email.trim() } });
    } else if (target_user_id && typeof target_user_id === 'string') {
      targetUser = await userRepo().findOne({ where: { id: target_user_id } });
    }

    if (!targetUser) {
      res.status(404).json({ detail: 'Target user not found. Provide target_user_email or target_user_id.' });
      return;
    }

    // Check if user already has this agent bound
    if (targetUser.ownerAgentId === agentId) {
      res.status(409).json({ detail: 'You are already bound as this user\'s owner agent' });
      return;
    }

    // Check for existing pending request from this agent to this user
    const existingReq = await collabRepo().findOne({
      where: {
        requestType: CollaborationRequestType.OWNER_AGENT_BIND,
        targetAgentId: agentId,
        targetUserId: targetUser.id,
        status: In([CollaborationRequestStatus.PENDING_OWNER, CollaborationRequestStatus.PENDING_AGENT]),
      },
    });
    if (existingReq) {
      res.status(409).json(serializeCollaborationRequest(existingReq));
      return;
    }

    const agent = await agentRepo().findOne({ where: { id: agentId } });

    const request = collabRepo().create({
      requestType: CollaborationRequestType.OWNER_AGENT_BIND,
      status: CollaborationRequestStatus.PENDING_OWNER,
      projectId: agent?.projectId ?? null,
      requestedByUserId: null, // agent-initiated
      targetAgentId: agentId,
      targetUserId: targetUser.id,
      note: null,
    });
    await collabRepo().save(request);

    // Notify the target user's existing bound agent (if any) about the pending request
    try {
      if (targetUser.ownerAgentId && targetUser.ownerAgentId !== agentId) {
        await createInboxItem({
          projectId: agent?.projectId ?? targetUser.ownerAgentId,
          recipientAgentId: targetUser.ownerAgentId,
          eventType: 'owner_agent_bind_requested',
          title: 'Owner agent bind request received',
          body: `Agent ${agent?.name ?? agentId} requested to become the owner agent for user ${targetUser.displayName ?? targetUser.email}.`,
          payload: { collaboration_request_id: request.id, agent_id: agentId, user_id: targetUser.id },
        });
      }
    } catch (e) { /* ignore inbox failures */ }

    res.status(201).json(serializeCollaborationRequest(request));
  } catch (err) {
    console.error('Agent request owner bind error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

export default router;

/**
 * Bridge helper: create a collaboration_request linked to an existing ProjectJoinRequest.
 * Used by the old join-request endpoints for double-write.
 */
export async function bridgeJoinRequestToCollab(input: {
  joinRequestId: string;
  projectId: string;
  userId: string;
  projectOwnerId: string;
  requestedRole: ProjectRole;
  note?: string | null;
}): Promise<CollaborationRequest> {
  const existing = await collabRepo().findOne({
    where: { legacyJoinRequestId: input.joinRequestId },
  });
  if (existing) return existing;

  const request = collabRepo().create({
    requestType: CollaborationRequestType.PROJECT_JOIN,
    status: CollaborationRequestStatus.PENDING_OWNER,
    projectId: input.projectId,
    requestedByUserId: input.userId,
    targetUserId: input.projectOwnerId,
    requestedRole: input.requestedRole,
    note: input.note ?? null,
    legacyJoinRequestId: input.joinRequestId,
  });
  return collabRepo().save(request);
}

/**
 * Bridge helper: sync review status from old join-request to collaboration_request.
 */
export async function bridgeJoinRequestReview(
  legacyJoinRequestId: string,
  status: 'approved' | 'rejected',
  reviewedBy: string,
): Promise<void> {
  const request = await collabRepo().findOne({
    where: { legacyJoinRequestId },
  });
  if (!request) return;

  request.status = status === 'approved' ? CollaborationRequestStatus.APPROVED : CollaborationRequestStatus.REJECTED;
  request.reviewedBy = reviewedBy;
  request.reviewedAt = new Date();
  await collabRepo().save(request);
}
