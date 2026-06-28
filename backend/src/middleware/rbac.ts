import { Request, Response, NextFunction } from 'express';
import { ProjectRole } from '../entities/project-member.entity';
import { AppDataSource } from '../data-source';
import { ProjectMember } from '../entities/project-member.entity';
import { Agent } from '../entities/agent.entity';

// ─── Enums ───────────────────────────────────────────────────────────────────

export enum Permission {
  ViewProject = 'ViewProject',
  EditProject = 'EditProject',
  DeleteProject = 'DeleteProject',
  ManageMembers = 'ManageMembers',
  CreateAgent = 'CreateAgent',
  EditAgent = 'EditAgent',
  CreateSession = 'CreateSession',
  SendMessage = 'SendMessage',
  ViewSession = 'ViewSession',
  ViewHealth = 'ViewHealth',
}

export enum Role {
  Owner = 'owner',
  Admin = 'admin',
  Member = 'member',
  Viewer = 'viewer',
  Agent = 'agent',
}

// ─── Permission Matrix ──────────────────────────────────────────────────────
// Maps each role to the set of permissions it grants.
// Based on plan-v2.md permission matrix.

export const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  [Role.Owner]: new Set([
    Permission.ViewProject,
    Permission.EditProject,
    Permission.DeleteProject,
    Permission.ManageMembers,
    Permission.CreateAgent,
    Permission.EditAgent,
    Permission.CreateSession,
    Permission.SendMessage,
    Permission.ViewSession,
    Permission.ViewHealth,
  ]),
  [Role.Admin]: new Set([
    Permission.ViewProject,
    Permission.EditProject,
    Permission.ManageMembers,
    Permission.CreateAgent,
    Permission.EditAgent,
    Permission.CreateSession,
    Permission.SendMessage,
    Permission.ViewSession,
    Permission.ViewHealth,
  ]),
  [Role.Member]: new Set([
    Permission.ViewProject,
    Permission.CreateAgent,
    Permission.CreateSession,
    Permission.SendMessage,
    Permission.ViewSession,
    Permission.ViewHealth,
  ]),
  [Role.Viewer]: new Set([
    Permission.ViewProject,
    Permission.ViewSession,
    Permission.ViewHealth,
  ]),
  [Role.Agent]: new Set([
    Permission.ViewProject,
    Permission.ViewSession,
    Permission.SendMessage,
    Permission.ViewHealth,
  ]),
};

// ─── Agent-scoped permissions ───────────────────────────────────────────────
// Permissions that agent API keys are allowed to request.
// Agents CANNOT: EditProject, DeleteProject, ManageMembers, CreateAgent, EditAgent, CreateSession.
const AGENT_ALLOWED_PERMISSIONS = new Set([
  Permission.ViewProject,
  Permission.ViewSession,
  Permission.SendMessage,
  Permission.ViewHealth,
]);

/**
 * Map a ProjectRole (DB enum) to a Role (RBAC enum).
 */
function toRole(projectRole: ProjectRole): Role {
  switch (projectRole) {
    case ProjectRole.OWNER:
      return Role.Owner;
    case ProjectRole.ADMIN:
      return Role.Admin;
    case ProjectRole.MEMBER:
      return Role.Member;
    case ProjectRole.VIEWER:
      return Role.Viewer;
  }
}

/**
 * Allow the request through if the authenticated JWT user owns the target agent.
 *
 * Why this exists: `requirePermission(Permission.EditAgent)` gates on project
 * membership, so a user who registered an agent but whose join-request is still
 * pending (not yet a member) is locked out of rotate-key/revoke-key. That makes
 * the api_key unrecoverable — it is only returned once at creation — and forces
 * users to register a second agent, leaving orphan agents behind.
 *
 * This recovery-oriented guard lets the agent's owner (`owner_user_id`, falling
 * back to `created_by`) manage that agent's key even without project membership.
 * Use it IN ADDITION to (before) `requirePermission(Permission.EditAgent)` on
 * key-recovery routes so full members still work via the normal RBAC path.
 *
 * Required: the route must be authenticated (JWT) and carry `:aid` / `:agent_id`.
 * On success it sets `req.projectRole` to a synthetic `Owner`-equivalent role.
 */
export function requireAgentOwnerOrPermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const agentId = req.params.aid || req.params.agent_id;
      const userId = req.user?.userId;

      // Agent API keys cannot rotate/revoke keys (no agent identity here is expected
      // for these routes, but be explicit and safe).
      if (req.agent) {
        res.status(403).json({ detail: 'Agent API key cannot perform key management' });
        return;
      }
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }
      if (!agentId) {
        res.status(400).json({ detail: 'Agent ID required' });
        return;
      }

      const agentRepo = AppDataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agentId } });
      if (!agent) {
        res.status(404).json({ detail: 'Agent not found' });
        return;
      }

      // Owner recovery path: caller owns this agent.
      if (agent.ownerUserId === userId || agent.createdBy === userId) {
        (req as any).projectRole = Role.Owner;
        next();
        return;
      }

      // Otherwise fall back to the normal permission check (full members/admins).
      return requirePermission(permission)(req, res, next);
    } catch (error) {
      console.error('Agent-owner RBAC error:', error);
      res.status(500).json({ detail: 'Internal authorization error' });
    }
  };
}

/**
 * Require a specific permission to access the route.
 *
 * Usage:
 *   router.get('/v1/projects/:project_id', authenticate, requirePermission(Permission.ViewProject), handler);
 *
 * This middleware:
 * 1. Extracts user_id from the authenticated request (req.user)
 * 2. Extracts project_id from request params
 * 3. Looks up the user's role in the project via ProjectMember
 * 4. Checks the permission matrix for the role
 *
 * Special logic for EditAgent:
 * - Owner and Admin can edit any agent in the project
 * - Member can only edit agents they created (created_by === user_id)
 */
export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const projectId = req.params.project_id || req.params.pid || (req as any).projectId;

      // ── Agent API key path ──────────────────────────────────────────────
      if (req.agent) {
        if (!AGENT_ALLOWED_PERMISSIONS.has(permission)) {
          res.status(403).json({ detail: `Agent API key cannot use permission: ${permission}` });
          return;
        }

        // Agent is scoped to its own project — verify it matches the request
        if (projectId && req.agent.projectId !== projectId) {
          res.status(403).json({ detail: 'Agent does not belong to this project' });
          return;
        }

        (req as any).projectRole = Role.Agent;
        next();
        return;
      }

      // ── JWT user path ───────────────────────────────────────────────────
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      if (!projectId) {
        res.status(400).json({ detail: 'Project ID required' });
        return;
      }

      // Look up membership
      const memberRepo = AppDataSource.getRepository(ProjectMember);
      const membership = await memberRepo.findOne({
        where: { projectId, userId },
      });

      if (!membership) {
        res.status(403).json({ detail: 'Not a member of this project' });
        return;
      }

      const role = toRole(membership.role);
      const allowedPermissions = ROLE_PERMISSIONS[role];

      // Special logic for EditAgent (checked BEFORE the role matrix so members — who
      // don't carry EditAgent in their permission set — can still manage agents they
      // own). Owner/Admin/Member may edit any agent they own; everyone else still
      // needs the EditAgent permission via the matrix below.
      // NOTE: previously this block sat *after* the matrix gate, making it dead code
      // for members and leaving their own agents' keys unrecoverable (rotate/revoke).
      if (permission === Permission.EditAgent) {
        const agentId = req.params.agent_id || req.params.aid;
        if (agentId) {
          const agentRepo = AppDataSource.getRepository(Agent);
          const agent = await agentRepo.findOne({ where: { id: agentId } });
          if (!agent) {
            res.status(404).json({ detail: 'Agent not found' });
            return;
          }
          // The agent's owner (owner_user_id, falling back to created_by) may edit it
          // regardless of role — this is the key-recovery path for members/viewers.
          if (agent.ownerUserId === userId || agent.createdBy === userId) {
            (req as any).projectRole = role;
            next();
            return;
          }
        }
      }

      if (!allowedPermissions.has(permission)) {
        res.status(403).json({ detail: `Insufficient permissions: ${permission} requires ${role}` });
        return;
      }

      // Attach role to request for downstream handlers
      (req as any).projectRole = role;
      next();
    } catch (error) {
      console.error('RBAC error:', error);
      res.status(500).json({ detail: 'Internal authorization error' });
    }
  };
}
