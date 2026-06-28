import { Router, Request, Response } from 'express';
import { authenticate, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { ProjectPackage } from '../entities/project-package.entity';
import { ProjectAuditAction } from '../entities/project-audit-event.entity';
import { recordProjectModuleAudit } from '../services/project-audit.service';

const router = Router();
const packageRepo = AppDataSource.getRepository(ProjectPackage);

const ALLOWED_PACKAGE_TYPES = new Set(['generic', 'container', 'npm', 'python']);
const MAX_NAME_LENGTH = 255;
const MAX_VERSION_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 200_000;
const MAX_REPOSITORY_URL_LENGTH = 2048;
const MAX_METADATA_BYTES = 50_000;

function normalizePackageName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._/-]/g, '')
    .replace(/[-/]+/g, (match) => match[0])
    .replace(/^[._/-]+|[._/-]+$/g, '')
    .slice(0, MAX_NAME_LENGTH);
}

function normalizePackageVersion(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._+:-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[._+:-]+|[._+:-]+$/g, '')
    .slice(0, MAX_VERSION_LENGTH);
}

function parseMetadata(raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Metadata must be an object' };
  }
  const encoded = JSON.stringify(raw);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) {
    return { ok: false, message: `Metadata must be ${MAX_METADATA_BYTES} bytes or fewer` };
  }
  return { ok: true, value: encoded };
}

function decodeMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validateRepositoryUrl(raw: unknown): string | null | false {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_REPOSITORY_URL_LENGTH) return false;
  try {
    const url = new URL(trimmed);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return trimmed;
  } catch {
    return false;
  }
}

function serializePackage(pkg: ProjectPackage) {
  return {
    id: pkg.id,
    project_id: pkg.projectId,
    name: pkg.name,
    package_type: pkg.packageType,
    version: pkg.version,
    description: pkg.description,
    repository_url: pkg.repositoryUrl,
    metadata: decodeMetadata(pkg.metadata),
    created_by: pkg.createdBy,
    updated_by: pkg.updatedBy,
    created_at: pkg.createdAt,
    updated_at: pkg.updatedAt,
  };
}

function serializePackageSummary(pkg: ProjectPackage) {
  return {
    id: pkg.id,
    project_id: pkg.projectId,
    name: pkg.name,
    package_type: pkg.packageType,
    version: pkg.version,
    repository_url: pkg.repositoryUrl,
    created_by: pkg.createdBy,
    updated_by: pkg.updatedBy,
    created_at: pkg.createdAt,
    updated_at: pkg.updatedAt,
  };
}

