import { Incident, AlertSeverity, IncidentStatus } from '../entities/incident.entity';
import { AppDataSource } from '../data-source';
import { eventStreamService } from './event-stream.service';

const incidentRepo = AppDataSource.getRepository(Incident);

// ─── Alert Routing Rules ────────────────────────────────────────────────────
// Defines how incidents are routed based on severity and type.

interface AlertRoute {
  /** Severity levels this route handles */
  severities: AlertSeverity[];
  /** Alert types this route handles (empty = all) */
  types?: string[];
  /** Routing action */
  action: 'event' | 'log' | 'escalate';
}

const ALERT_ROUTES: AlertRoute[] = [
  {
    // Critical alerts → broadcast via event stream + log
    severities: ['critical'],
    action: 'event',
  },
  {
    // Warning alerts → log only (no event noise)
    severities: ['warning'],
    types: ['latency_drift'],
    action: 'log',
  },
  {
    // All other warnings → broadcast via event stream
    severities: ['warning'],
    action: 'event',
  },
];

// ─── Alert Routing Service ─────────────────────────────────────────────────

export class AlertRoutingService {
  /**
   * Route a newly created incident to the appropriate handler(s).
   */
  async route(incident: Incident): Promise<void> {
    const routes = this.matchRoutes(incident);

    for (const route of routes) {
      switch (route.action) {
        case 'event':
          await this.sendToEventStream(incident);
          break;
        case 'log':
          this.logIncident(incident);
          break;
        case 'escalate':
          await this.escalate(incident);
          break;
      }
    }
  }

  /**
   * Resolve an incident and send a resolution event.
   */
  async resolve(incidentId: string, resolvedBy: string): Promise<Incident | null> {
    const incident = await incidentRepo.findOne({ where: { id: incidentId } });
    if (!incident) return null;

    incident.status = 'resolved' as IncidentStatus;
    incident.resolvedAt = new Date();
    incident.resolvedBy = resolvedBy;
    await incidentRepo.save(incident);

    // Broadcast resolution event
    try {
      const { Session } = await import('../entities/session.entity');
      const { SessionParticipant } = await import('../entities/session-participant.entity');
      const participantRepo = AppDataSource.getRepository(SessionParticipant);
      const participant = await participantRepo.findOne({
        where: { agentId: incident.agentId },
        relations: ['session'],
        order: { joinedAt: 'DESC' },
      });

      if (participant) {
        eventStreamService.publish(participant.sessionId, {
          projectId: participant.session.projectId,
          sessionId: participant.sessionId,
          agentId: incident.agentId,
          type: 'incident.resolved',
          payload: {
            id: incident.id,
            incident_type: incident.type,
            severity: incident.severity,
            resolved_by: resolvedBy,
            resolved_at: incident.resolvedAt,
          },
        });
      }
    } catch {
      // Event stream failure should not block resolution
      console.warn(`Failed to publish incident resolution event for ${incidentId}`);
    }

    return incident;
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  private matchRoutes(incident: Incident): AlertRoute[] {
    return ALERT_ROUTES.filter((route) => {
      if (!route.severities.includes(incident.severity)) return false;
      if (route.types && !route.types.includes(incident.type)) return false;
      return true;
    });
  }

  private async sendToEventStream(incident: Incident): Promise<void> {
    try {
      const { SessionParticipant } = await import('../entities/session-participant.entity');
      const participantRepo = AppDataSource.getRepository(SessionParticipant);
      const participant = await participantRepo.findOne({
        where: { agentId: incident.agentId },
        relations: ['session'],
        order: { joinedAt: 'DESC' },
      });

      if (participant) {
        eventStreamService.publish(participant.sessionId, {
          projectId: participant.session.projectId,
          sessionId: participant.sessionId,
          agentId: incident.agentId,
          type: 'incident.created',
          payload: {
            id: incident.id,
            incident_type: incident.type,
            severity: incident.severity,
            status: incident.status,
            message: incident.message,
            details: incident.details,
            created_at: incident.createdAt,
          },
        });
      } else {
        console.warn(`No session found for agent ${incident.agentId}, skipping event stream publish`);
      }
    } catch {
      console.warn(`Failed to publish incident event for ${incident.id}`);
    }
  }

  private logIncident(incident: Incident): void {
    console.log(
      `[ALERT] ${incident.severity.toUpperCase()} | ${incident.type} | agent=${incident.agentId} | ${incident.message}`,
    );
  }

  private async escalate(incident: Incident): Promise<void> {
    // Future: integrate with external alerting (email, Slack, PagerDuty, etc.)
    console.log(
      `[ESCALATE] ${incident.severity} incident ${incident.id} for agent ${incident.agentId}: ${incident.message}`,
    );

    // Also send via event stream for real-time visibility
    await this.sendToEventStream(incident);
  }
}

// Singleton export
export const alertRoutingService = new AlertRoutingService();
