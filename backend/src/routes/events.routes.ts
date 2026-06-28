import { Router, Request, Response } from 'express';
import { authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { AppDataSource } from '../data-source';
import { Session } from '../entities/session.entity';
import { SessionParticipant } from '../entities/session-participant.entity';
import { ProjectMember } from '../entities/project-member.entity';
import { eventStreamService } from '../services/event-stream.service';
import { eventRepository } from '../services/event-repository.service';
import crypto from 'crypto';

const router = Router();
const sessionRepo = AppDataSource.getRepository(Session);
const memberRepo = AppDataSource.getRepository(ProjectMember);
const participantRepo = AppDataSource.getRepository(SessionParticipant);

/**
 * GET /v1/sessions/:id/events
 * List persisted append-only events for a session.
 */
router.get(
  '/v1/sessions/:id/events',
  authenticateJwtOrAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id;
      const afterSeq = parseInt(req.query.after_seq as string, 10) || 0;
      const limit = parseInt(req.query.limit as string, 10) || 100;

      const session = await sessionRepo.findOne({ where: { id: sessionId } });
      if (!session) {
        res.status(404).json({ detail: 'Session not found' });
        return;
      }

      if (req.agent) {
        // Agent must be a participant in the session
        const participant = await participantRepo.findOne({
          where: { sessionId, agentId: req.agent.id },
        });
        if (!participant) {
          res.status(403).json({ detail: 'Agent is not a participant in this session' });
          return;
        }
      } else if (req.user) {
        const membership = await memberRepo.findOne({
          where: { projectId: session.projectId, userId: req.user.userId },
        });
        if (!membership) {
          res.status(403).json({ detail: 'Not a member of this project' });
          return;
        }
      } else {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const events = await eventRepository.listEventsAfterSeq(sessionId, afterSeq, limit);
      res.json({
        data: events.map((event) => eventStreamService.toEnvelope(event)),
      });
    } catch (err) {
      console.error('List session events error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * GET /v1/sessions/:id/stream
 * SSE Event Stream — subscribes to real-time events for a session.
 * Requires authentication. The user must be a member of the session's project.
 * Agent must be a participant in the session.
 */
router.get(
  '/v1/sessions/:id/stream',
  authenticateJwtOrAgentApiKey,
  async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id;
      const afterSeq = parseInt(req.query.after_seq as string, 10) || 0;

      // Look up session to verify it exists
      const session = await sessionRepo.findOne({
        where: { id: sessionId },
      });

      if (!session) {
        res.status(404).json({ detail: 'Session not found' });
        return;
      }

      if (req.agent) {
        // Agent must be a participant in the session
        const participant = await participantRepo.findOne({
          where: { sessionId, agentId: req.agent.id },
        });
        if (!participant) {
          res.status(403).json({ detail: 'Agent is not a participant in this session' });
          return;
        }
      } else if (req.user) {
        // Verify user is a member of the project
        const membership = await memberRepo.findOne({
          where: { projectId: session.projectId, userId: req.user.userId },
        });

        if (!membership) {
          res.status(403).json({ detail: 'Not a member of this project' });
          return;
        }
      } else {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const missedEvents = await eventRepository.listEventsAfterSeq(sessionId, afterSeq, 500);

      // Subscribe to event stream and replay persisted catch-up events.
      eventStreamService.subscribe(
        sessionId,
        res,
        afterSeq,
        missedEvents.map((event) => eventStreamService.toEnvelope(event)),
      );
    } catch (err) {
      console.error('SSE stream error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

/**
 * POST /v1/projects/:project_id/events
 * Receive webhook event delivery.
 * Events are signed with HMAC-SHA256.
 */
router.post(
  '/v1/projects/:project_id/events',
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const signature = req.headers['x-zz-signature'] as string;
      const timestamp = req.headers['x-zz-timestamp'] as string;

      if (!signature || !timestamp) {
        res.status(401).json({ detail: 'Missing signature headers' });
        return;
      }

      // Load webhook secret — fail closed in production for empty/developer defaults
      const rawSecret = process.env.WEBHOOK_SECRET || '';
      const isProduction = process.env.NODE_ENV === 'production';
      if (isProduction && (!rawSecret || rawSecret === 'dev-webhook-secret')) {
        console.error('Webhook rejected: WEBHOOK_SECRET is not set or is the dev default in production');
        res.status(500).json({ detail: 'Webhook misconfigured' });
        return;
      }
      const webhookSecret = rawSecret || 'dev-webhook-secret';

      // Normalize "sha256=<hex>" input
      const sigHex = signature.startsWith('sha256=')
        ? signature.slice(7)
        : signature;

      // Reject malformed signatures: must be 64 hex chars (SHA-256 = 32 bytes)
      if (!/^[a-fA-F0-9]{64}$/.test(sigHex)) {
        res.status(401).json({ detail: 'Invalid signature format' });
        return;
      }

      // Compute expected HMAC
      const bodyStr = JSON.stringify(req.body);
      const expectedBuf = crypto
        .createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${bodyStr}`)
        .digest();

      // Compare using timing-safe equality to prevent timing attacks
      const providedBuf = Buffer.from(sigHex, 'hex');
      if (
        providedBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        res.status(401).json({ detail: 'Invalid signature' });
        return;
      }

      const { event, payload } = req.body;

      if (!event || !payload) {
        res.status(422).json({
          detail: [
            {
              loc: ['body'],
              msg: 'event and payload are required',
              type: 'missing',
            },
          ],
        });
        return;
      }

      // Publish the event via event stream if it has a session context
      if (payload.session_id) {
        eventStreamService.publish(payload.session_id, {
          sessionId: payload.session_id,
          projectId,
          type: event,
          payload,
          traceId: req.headers['x-zz-trace-id'] as string || undefined,
        });
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Webhook event error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  }
);

export default router;
