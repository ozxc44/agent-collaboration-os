import { AppDataSource } from '../data-source';
import { McpCapability } from '../entities/mcp-capability.entity';
import { Repository } from 'typeorm';

export interface McpCapabilityInput {
  name: string;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface McpCapabilityResult {
  id: string;
  projectId: string;
  agentId: string;
  name: string;
  description: string | null;
  schema: Record<string, unknown> | null;
  createdAt: Date;
}

function toResult(entity: McpCapability): McpCapabilityResult {
  let schema: Record<string, unknown> | null = null;
  if (entity.schemaJson) {
    try {
      schema = JSON.parse(entity.schemaJson);
    } catch {
      schema = null;
    }
  }

  return {
    id: entity.id,
    projectId: entity.projectId,
    agentId: entity.agentId,
    name: entity.name,
    description: entity.description || null,
    schema,
    createdAt: entity.createdAt,
  };
}

/**
 * McpBridgeService manages MCP capability registrations per project.
 * Capabilities describe what tools/functions an agent exposes via MCP.
 */
class McpBridgeService {
  private getRepo(): Repository<McpCapability> {
    return AppDataSource.getRepository(McpCapability);
  }

  /**
   * Register a new MCP capability for an agent within a project.
   */
  async registerCapability(
    projectId: string,
    agentId: string,
    input: McpCapabilityInput,
  ): Promise<McpCapabilityResult> {
    const repo = this.getRepo();
    const entity = repo.create({
      projectId,
      agentId,
      name: input.name,
      description: input.description || null,
      schemaJson: input.schema ? JSON.stringify(input.schema) : null,
    } as any) as unknown as McpCapability;

    const saved = await repo.save(entity);
    return toResult(saved);
  }

  /**
   * List all MCP capabilities registered for a project.
   */
  async listCapabilities(projectId: string): Promise<McpCapabilityResult[]> {
    const entities = await this.getRepo().find({
      where: { projectId },
      order: { createdAt: 'ASC' },
    });

    return entities.map(toResult);
  }

  /**
   * Remove a specific MCP capability by ID within a project.
   * Returns true if deleted, false if not found.
   */
  async removeCapability(projectId: string, capabilityId: string): Promise<boolean> {
    const entity = await this.getRepo().findOne({
      where: { id: capabilityId, projectId },
    });

    if (!entity) return false;

    await this.getRepo().remove(entity);
    return true;
  }
}

export const mcpBridgeService = new McpBridgeService();