router.get(
  '/v1/projects/:project_id/packages',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const skip = parseInt(req.query.skip as string, 10) || 0;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);

      const [packages, total] = await packageRepo.findAndCount({
        where: { projectId },
        order: { updatedAt: 'DESC' },
        skip,
        take: limit,
      });

      res.json({
        data: packages.map(serializePackageSummary),
        meta: { total, skip, limit },
      });
    } catch (err) {
      console.error('List packages error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/packages/:package_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const pkg = await packageRepo.findOne({
        where: { id: req.params.package_id, projectId: req.params.project_id },
      });
      if (!pkg) {
        res.status(404).json({ detail: 'Package not found' });
        return;
      }
      res.json(serializePackage(pkg));
    } catch (err) {
      console.error('Get package error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/packages',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user!.userId;
      const { name, package_type, version, description, repository_url, metadata } = req.body;

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(422).json({ detail: [{ loc: ['body', 'name'], msg: 'Name is required', type: 'missing' }] });
        return;
      }
      if (name.length > MAX_NAME_LENGTH) {
        res.status(422).json({ detail: [{ loc: ['body', 'name'], msg: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, type: 'too_long' }] });
        return;
      }
      const normalizedName = normalizePackageName(name);
      if (!normalizedName) {
        res.status(422).json({ detail: [{ loc: ['body', 'name'], msg: 'Name must contain at least one alphanumeric character', type: 'invalid' }] });
        return;
      }

      const packageType = package_type === undefined ? 'generic' : package_type;
      if (typeof packageType !== 'string' || !ALLOWED_PACKAGE_TYPES.has(packageType)) {
        res.status(422).json({ detail: [{ loc: ['body', 'package_type'], msg: 'Package type must be generic, container, npm, or python', type: 'invalid' }] });
        return;
      }

      if (!version || typeof version !== 'string' || version.trim().length === 0) {
        res.status(422).json({ detail: [{ loc: ['body', 'version'], msg: 'Version is required', type: 'missing' }] });
        return;
      }
      if (version.length > MAX_VERSION_LENGTH) {
        res.status(422).json({ detail: [{ loc: ['body', 'version'], msg: `Version must be ${MAX_VERSION_LENGTH} characters or fewer`, type: 'too_long' }] });
        return;
      }
      const normalizedVersion = normalizePackageVersion(version);
      if (!normalizedVersion) {
        res.status(422).json({ detail: [{ loc: ['body', 'version'], msg: 'Version must contain at least one alphanumeric character', type: 'invalid' }] });
        return;
      }

      const packageDescription = description === undefined ? '' : description;
      if (typeof packageDescription !== 'string') {
        res.status(422).json({ detail: [{ loc: ['body', 'description'], msg: 'Description must be a string', type: 'invalid' }] });
        return;
      }
      if (packageDescription.length > MAX_DESCRIPTION_LENGTH) {
        res.status(422).json({ detail: [{ loc: ['body', 'description'], msg: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`, type: 'too_long' }] });
        return;
      }

      const repositoryUrl = validateRepositoryUrl(repository_url);
      if (repositoryUrl === false) {
        res.status(422).json({ detail: [{ loc: ['body', 'repository_url'], msg: 'Repository URL must be a valid http(s) URL', type: 'invalid' }] });
        return;
      }

      const parsedMetadata = parseMetadata(metadata);
      if (!parsedMetadata.ok) {
        res.status(422).json({ detail: [{ loc: ['body', 'metadata'], msg: parsedMetadata.message, type: 'invalid' }] });
        return;
      }

      const existing = await packageRepo.findOne({ where: { projectId, name: normalizedName, version: normalizedVersion } });
      if (existing) {
        res.status(409).json({ detail: 'A package with this name and version already exists' });
        return;
      }

      const pkg = packageRepo.create({
        projectId,
        name: normalizedName,
        packageType,
        version: normalizedVersion,
        description: packageDescription,
        repositoryUrl,
        metadata: parsedMetadata.value,
        createdBy: userId,
        updatedBy: userId,
      });
      await packageRepo.save(pkg);

      await recordProjectModuleAudit(
        projectId,
        userId,
        ProjectAuditAction.PACKAGE_CREATED,
        { type: 'package', id: pkg.id, name: pkg.name },
        { version: pkg.version, package_type: pkg.packageType },
      ).catch((err) => console.error('Failed to record package_created audit:', err));

      res.status(201).json(serializePackage(pkg));
    } catch (err) {
      console.error('Create package error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/packages/:package_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const packageId = req.params.package_id;
      const userId = req.user!.userId;
      const pkg = await packageRepo.findOne({ where: { id: packageId, projectId } });
      if (!pkg) {
        res.status(404).json({ detail: 'Package not found' });
        return;
      }

      const before = {
        name: pkg.name,
        version: pkg.version,
        packageType: pkg.packageType,
        repositoryUrl: pkg.repositoryUrl,
      };

      const { name, package_type, version, description, repository_url, metadata } = req.body;
      let nextName = pkg.name;
      let nextVersion = pkg.version;

      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim().length === 0) {
          res.status(422).json({ detail: [{ loc: ['body', 'name'], msg: 'Name must be a non-empty string', type: 'invalid' }] });
          return;
        }
        if (name.length > MAX_NAME_LENGTH) {
          res.status(422).json({ detail: [{ loc: ['body', 'name'], msg: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, type: 'too_long' }] });
          return;
        }
        nextName = normalizePackageName(name);
        if (!nextName) {
          res.status(422).json({ detail: [{ loc: ['body', 'name'], msg: 'Name must contain at least one alphanumeric character', type: 'invalid' }] });
          return;
        }
      }

      if (version !== undefined) {
        if (typeof version !== 'string' || version.trim().length === 0) {
          res.status(422).json({ detail: [{ loc: ['body', 'version'], msg: 'Version must be a non-empty string', type: 'invalid' }] });
          return;
        }
        if (version.length > MAX_VERSION_LENGTH) {
          res.status(422).json({ detail: [{ loc: ['body', 'version'], msg: `Version must be ${MAX_VERSION_LENGTH} characters or fewer`, type: 'too_long' }] });
          return;
        }
        nextVersion = normalizePackageVersion(version);
        if (!nextVersion) {
          res.status(422).json({ detail: [{ loc: ['body', 'version'], msg: 'Version must contain at least one alphanumeric character', type: 'invalid' }] });
          return;
        }
      }

      if (nextName !== pkg.name || nextVersion !== pkg.version) {
        const existing = await packageRepo.findOne({ where: { projectId, name: nextName, version: nextVersion } });
        if (existing && existing.id !== packageId) {
          res.status(409).json({ detail: 'A package with this name and version already exists' });
          return;
        }
      }

      if (package_type !== undefined) {
        if (typeof package_type !== 'string' || !ALLOWED_PACKAGE_TYPES.has(package_type)) {
          res.status(422).json({ detail: [{ loc: ['body', 'package_type'], msg: 'Package type must be generic, container, npm, or python', type: 'invalid' }] });
          return;
        }
        pkg.packageType = package_type;
      }

      let descriptionChanged = false;
      if (description !== undefined) {
        if (typeof description !== 'string') {
          res.status(422).json({ detail: [{ loc: ['body', 'description'], msg: 'Description must be a string', type: 'invalid' }] });
          return;
        }
        if (description.length > MAX_DESCRIPTION_LENGTH) {
          res.status(422).json({ detail: [{ loc: ['body', 'description'], msg: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`, type: 'too_long' }] });
          return;
        }
        pkg.description = description;
        descriptionChanged = true;
      }

      if (repository_url !== undefined) {
        const repositoryUrl = validateRepositoryUrl(repository_url);
        if (repositoryUrl === false) {
          res.status(422).json({ detail: [{ loc: ['body', 'repository_url'], msg: 'Repository URL must be a valid http(s) URL', type: 'invalid' }] });
          return;
        }
        pkg.repositoryUrl = repositoryUrl;
      }

      let metadataChanged = false;
      if (metadata !== undefined) {
        const parsedMetadata = parseMetadata(metadata);
        if (!parsedMetadata.ok) {
          res.status(422).json({ detail: [{ loc: ['body', 'metadata'], msg: parsedMetadata.message, type: 'invalid' }] });
          return;
        }
        pkg.metadata = parsedMetadata.value;
        metadataChanged = true;
      }

      pkg.name = nextName;
      pkg.version = nextVersion;
      pkg.updatedBy = userId;
      await packageRepo.save(pkg);

      const changedFields: string[] = [];
      const auditMetadata: Record<string, unknown> = {};

      if (pkg.name !== before.name) {
        changedFields.push('name');
        auditMetadata.previous_name = before.name;
        auditMetadata.new_name = pkg.name;
      }
      if (pkg.version !== before.version) {
        changedFields.push('version');
        auditMetadata.previous_version = before.version;
        auditMetadata.new_version = pkg.version;
      }
      if (pkg.packageType !== before.packageType) {
        changedFields.push('package_type');
        auditMetadata.previous_package_type = before.packageType;
        auditMetadata.new_package_type = pkg.packageType;
      }
      if (descriptionChanged) {
        changedFields.push('description');
      }
      if (pkg.repositoryUrl !== before.repositoryUrl) {
        changedFields.push('repository_url');
        auditMetadata.previous_repository_url = before.repositoryUrl ?? null;
        auditMetadata.new_repository_url = pkg.repositoryUrl ?? null;
      }
      if (metadataChanged) {
        changedFields.push('metadata');
      }

      if (changedFields.length > 0) {
        auditMetadata.changed_fields = changedFields;
        await recordProjectModuleAudit(
          projectId,
          userId,
          ProjectAuditAction.PACKAGE_UPDATED,
          { type: 'package', id: pkg.id, name: pkg.name },
          auditMetadata,
        ).catch((err) => console.error('Failed to record package_updated audit:', err));
      }

      res.json(serializePackage(pkg));
    } catch (err) {
      console.error('Update package error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
