import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { authenticateJwtOrAgentApiKey, extractProjectId } from '../middleware/auth';
import { Permission, requirePermission, Role } from '../middleware/rbac';
import {
  Agent,
  Project,
  ProjectGate,
  ProjectGateAttempt,
  ProjectGateAttemptStatus,
  ProjectGateTemplate,
  ProjectGateTemplateKind,
  ProjectJoinRequest,
  ProjectJoinRequestStatus,
  ProjectMember,
  ProjectRole,
  ProjectVisibility,
  User,
} from '../entities';
import { createInboxItem } from './agent-inbox.routes';

const router = Router();

const PRESET_TEMPLATES = [
  {
    key: 'preset.programming.basic',
    name: 'Basic Programming Gate',
    description: 'Timed deterministic programming admission test for agent project membership.',
    kind: ProjectGateTemplateKind.PROGRAMMING,
    definition: {
      time_limit_minutes: 30,
      expected_artifacts: ['result_md', 'evidence'],
      allowed_commands: ['npm test', 'npm run test:unit', 'npm run build', 'pytest', 'pytest -q'],
      allowed_paths: ['src/', 'tests/', 'backend/src/', 'backend/tests/', 'README.md', 'docs/'],
      checks: [
        'result_md_present',
        'evidence_present',
        'tests_passed',
        'commands_allowed',
        'paths_allowed',
        'deadline_not_expired',
      ],
    },
    isPreset: true,
  },
  {
    key: 'preset.research.basic',
    name: 'Basic Research Gate',
    description: 'Evidence-first research admission test with source and summary checks.',
    kind: ProjectGateTemplateKind.RESEARCH,
    definition: {
      time_limit_minutes: 45,
      expected_artifacts: ['result_md', 'evidence.sources'],
      checks: ['result_md_present', 'sources_present', 'deadline_not_expired'],
    },
    isPreset: true,
  },
  {
    key: 'preset.tool-use.basic',
    name: 'Basic Tool Use Gate',
    description: 'Tool execution admission test requiring command evidence and structured output.',
    kind: ProjectGateTemplateKind.TOOL_USE,
    definition: {
      time_limit_minutes: 30,
      expected_artifacts: ['result_md', 'evidence.commands'],
      allowed_commands: ['npm run build', 'npm run test:unit', 'pytest -q'],
      checks: ['result_md_present', 'commands_present', 'commands_allowed', 'deadline_not_expired'],
    },
    isPreset: true,
  },
];

router.get('/v1/gate-templates', async (_req: Request, res: Response) => {
  try {
    await ensurePresetGateTemplates();
    const templates = await AppDataSource.getRepository(ProjectGateTemplate).find({
      order: { isPreset: 'DESC', key: 'ASC' },
    });
    res.json({ data: templates.map(serializeTemplate) });
  } catch (err) {
    console.error('List gate templates error:', err);
    res.status(500).json({ detail: 'Internal server error' });
  }
});

