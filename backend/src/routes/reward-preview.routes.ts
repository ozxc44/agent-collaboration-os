import { Router, Request, Response } from 'express';
import { AppDataSource } from '../data-source';
import { authenticate, extractProjectId, authenticateJwtOrAgentApiKey } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AgentWorkUnit } from '../entities/agent-work-unit.entity';
import { Agent } from '../entities/agent.entity';
import { ProjectMember } from '../entities/project-member.entity';
import { Project } from '../entities/project.entity';

const router = Router();
const workUnitRepo = () => AppDataSource.getRepository(AgentWorkUnit);
const agentRepo = () => AppDataSource.getRepository(Agent);

function csvEscape(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function assertOwnerOrAdmin(req: Request, res: Response): Promise<boolean> {
  const projectId = req.params.project_id;
  if (!req.user) {
    res.status(401).json({ detail: 'Authentication required' });
    return false;
  }
  const membership = await AppDataSource.getRepository(ProjectMember).findOne({
    where: { projectId, userId: req.user.userId },
  });
  if (!membership) {
    res.status(403).json({ detail: 'Not a member of this project' });
    return false;
  }
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    res.status(403).json({ detail: 'Only project owner or admin can manage reward preview' });
    return false;
  }
  return true;
}

interface RewardPreviewEntry {
  agentId: string;
  agentName: string | null;
  totalTasks: number;
  reviewedTasks: number;
  provisionalUnits: number;
  finalUnits: number;
  avgReviewScore: number | null;
  adjustmentTotal: number;
  adjustmentReason: string | null;
  avgScoreSum: number;
  avgScoreCount: number;
}

function buildRewardPreview(units: AgentWorkUnit[], agents: Agent[], ruleVersion?: string | null) {
  // Aggregate per agent
  const byAgent = new Map<string, RewardPreviewEntry>();

  for (const u of units) {
    let entry = byAgent.get(u.agentId);
    if (!entry) {
      entry = {
        agentId: u.agentId,
        agentName: null,
        totalTasks: 0,
        reviewedTasks: 0,
        provisionalUnits: 0,
        finalUnits: 0,
        avgReviewScore: null,
        adjustmentTotal: 0,
        adjustmentReason: null,
        avgScoreSum: 0,
        avgScoreCount: 0,
      };
      byAgent.set(u.agentId, entry);
    }
    entry.totalTasks++;
    entry.provisionalUnits += u.provisionalWorkUnits ?? 0;
    entry.finalUnits += u.finalWorkUnits ?? 0;
    if (u.adjustmentValue) {
      entry.adjustmentTotal += u.adjustmentValue;
    }
    if (u.adjustmentReason && !entry.adjustmentReason) {
      entry.adjustmentReason = u.adjustmentReason;
    }
    if (u.status === 'reviewed_approved' || u.status === 'reviewed_changes_requested') {
      entry.reviewedTasks++;
      if (u.reviewScore !== null && u.reviewScore !== undefined) {
        entry.avgScoreSum += u.reviewScore;
        entry.avgScoreCount += 1;
      }
    }
  }

  const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));
  const totalFinal = [...byAgent.values()].reduce((sum, e) => sum + e.finalUnits + e.adjustmentTotal, 0);

  const contributions = [...byAgent.values()].map((e) => {
    const avgScore = e.avgScoreCount > 0 ? e.avgScoreSum / e.avgScoreCount : null;
    const adjustedFinal = e.finalUnits + e.adjustmentTotal;
    return {
      agent_id: e.agentId,
      agent_name: agentNameMap.get(e.agentId) ?? null,
      total_tasks: e.totalTasks,
      reviewed_tasks: e.reviewedTasks,
      provisional_units: e.provisionalUnits,
      final_units: e.finalUnits,
      adjustment_total: e.adjustmentTotal,
      adjustment_reason: e.adjustmentReason,
      avg_review_score: avgScore,
      adjusted_final_units: adjustedFinal,
      estimated_share_percent: totalFinal > 0 ? parseFloat(((adjustedFinal / totalFinal) * 100).toFixed(4)) : 0,
    };
  });

  return {
    project_id: units[0]?.projectId ?? null,
    rule_version: ruleVersion ?? 'v1',
    generated_at: new Date().toISOString(),
    summary: {
      total_agents: contributions.length,
      total_tasks: contributions.reduce((s, c) => s + c.total_tasks, 0),
      total_reviewed_tasks: contributions.reduce((s, c) => s + c.reviewed_tasks, 0),
      total_final_units: totalFinal,
    },
    contributions,
  };
}

/**
 * GET /v1/projects/:project_id/reward-preview
 * Return explainable reward preview for the project.
 * Requires owner/admin.
 */
