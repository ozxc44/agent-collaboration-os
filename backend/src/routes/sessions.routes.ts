import { NextFunction, Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { authenticate, authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { Session, SessionStatus, SessionParticipant } from '../entities';
import { MessageVisibility } from '../entities/message.entity';
import {
  findAgentsForSession,
  findSessionById,
  listSessionMessages,
  loadParticipants,
  serializeMessage,
  serializeSession,
  SessionDispatchService,
} from '../services/session-dispatch.service';

const router = Router();
const sessionRepo = AppDataSource.getRepository(Session);
const participantRepo = AppDataSource.getRepository(SessionParticipant);
const dispatchService = new SessionDispatchService();

async function attachProjectFromSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.params.sid;
    const session = await findSessionById(sessionId);
    if (!session) {
      res.status(404).json({ detail: 'Session not found' });
      return;
    }

    (req as any).projectId = session.projectId;
    (req as any).session = session;
    next();
  } catch (err) {
    console.error('Load session project error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
}

router.get(
  '/v1/projects/:project_id/sessions',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.ViewSession),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const status = req.query.status as string | undefined;

      const where: Record<string, unknown> = { projectId };
      if (status) where.status = status;
      if (req.agent) {
        const participations = await participantRepo.find({
          where: { agentId: req.agent.id },
        });
        const sessionIds = participations.map((participant) => participant.sessionId);
        if (sessionIds.length === 0) {
          res.json({ data: [], meta: { total: 0, skip, limit } });
          return;
        }
        where.id = In(sessionIds);
      }

      const [sessions, total] = await sessionRepo.findAndCount({
        where,
        skip,
        take: Math.min(limit, 100),
        order: { updatedAt: 'DESC' },
      });

      const data = await Promise.all(
        sessions.map(async (session) => serializeSession(session, await loadParticipants(session.id))),
      );

      res.json({ data, meta: { total, skip, limit } });
    } catch (err) {
      console.error('List sessions error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/sessions',
  authenticate,
  extractProjectId,
  requirePermission(Permission.CreateSession),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const projectId = req.params.project_id;
      const agentIds = normalizeAgentIds(req.body.agent_ids ?? req.body.participant_agent_ids);

      if (agentIds.length === 0) {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'agent_ids'],
              msg: 'At least one agent_id is required',
              type: 'missing',
            },
          ],
        });
        return;
      }

      const agents = await findAgentsForSession(projectId, agentIds);
      if (agents.length !== new Set(agentIds).size) {
        res.status(404).json({ detail: 'One or more agents were not found in this project' });
        return;
      }

      const session = await AppDataSource.transaction(async (manager) => {
        const createdSession = manager.create(Session, {
          projectId,
          title: typeof req.body.title === 'string' ? req.body.title : null,
          status: SessionStatus.ACTIVE,
          createdBy: userId,
        });
        await manager.save(Session, createdSession);

        for (const agentId of agentIds) {
          await manager.save(
            SessionParticipant,
            manager.create(SessionParticipant, {
              sessionId: createdSession.id,
              agentId,
            }),
          );
        }

        return createdSession;
      });

      res.status(201).json({
        ...serializeSession(session, await loadParticipants(session.id)),
        mode: req.body.mode || 'shared',
      });
    } catch (err) {
      console.error('Create session error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  ['/v1/projects/:project_id/sessions/:sid', '/v1/sessions/:sid'],
  authenticateJwtOrAgentApiKey,
  projectScopeForSession,
  requirePermission(Permission.ViewSession),
  async (req: Request, res: Response) => {
    try {
      const session = await getScopedSession(req);
      if (!session) {
        res.status(404).json({ detail: 'Session not found' });
        return;
      }
      if (!await ensureAgentParticipant(req, res, session.id)) return;

      const participants = await loadParticipants(session.id);
      const messages = await listSessionMessages(session.id);
      res.json({
        ...serializeSession(session, participants),
        messages: messages.map(serializeMessage),
      });
    } catch (err) {
      console.error('Get session error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  ['/v1/projects/:project_id/sessions/:sid', '/v1/sessions/:sid'],
  authenticate,
  projectScopeForSession,
  requirePermission(Permission.ViewSession),
  async (req: Request, res: Response) => {
    try {
      const session = await getScopedSession(req);
      if (!session) {
        res.status(404).json({ detail: 'Session not found' });
        return;
      }
      const { title, status, version } = req.body;

      if (version !== undefined && Number(version) !== session.version) {
        res.status(409).json({ detail: 'Session version conflict' });
        return;
      }

      if (title !== undefined) session.title = typeof title === 'string' ? title : session.title;
      if (status !== undefined) {
        if (!Object.values(SessionStatus).includes(status)) {
          res.status(422).json({ detail: 'Invalid session status' });
          return;
        }
        session.status = status;
      }

      await sessionRepo.save(session);
      res.json(serializeSession(session, await loadParticipants(session.id)));
    } catch (err) {
      console.error('Update session error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  ['/v1/projects/:project_id/sessions/:sid/messages', '/v1/sessions/:sid/messages'],
  authenticateJwtOrAgentApiKey,
  projectScopeForSession,
  requirePermission(Permission.ViewSession),
  async (req: Request, res: Response) => {
    try {
      if (!await ensureAgentParticipant(req, res, req.params.sid)) return;
      const messages = await listSessionMessages(req.params.sid);
      res.json({ data: messages.map(serializeMessage) });
    } catch (err) {
      console.error('List messages error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  ['/v1/projects/:project_id/sessions/:sid/messages', '/v1/sessions/:sid/messages'],
  authenticateJwtOrAgentApiKey,
  projectScopeForSession,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      const session = await getScopedSession(req);
      if (!session) {
        res.status(404).json({ detail: 'Session not found' });
        return;
      }

      const content = req.body.content;
      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        res.status(422).json({
          detail: [
            {
              loc: ['body', 'content'],
              msg: 'Content is required',
              type: 'missing',
            },
          ],
        });
        return;
      }

      // Agent path: verify participant + self-sender + clamp dispatch_ttl
      if (req.agent) {
        const participant = await participantRepo.findOne({
          where: { sessionId: session.id, agentId: req.agent.id },
        });
        if (!participant) {
          res.status(403).json({ detail: 'Agent is not a participant in this session' });
          return;
        }

        // Sender ref must match the agent itself
        const senderRef = req.body.sender_ref || req.body.agent_id;
        if (senderRef && senderRef !== req.agent.id) {
          res.status(403).json({ detail: 'Cannot send as another agent' });
          return;
        }

        // Clamp dispatch_ttl to 1 for agent messages
        const dispatchTtl = 1;

        const message = await dispatchService.createUserMessage({
          projectId: session.projectId,
          sessionId: session.id,
          userId: req.agent.id, // Use agent ID as the sender
          content,
          contentType: req.body.content_type,
          recipientParticipantIds: req.body.recipient_participant_ids,
          visibility: normalizeVisibility(req.body.visibility),
          dispatchTtl,
          idempotencyKey: req.body.idempotency_key,
          parentMessageId: req.body.parent_message_id,
        });

        res.status(201).json(serializeMessage(message));
        return;
      }

      // JWT user path
      const userId = req.user!.userId;
      const message = await dispatchService.createUserMessage({
        projectId: session.projectId,
        sessionId: session.id,
        userId,
        content,
        contentType: req.body.content_type,
        recipientParticipantIds: req.body.recipient_participant_ids,
        visibility: normalizeVisibility(req.body.visibility),
        dispatchTtl: req.body.dispatch_ttl,
        idempotencyKey: req.body.idempotency_key,
        parentMessageId: req.body.parent_message_id,
      });

      res.status(201).json(serializeMessage(message));
    } catch (err) {
      console.error('Create message error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

async function projectScopeForSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.params.project_id) {
    extractProjectId(req, res, next);
    return;
  }

  await attachProjectFromSession(req, res, next);
}

async function getScopedSession(req: Request): Promise<Session | null> {
  if ((req as any).session) {
    return (req as any).session as Session;
  }

  const projectId = req.params.project_id || (req as any).projectId;
  return findSessionById(req.params.sid, projectId);
}

async function ensureAgentParticipant(req: Request, res: Response, sessionId: string): Promise<boolean> {
  if (!req.agent) return true;
  const participant = await participantRepo.findOne({
    where: { sessionId, agentId: req.agent.id },
  });
  if (!participant) {
    res.status(403).json({ detail: 'Agent is not a participant in this session' });
    return false;
  }
  return true;
}

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function normalizeVisibility(value: unknown): MessageVisibility {
  return value === MessageVisibility.DIRECT || value === 'direct'
    ? MessageVisibility.DIRECT
    : MessageVisibility.SESSION;
}

export default router;