router.get(
  '/v1/projects/:project_id/gates',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      if (!await canViewProjectGateFlow(req)) {
        res.status(403).json({ detail: 'Not allowed to view project gates' });
        return;
      }
      await ensurePresetGateTemplates();
      const gates = await AppDataSource.getRepository(ProjectGate).find({
        where: { projectId: req.params.project_id },
        relations: ['template'],
        order: { createdAt: 'ASC' },
      });
      res.json({ data: gates.map(serializeGate) });
    } catch (err) {
      console.error('List project gates error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/gates',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      if (!await canManageProjectGates(req)) {
        res.status(403).json({ detail: 'Only owner/admin or an owner-created agent can manage project gates' });
        return;
      }
      await ensurePresetGateTemplates();
      const template = await resolveTemplate(req.body.template_id, req.body.template_key);
      if (!template) {
        res.status(404).json({ detail: 'Gate template not found' });
        return;
      }
      const ownerAgentId = await normalizeOwnerAgent(req.params.project_id, req.body.owner_agent_id);
      if (ownerAgentId === false) {
        res.status(404).json({ detail: 'owner_agent_id is not an agent in this project' });
        return;
      }

      const repo = AppDataSource.getRepository(ProjectGate);
      const existing = await repo.findOne({
        where: { projectId: req.params.project_id, templateId: template.id },
      });
      const gate = existing ?? repo.create({
        projectId: req.params.project_id,
        templateId: template.id,
      });
      gate.enabled = req.body.enabled !== false;
      gate.required = req.body.required !== false;
      gate.ownerAgentId = ownerAgentId;
      gate.config = isPlainObject(req.body.config) ? req.body.config : null;
      const saved = await repo.save(gate);
      const loaded = await repo.findOneOrFail({ where: { id: saved.id }, relations: ['template'] });
      res.status(existing ? 200 : 201).json(serializeGate(loaded));
    } catch (err) {
      console.error('Create project gate error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/gates/:gate_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  requirePermission(Permission.SendMessage),
  async (req: Request, res: Response) => {
    try {
      if (!await canManageProjectGates(req)) {
        res.status(403).json({ detail: 'Only owner/admin or an owner-created agent can manage project gates' });
        return;
      }
      const repo = AppDataSource.getRepository(ProjectGate);
      const gate = await repo.findOne({
        where: { id: req.params.gate_id, projectId: req.params.project_id },
        relations: ['template'],
      });
      if (!gate) {
        res.status(404).json({ detail: 'Gate not found' });
        return;
      }
      if (typeof req.body.enabled === 'boolean') gate.enabled = req.body.enabled;
      if (typeof req.body.required === 'boolean') gate.required = req.body.required;
      if (req.body.owner_agent_id !== undefined) {
        const ownerAgentId = await normalizeOwnerAgent(req.params.project_id, req.body.owner_agent_id);
        if (ownerAgentId === false) {
          res.status(404).json({ detail: 'owner_agent_id is not an agent in this project' });
          return;
        }
        gate.ownerAgentId = ownerAgentId;
      }
      if (req.body.config !== undefined) {
        gate.config = isPlainObject(req.body.config) ? req.body.config : null;
      }
      const saved = await repo.save(gate);
      res.json(serializeGate(saved));
    } catch (err) {
      console.error('Update project gate error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/join-requests/:request_id/gate-attempts',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ detail: 'Gate attempts currently require user JWT authentication' });
        return;
      }
      const joinRequest = await AppDataSource.getRepository(ProjectJoinRequest).findOne({
        where: { id: req.params.request_id, projectId: req.params.project_id },
      });
      if (!joinRequest) {
        res.status(404).json({ detail: 'Join request not found' });
        return;
      }
      if (joinRequest.userId !== userId && !await isProjectOwnerOrAdmin(req.params.project_id, userId)) {
        res.status(403).json({ detail: 'Only the applicant or project owner/admin can start this gate attempt' });
        return;
      }
      if (joinRequest.status !== ProjectJoinRequestStatus.PENDING) {
        res.status(409).json({ detail: 'Join request is not pending' });
        return;
      }

      const gateId = typeof req.body.gate_id === 'string' ? req.body.gate_id : '';
      const gate = await AppDataSource.getRepository(ProjectGate).findOne({
        where: { id: gateId, projectId: req.params.project_id, enabled: true },
        relations: ['template'],
      });
      if (!gate) {
        res.status(404).json({ detail: 'Gate not found or disabled' });
        return;
      }

      const now = new Date();
      const attemptRepo = AppDataSource.getRepository(ProjectGateAttempt);
      const attempt = await attemptRepo.save(attemptRepo.create({
        projectId: req.params.project_id,
        gateId: gate.id,
        joinRequestId: joinRequest.id,
        applicantUserId: joinRequest.userId,
        applicantAgentId: typeof req.body.applicant_agent_id === 'string' ? req.body.applicant_agent_id : null,
        status: ProjectGateAttemptStatus.STARTED,
        startedAt: now,
        deadlineAt: new Date(now.getTime() + gateTimeLimitMs(gate)),
      }));
      res.status(201).json(serializeAttempt(attempt, gate));
    } catch (err) {
      console.error('Start gate attempt error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/gate-attempts',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      const qb = AppDataSource.getRepository(ProjectGateAttempt)
        .createQueryBuilder('attempt')
        .leftJoinAndSelect('attempt.gate', 'gate')
        .leftJoinAndSelect('gate.template', 'template')
        .where('attempt.projectId = :projectId', { projectId: req.params.project_id })
        .orderBy('attempt.createdAt', 'DESC');

      const canViewAll = req.user?.userId
        ? await isProjectOwnerOrAdmin(req.params.project_id, req.user.userId)
        : false;
      if (!canViewAll) {
        if (req.user?.userId) {
          qb.andWhere('attempt.applicantUserId = :userId', { userId: req.user.userId });
        } else if (req.agent?.id) {
          qb.andWhere('(attempt.applicantAgentId = :agentId OR gate.ownerAgentId = :agentId)', { agentId: req.agent.id });
        } else {
          res.status(401).json({ detail: 'Authentication required' });
          return;
        }
      }
      const attempts = await qb.getMany();
      res.json({ data: attempts.map((attempt) => serializeAttempt(attempt, attempt.gate)) });
    } catch (err) {
      console.error('List gate attempts error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/gate-attempts/:attempt_id',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      const attempt = await loadAttempt(req.params.project_id, req.params.attempt_id);
      if (!attempt) {
        res.status(404).json({ detail: 'Gate attempt not found' });
        return;
      }
      if (!await canViewAttempt(req, attempt)) {
        res.status(403).json({ detail: 'Not allowed to view this gate attempt' });
        return;
      }
      res.json(serializeAttempt(attempt, attempt.gate));
    } catch (err) {
      console.error('Get gate attempt error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/gate-attempts/:attempt_id/submit',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      const attempt = await loadAttempt(req.params.project_id, req.params.attempt_id);
      if (!attempt) {
        res.status(404).json({ detail: 'Gate attempt not found' });
        return;
      }
      if (!canSubmitAttempt(req, attempt)) {
        res.status(403).json({ detail: 'Only the applicant can submit this gate attempt' });
        return;
      }
      if (![ProjectGateAttemptStatus.STARTED, ProjectGateAttemptStatus.PREFILTER_FAILED].includes(attempt.status)) {
        res.status(409).json({ detail: 'Gate attempt cannot be submitted in its current status' });
        return;
      }

      attempt.submission = isPlainObject(req.body.submission) ? req.body.submission : req.body;
      attempt.status = ProjectGateAttemptStatus.PREFILTER_RUNNING;
      attempt.submittedAt = new Date();
      const prefilter = runPrefilter(attempt, attempt.gate);
      attempt.prefilterResult = prefilter;
      attempt.status = prefilter.passed
        ? ProjectGateAttemptStatus.UNDER_OWNER_REVIEW
        : ProjectGateAttemptStatus.PREFILTER_FAILED;
      const saved = await AppDataSource.getRepository(ProjectGateAttempt).save(attempt);
      res.status(prefilter.passed ? 200 : 422).json(serializeAttempt(saved, attempt.gate));

      // Notify gate owner agent when attempt reaches owner review
      if (prefilter.passed && attempt.gate?.ownerAgentId) {
        try {
          await createInboxItem({
            projectId: req.params.project_id,
            recipientAgentId: attempt.gate.ownerAgentId,
            eventType: 'gate_attempt_submitted',
            title: 'Gate attempt submitted for review',
            body: 'A gate attempt is ready for owner review.',
            payload: {
              project_id: req.params.project_id,
              gate_attempt_id: attempt.id,
              gate_id: attempt.gate.id,
              join_request_id: attempt.joinRequestId,
            },
          });
        } catch (e) {
          // ignore inbox failures
        }
      }
    } catch (err) {
      console.error('Submit gate attempt error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/gate-attempts/:attempt_id/prefilter',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      const attempt = await loadAttempt(req.params.project_id, req.params.attempt_id);
      if (!attempt) {
        res.status(404).json({ detail: 'Gate attempt not found' });
        return;
      }
      if (!await canViewAttempt(req, attempt)) {
        res.status(403).json({ detail: 'Not allowed to run this prefilter' });
        return;
      }
      if ([
        ProjectGateAttemptStatus.APPROVED,
        ProjectGateAttemptStatus.REJECTED,
        ProjectGateAttemptStatus.EXPIRED,
      ].includes(attempt.status)) {
        res.status(409).json({ detail: 'Terminal gate attempts cannot be prefiltered again' });
        return;
      }
      const prefilter = runPrefilter(attempt, attempt.gate);
      attempt.prefilterResult = prefilter;
      attempt.status = prefilter.passed
        ? ProjectGateAttemptStatus.UNDER_OWNER_REVIEW
        : ProjectGateAttemptStatus.PREFILTER_FAILED;
      const saved = await AppDataSource.getRepository(ProjectGateAttempt).save(attempt);
      res.status(prefilter.passed ? 200 : 422).json(serializeAttempt(saved, attempt.gate));
    } catch (err) {
      console.error('Run gate prefilter error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/gate-attempts/:attempt_id/review',
  authenticateJwtOrAgentApiKey,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      const attempt = await loadAttempt(req.params.project_id, req.params.attempt_id);
      if (!attempt) {
        res.status(404).json({ detail: 'Gate attempt not found' });
        return;
      }
      if (!await canReviewAttempt(req, attempt)) {
        res.status(403).json({ detail: 'Only owner/admin or this gate owner agent can review the attempt' });
        return;
      }
      if (attempt.status !== ProjectGateAttemptStatus.UNDER_OWNER_REVIEW) {
        res.status(409).json({ detail: 'Attempt must pass prefilter before owner review' });
        return;
      }
      const decision = req.body.decision ?? req.body.status;
      if (!['approved', 'rejected'].includes(decision)) {
        res.status(422).json({ detail: 'decision must be approved or rejected' });
        return;
      }
      const saved = await AppDataSource.transaction(async (manager) => {
        attempt.status = decision === 'approved'
          ? ProjectGateAttemptStatus.APPROVED
          : ProjectGateAttemptStatus.REJECTED;
        attempt.reviewedAt = new Date();
        attempt.reviewNotes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 10_000) : null;
        attempt.reviewedByUserId = req.user?.userId ?? null;
        attempt.reviewedByAgentId = req.agent?.id ?? null;
        const updated = await manager.save(ProjectGateAttempt, attempt);
        if (updated.status === ProjectGateAttemptStatus.APPROVED && updated.joinRequestId) {
          await approveJoinRequestIfGateSatisfied(manager, updated.projectId, updated.joinRequestId);
        }
        return updated;
      });
      const loaded = await loadAttempt(saved.projectId, saved.id);
      res.json(serializeAttempt(loaded ?? saved, loaded?.gate ?? attempt.gate));

      // Notify applicant's bound owner agent if one exists
      try {
        if (saved.applicantUserId) {
          const applicantUser = await AppDataSource.getRepository(User).findOne({
            where: { id: saved.applicantUserId },
          });
          if (applicantUser?.ownerAgentId) {
            await createInboxItem({
              projectId: saved.projectId,
              recipientAgentId: applicantUser.ownerAgentId,
              eventType: `gate_attempt_${decision}`,
              title: `Gate attempt ${decision}`,
              body: `Your gate attempt has been ${decision}.`,
              payload: {
                project_id: saved.projectId,
                gate_attempt_id: saved.id,
                gate_id: saved.gateId,
                join_request_id: saved.joinRequestId,
              },
            });
          }
        }
      } catch (e) {
        // ignore inbox failures
      }
    } catch (err) {
      console.error('Review gate attempt error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

async function ensurePresetGateTemplates(): Promise<void> {
  const repo = AppDataSource.getRepository(ProjectGateTemplate);
  for (const preset of PRESET_TEMPLATES) {
    const existing = await repo.findOne({ where: { key: preset.key } });
    if (existing) {
      existing.name = preset.name;
      existing.description = preset.description;
      existing.kind = preset.kind;
      existing.definition = preset.definition;
      existing.isPreset = true;
      await repo.save(existing);
      continue;
    }
    await repo.save(repo.create(preset));
  }
}

async function resolveTemplate(templateId: unknown, templateKey: unknown): Promise<ProjectGateTemplate | null> {
  const repo = AppDataSource.getRepository(ProjectGateTemplate);
  if (typeof templateId === 'string') {
    return repo.findOne({ where: { id: templateId } });
  }
  if (typeof templateKey === 'string') {
    return repo.findOne({ where: { key: templateKey } });
  }
  return null;
}

async function normalizeOwnerAgent(projectId: string, value: unknown): Promise<string | null | false> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return false;
  const agent = await AppDataSource.getRepository(Agent).findOne({ where: { id: value, projectId } });
  return agent ? agent.id : false;
}

async function canViewProjectGateFlow(req: Request): Promise<boolean> {
  if (req.agent) return req.agent.projectId === req.params.project_id;
  const userId = req.user?.userId;
  if (!userId) return false;
  const project = await AppDataSource.getRepository(Project).findOne({ where: { id: req.params.project_id } });
  if (!project) return false;
  if (project.visibility === ProjectVisibility.PUBLIC) return true;
  if (await isProjectMember(req.params.project_id, userId)) return true;
  return Boolean(await AppDataSource.getRepository(ProjectJoinRequest).findOne({
    where: { projectId: req.params.project_id, userId, status: ProjectJoinRequestStatus.PENDING },
  }));
}

async function canManageProjectGates(req: Request): Promise<boolean> {
  if (isOwnerOrAdmin(req)) return true;
  if (!req.agent) return false;
  const [agent, project] = await Promise.all([
    AppDataSource.getRepository(Agent).findOne({ where: { id: req.agent.id, projectId: req.params.project_id } }),
    AppDataSource.getRepository(Project).findOne({ where: { id: req.params.project_id } }),
  ]);
  return Boolean(agent && project && agent.createdBy === project.ownerId);
}

async function canReviewAttempt(req: Request, attempt: ProjectGateAttempt): Promise<boolean> {
  if (req.user?.userId && await isProjectOwnerOrAdmin(attempt.projectId, req.user.userId)) return true;
  return Boolean(req.agent?.id && attempt.gate?.ownerAgentId === req.agent.id);
}

async function canViewAttempt(req: Request, attempt: ProjectGateAttempt): Promise<boolean> {
  if (req.user?.userId && await isProjectOwnerOrAdmin(attempt.projectId, req.user.userId)) return true;
  if (req.user?.userId && attempt.applicantUserId === req.user.userId) return true;
  if (req.agent?.id && (attempt.applicantAgentId === req.agent.id || attempt.gate?.ownerAgentId === req.agent.id)) return true;
  return false;
}

function canSubmitAttempt(req: Request, attempt: ProjectGateAttempt): boolean {
  if (req.user?.userId && attempt.applicantUserId === req.user.userId) return true;
  if (req.agent?.id && attempt.applicantAgentId === req.agent.id) return true;
  return false;
}

async function loadAttempt(projectId: string, attemptId: string): Promise<ProjectGateAttempt | null> {
  return AppDataSource.getRepository(ProjectGateAttempt)
    .createQueryBuilder('attempt')
    .leftJoinAndSelect('attempt.gate', 'gate')
    .leftJoinAndSelect('gate.template', 'template')
    .where('attempt.id = :attemptId', { attemptId })
    .andWhere('attempt.projectId = :projectId', { projectId })
    .getOne();
}

function runPrefilter(attempt: ProjectGateAttempt, gate: ProjectGate): { passed: boolean; checks: Array<Record<string, unknown>> } {
  const submission = attempt.submission ?? {};
  const evidence = isPlainObject(submission.evidence) ? submission.evidence : {};
  const definition = mergedGateDefinition(gate);
  const configuredChecks = normalizeStringArray(definition.checks);
  const wants = (name: string) => configuredChecks.length === 0 || configuredChecks.includes(name);
  const checks: Array<Record<string, unknown>> = [];

  if (wants('result_md_present')) {
    const resultMd = typeof submission.result_md === 'string' ? submission.result_md.trim() : '';
    checks.push({
      name: 'result_md_present',
      passed: resultMd.length > 0,
      detail: resultMd.length > 0 ? 'result_md is present' : 'result_md is required',
    });
  }

  if (wants('evidence_present')) {
    checks.push({
      name: 'evidence_present',
      passed: Object.keys(evidence).length > 0,
      detail: Object.keys(evidence).length > 0 ? 'evidence is present' : 'evidence object is required',
    });
  }

  if (wants('tests_passed')) {
    const testsPassed = evidence.tests_passed === true || evidence.result === 'pass';
    checks.push({
      name: 'tests_passed',
      passed: testsPassed,
      detail: testsPassed ? 'tests passed' : 'evidence.tests_passed must be true or evidence.result must be pass',
    });
  }

  const allowedCommands = normalizeStringArray(definition.allowed_commands);
  const commands = normalizeStringArray(evidence.commands);
  if (wants('commands_present')) {
    checks.push({
      name: 'commands_present',
      passed: commands.length > 0,
      detail: commands.length > 0 ? 'commands are present' : 'evidence.commands is required',
      commands,
    });
  }
  if (wants('commands_allowed')) {
    const commandsAllowed = commands.length === 0
      ? false
      : allowedCommands.length > 0 && commands.every((command) => allowedCommands.includes(command));
    checks.push({
      name: 'commands_allowed',
      passed: commandsAllowed,
      detail: commandsAllowed ? 'commands are allowed' : 'commands must be present and in allowed_commands',
      commands,
      allowed_commands: allowedCommands,
    });
  }

  const allowedPaths = normalizeStringArray(definition.allowed_paths);
  const touchedPaths = normalizeStringArray(submission.files ?? evidence.changed_files);
  if (wants('paths_allowed')) {
    const pathsAllowed = touchedPaths.length === 0
      ? false
      : allowedPaths.length > 0 && touchedPaths.every((path) => allowedPaths.some((prefix) => path === prefix || path.startsWith(prefix)));
    checks.push({
      name: 'paths_allowed',
      passed: pathsAllowed,
      detail: pathsAllowed ? 'paths are allowed' : 'changed files must be present and under allowed_paths',
      files: touchedPaths,
      allowed_paths: allowedPaths,
    });
  }

  if (wants('sources_present')) {
    const sources = normalizeStringArray(evidence.sources ?? submission.sources);
    checks.push({
      name: 'sources_present',
      passed: sources.length > 0,
      detail: sources.length > 0 ? 'sources are present' : 'sources are required',
      sources,
    });
  }

  if (wants('deadline_not_expired')) {
    const deadlineOk = new Date() <= new Date(attempt.deadlineAt);
    checks.push({
      name: 'deadline_not_expired',
      passed: deadlineOk,
      detail: deadlineOk ? 'attempt submitted before deadline' : 'attempt deadline has expired',
    });
  }

  return { passed: checks.every((check) => check.passed === true), checks };
}

function mergedGateDefinition(gate: ProjectGate): Record<string, unknown> {
  const template = gate.template as ProjectGateTemplate | undefined;
  return {
    ...(template?.definition ?? {}),
    ...(gate.config ?? {}),
  };
}

function gateTimeLimitMs(gate: ProjectGate): number {
  const definition = mergedGateDefinition(gate);
  const minutes = typeof definition.time_limit_minutes === 'number' && Number.isFinite(definition.time_limit_minutes)
    ? definition.time_limit_minutes
    : 30;
  return Math.max(1, Math.min(minutes, 24 * 60)) * 60 * 1000;
}

async function approveJoinRequestIfGateSatisfied(
  manager: import('typeorm').EntityManager,
  projectId: string,
  joinRequestId: string,
): Promise<void> {
  const request = await manager.findOne(ProjectJoinRequest, { where: { id: joinRequestId, projectId } });
  if (!request || request.status !== ProjectJoinRequestStatus.PENDING) return;
  const requiredGates = await manager.find(ProjectGate, { where: { projectId, enabled: true, required: true } });
  for (const gate of requiredGates) {
    const approved = await manager.findOne(ProjectGateAttempt, {
      where: {
        projectId,
        joinRequestId,
        gateId: gate.id,
        status: ProjectGateAttemptStatus.APPROVED,
      },
    });
    if (!approved) return;
  }

  request.status = ProjectJoinRequestStatus.APPROVED;
  request.reviewedAt = new Date();
  request.reviewedBy = null;
  await manager.save(ProjectJoinRequest, request);
  const existingMember = await manager.findOne(ProjectMember, {
    where: { projectId, userId: request.userId },
  });
  if (!existingMember) {
    await manager.save(ProjectMember, manager.create(ProjectMember, {
      projectId,
      userId: request.userId,
      role: request.requestedRole,
    }));
  }
}

async function isProjectOwnerOrAdmin(projectId: string, userId: string): Promise<boolean> {
  const membership = await AppDataSource.getRepository(ProjectMember).findOne({ where: { projectId, userId } });
  return membership?.role === ProjectRole.OWNER || membership?.role === ProjectRole.ADMIN;
}

async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  return Boolean(await AppDataSource.getRepository(ProjectMember).findOne({ where: { projectId, userId } }));
}

function isOwnerOrAdmin(req: Request): boolean {
  return (req as any).projectRole === Role.Owner || (req as any).projectRole === Role.Admin;
}

function serializeTemplate(template: ProjectGateTemplate) {
  return {
    id: template.id,
    key: template.key,
    name: template.name,
    description: template.description ?? null,
    kind: template.kind,
    definition: template.definition,
    is_preset: template.isPreset,
    created_by_user_id: template.createdByUserId ?? null,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  };
}

function serializeGate(gate: ProjectGate) {
  const template = (gate as ProjectGate & { template?: ProjectGateTemplate }).template;
  return {
    id: gate.id,
    project_id: gate.projectId,
    template_id: gate.templateId,
    template: template ? serializeTemplate(template) : null,
    enabled: gate.enabled,
    required: gate.required,
    owner_agent_id: gate.ownerAgentId ?? null,
    config: gate.config ?? null,
    created_at: gate.createdAt,
    updated_at: gate.updatedAt,
  };
}

function serializeAttempt(attempt: ProjectGateAttempt, gate?: ProjectGate) {
  return {
    id: attempt.id,
    project_id: attempt.projectId,
    gate_id: attempt.gateId,
    gate: gate ? serializeGate(gate) : null,
    join_request_id: attempt.joinRequestId ?? null,
    applicant_user_id: attempt.applicantUserId ?? null,
    applicant_agent_id: attempt.applicantAgentId ?? null,
    status: attempt.status,
    started_at: attempt.startedAt,
    deadline_at: attempt.deadlineAt,
    submitted_at: attempt.submittedAt ?? null,
    reviewed_at: attempt.reviewedAt ?? null,
    submission: attempt.submission ?? null,
    prefilter_result: attempt.prefilterResult ?? null,
    review_notes: attempt.reviewNotes ?? null,
    reviewed_by_user_id: attempt.reviewedByUserId ?? null,
    reviewed_by_agent_id: attempt.reviewedByAgentId ?? null,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
    .map((item) => item.trim());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export default router;