router.get(
  '/v1/projects/:project_id/reward-preview',
  authenticate,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      if (!(await assertOwnerOrAdmin(req, res))) return;
      const projectId = req.params.project_id;

      const units = await workUnitRepo().find({
        where: { projectId },
        order: { createdAt: 'DESC' },
      });

      // Determine rule version from most recent unit with one, else default
      let ruleVersion: string | null = null;
      for (const u of units) {
        if (u.rewardRuleVersion) {
          ruleVersion = u.rewardRuleVersion;
          break;
        }
      }

      const agentIds = [...new Set(units.map((u) => u.agentId))];
      const agents = agentIds.length > 0 ? await agentRepo().findByIds(agentIds) : [];

      const preview = buildRewardPreview(units, agents, ruleVersion);

      // JSON or CSV export
      if (req.query.format === 'csv') {
        const header = 'agent_id,agent_name,total_tasks,reviewed_tasks,provisional_units,final_units,adjustment_total,avg_review_score,adjusted_final_units,estimated_share_percent';
        const rows = preview.contributions.map((c) =>
          [
            c.agent_id,
            csvEscape(c.agent_name),
            c.total_tasks,
            c.reviewed_tasks,
            c.provisional_units,
            c.final_units,
            c.adjustment_total,
            c.avg_review_score ?? '',
            c.adjusted_final_units,
            c.estimated_share_percent,
          ].join(','),
        );
        const csv = [header, ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="reward-preview-${projectId}.csv"`);
        res.send(csv);
        return;
      }

      res.json(preview);
    } catch (err) {
      console.error('Reward preview error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/projects/:project_id/reward-preview/recalculate
 * Refresh calculation snapshots and rule version for all project work units.
 * Requires owner/admin.
 */
router.post(
  '/v1/projects/:project_id/reward-preview/recalculate',
  authenticate,
  extractProjectId,
  async (req: Request, res: Response) => {
    try {
      if (!(await assertOwnerOrAdmin(req, res))) return;
      const projectId = req.params.project_id;

      const units = await workUnitRepo().find({ where: { projectId } });
      const ruleVersion = `v1-${Date.now()}`;

      for (const u of units) {
        u.rewardRuleVersion = ruleVersion;
        u.calculationSnapshotJson = {
          recalculated_at: new Date().toISOString(),
          provisional_work_units: u.provisionalWorkUnits,
          final_work_units: u.finalWorkUnits,
          review_score: u.reviewScore,
          adjustment_value: u.adjustmentValue,
          status: u.status,
        };
      }

      if (units.length > 0) {
        await workUnitRepo().save(units);
      }

      const agentIds = [...new Set(units.map((u) => u.agentId))];
      const agents = agentIds.length > 0 ? await agentRepo().findByIds(agentIds) : [];

      const preview = buildRewardPreview(units, agents, ruleVersion);
      res.json({
        recalculated: units.length,
        rule_version: ruleVersion,
        preview,
      });
    } catch (err) {
      console.error('Reward preview recalculate error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

/**
 * POST /v1/work-units/:work_unit_id/adjust
 * Manually adjust a work unit's contribution with an audit reason.
 * Requires owner/admin.
 */
router.post(
  '/v1/work-units/:work_unit_id/adjust',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const workUnitId = req.params.work_unit_id;
      const { adjustment_value, reason } = req.body;

      if (!req.user) {
        res.status(401).json({ detail: 'Authentication required' });
        return;
      }

      const unit = await workUnitRepo().findOne({ where: { id: workUnitId } });
      if (!unit) {
        res.status(404).json({ detail: 'Work unit not found' });
        return;
      }

      // Verify user is owner/admin of the project
      const membership = await AppDataSource.getRepository(ProjectMember).findOne({
        where: { projectId: unit.projectId, userId: req.user.userId },
      });
      if (!membership) {
        res.status(403).json({ detail: 'Not a member of this project' });
        return;
      }
      if (membership.role !== 'owner' && membership.role !== 'admin') {
        res.status(403).json({ detail: 'Only project owner or admin can adjust work units' });
        return;
      }

      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        res.status(422).json({ detail: 'Adjustment reason is required and must be non-empty' });
        return;
      }

      if (typeof adjustment_value !== 'number' || isNaN(adjustment_value)) {
        res.status(422).json({ detail: 'adjustment_value must be a number' });
        return;
      }

      unit.adjustmentValue = adjustment_value;
      unit.adjustmentReason = reason.trim();
      unit.adjustedByUserId = req.user.userId;
      unit.lockedAt = new Date();
      await workUnitRepo().save(unit);

      res.json({
        id: unit.id,
        agent_id: unit.agentId,
        adjustment_value: unit.adjustmentValue,
        adjustment_reason: unit.adjustmentReason,
        adjusted_by_user_id: unit.adjustedByUserId,
        locked_at: unit.lockedAt?.toISOString() ?? null,
      });
    } catch (err) {
      console.error('Work unit adjust error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
