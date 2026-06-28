import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { authService, AuthServiceError } from '../services/auth.service';
import { AppDataSource } from '../data-source';
import {
  ProjectJoinRequest,
  ProjectJoinRequestStatus,
} from '../entities';

const router = Router();

/**
 * POST /v1/auth/register
 * Register a new user.
 * No authentication required.
 */
router.post('/v1/auth/register', async (req: Request, res: Response) => {
  try {
    const { email, password, display_name, username } = req.body;

    if (!email || !password) {
      res.status(422).json({
        detail: [
          {
            loc: ['body', !email ? 'email' : 'password'],
            msg: !email ? 'Email is required' : 'Password is required',
            type: 'missing',
          },
        ],
      });
      return;
    }

    const result = await authService.register(
      email,
      password,
      display_name || email.split('@')[0],
      username,
    );
    res.status(201).json({
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_at: result.expiresAt,
      user: {
        id: result.user.id,
        username: result.user.username || result.user.email,
        display_name: result.user.displayName,
        owner_agent_id: result.user.ownerAgentId ?? null,
        created_at: result.user.createdAt,
      },
    });
  } catch (err) {
    if (err instanceof AuthServiceError) {
      res.status(err.statusCode).json({ detail: err.message });
      return;
    }
    console.error('Auth register error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * POST /v1/auth/token
 * Login with email or username and password to get a JWT token.
 * No authentication required.
 */
router.post('/v1/auth/token', async (req: Request, res: Response) => {
  try {
    const { email, username, password } = req.body;
    const identifier = email || username;

    if (!identifier || !password) {
      res.status(422).json({
        detail: [
          {
            loc: ['body', !identifier ? 'email' : 'password'],
            msg: !identifier ? 'Email or username is required' : 'Password is required',
            type: 'missing',
          },
        ],
      });
      return;
    }

    const result = await authService.login(identifier, password);
    res.json({
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_at: result.expiresAt,
      user: {
        id: result.user.id,
        username: result.user.username || result.user.email,
        display_name: result.user.displayName,
        owner_agent_id: result.user.ownerAgentId ?? null,
        created_at: result.user.createdAt,
      },
    });
  } catch (err) {
    if (err instanceof AuthServiceError) {
      res.status(err.statusCode).json({ detail: err.message });
      return;
    }
    console.error('Auth token error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * GET /v1/auth/me
 * Get the currently authenticated user's information.
 * Requires authentication.
 */
router.get('/v1/auth/me', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const user = await authService.getMe(userId);

    res.json({
      id: user.id,
      username: user.username || user.email,
      display_name: user.displayName,
      owner_agent_id: user.ownerAgentId ?? null,
      created_at: user.createdAt,
    });
  } catch (err) {
    if (err instanceof AuthServiceError) {
      res.status(err.statusCode).json({ detail: err.message });
      return;
    }
    console.error('Auth me error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

/**
 * GET /v1/me/join-requests
 * Self-service: list the caller's own project join-requests (any status).
 *
 * Lets an applicant track their own pending request WITHOUT project membership —
 * the project-scoped `GET /v1/projects/:id/join-requests` requires ManageMembers,
 * which an applicant never has, so this is the only way for them to see their own
 * approval status instead of asking the owner.
 */
router.get('/v1/me/join-requests', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const status = typeof req.query.status === 'string' ? (req.query.status as string) : undefined;
    const where: Record<string, unknown> = { userId };
    if (status && Object.values(ProjectJoinRequestStatus).includes(status as ProjectJoinRequestStatus)) {
      where.status = status;
    }
    const requests = await AppDataSource.getRepository(ProjectJoinRequest).find({
      where,
      relations: ['project'],
      order: { createdAt: 'DESC' },
    });
    res.json({
      data: requests.map((r) => ({
        id: r.id,
        project_id: r.projectId,
        project_name: (r as ProjectJoinRequest & { project?: { name?: string } }).project?.name ?? null,
        status: r.status,
        requested_role: r.requestedRole,
        note: r.note ?? null,
        reviewed_by: r.reviewedBy ?? null,
        reviewed_at: r.reviewedAt ?? null,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
    });
  } catch (err) {
    console.error('List my join requests error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

export default router;
