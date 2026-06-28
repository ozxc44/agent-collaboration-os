import { Router, Request, Response } from 'express';
import { FindOptionsWhere } from 'typeorm';
import { authenticate, extractProjectId } from '../middleware/auth';
import { requirePermission, Permission } from '../middleware/rbac';
import { AppDataSource } from '../data-source';
import { ProjectFile } from '../entities/project-file.entity';
import { ProjectSecurityAdvisory } from '../entities/project-security-advisory.entity';
import { ProjectAuditAction } from '../entities/project-audit-event.entity';
import { recordProjectModuleAudit } from '../services/project-audit.service';

const router = Router();
const advisoryRepo = AppDataSource.getRepository(ProjectSecurityAdvisory);

const ALLOWED_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const ALLOWED_STATUSES = new Set(['draft', 'published', 'resolved']);
const MAX_TITLE_LENGTH = 255;
const MAX_SLUG_LENGTH = 255;
const MAX_BODY_LENGTH = 1_000_000;
const MAX_REF_COUNT = 20;
const MAX_REF_LENGTH = 2048;

type HygieneSeverity = 'info' | 'low' | 'medium' | 'high';

type ManifestHygieneFinding = {
  rule_id: string;
  severity: HygieneSeverity;
  file_path: string;
  message: string;
  evidence?: string;
};

type LocalDependency = {
  name: string;
  version: string;
  section: string;
  file_path: string;
};

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

function normalizeOptionalString(raw: unknown, maxLength: number): string | null | false {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) return false;
  return trimmed;
}

function parseReferences(raw: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (!Array.isArray(raw)) return { ok: false, message: 'References must be an array of URLs' };
  if (raw.length > MAX_REF_COUNT) return { ok: false, message: `References must contain ${MAX_REF_COUNT} items or fewer` };
  const refs: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, message: 'References must contain only URLs' };
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_REF_LENGTH) return { ok: false, message: `Each reference must be ${MAX_REF_LENGTH} characters or fewer` };
    try {
      const url = new URL(trimmed);
      if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, message: 'References must be valid http(s) URLs' };
    } catch {
      return { ok: false, message: 'References must be valid http(s) URLs' };
    }
    refs.push(trimmed);
  }
  return { ok: true, value: refs.length ? JSON.stringify(refs) : null };
}

function decodeReferences(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function serializeAdvisory(advisory: ProjectSecurityAdvisory) {
  return {
    id: advisory.id,
    project_id: advisory.projectId,
    title: advisory.title,
    slug: advisory.slug,
    severity: advisory.severity,
    status: advisory.status,
    affected_package: advisory.affectedPackage,
    affected_version: advisory.affectedVersion,
    fixed_version: advisory.fixedVersion,
    cve_id: advisory.cveId,
    body: advisory.body,
    references: decodeReferences(advisory.references),
    created_by: advisory.createdBy,
    updated_by: advisory.updatedBy,
    created_at: advisory.createdAt,
    updated_at: advisory.updatedAt,
    published_at: advisory.publishedAt,
  };
}

function serializeAdvisorySummary(advisory: ProjectSecurityAdvisory) {
  return {
    id: advisory.id,
    project_id: advisory.projectId,
    title: advisory.title,
    slug: advisory.slug,
    severity: advisory.severity,
    status: advisory.status,
    affected_package: advisory.affectedPackage,
    cve_id: advisory.cveId,
    created_by: advisory.createdBy,
    updated_by: advisory.updatedBy,
    created_at: advisory.createdAt,
    updated_at: advisory.updatedAt,
    published_at: advisory.publishedAt,
  };
}

function dirname(projectPath: string): string {
  const idx = projectPath.lastIndexOf('/');
  return idx === -1 ? '' : projectPath.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function isPackageManifestPath(projectPath: string): boolean {
  return projectPath === 'package.json' || projectPath.endsWith('/package.json');
}

function isManifestHygienePath(projectPath: string): boolean {
  const name = projectPath.split('/').pop() || projectPath;
  return isPackageManifestPath(projectPath) || name === '.npmrc' || [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
  ].includes(name);
}

function dependencySections(pkg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const value = pkg[section];
    if (value && typeof value === 'object' && !Array.isArray(value)) result[section] = value;
  }
  return result;
}

function collectDependencies(filePath: string, pkg: Record<string, unknown>): LocalDependency[] {
  const deps: LocalDependency[] = [];
  const sections = dependencySections(pkg);
  for (const [section, sectionDeps] of Object.entries(sections)) {
    for (const [name, version] of Object.entries(sectionDeps as Record<string, unknown>)) {
      if (typeof version !== 'string') continue;
      deps.push({ name, version, section, file_path: filePath });
    }
  }
  return deps;
}

function hasDependencies(pkg: Record<string, unknown>): boolean {
  return Object.values(dependencySections(pkg)).some((section) => Object.keys(section as Record<string, unknown>).length > 0);
}

function isUnpinnedVersion(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value === '' || value === '*' || value === 'latest' || value === 'x';
}

function pushDependencyFindings(findings: ManifestHygieneFinding[], filePath: string, pkg: Record<string, unknown>): void {
  const sections = dependencySections(pkg);
  for (const [section, deps] of Object.entries(sections)) {
    for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
      if (!isUnpinnedVersion(version)) continue;
      findings.push({
        rule_id: 'manifest_unpinned_dependency',
        severity: 'medium',
        file_path: filePath,
        message: 'Dependency version should avoid wildcard or latest ranges in project manifests.',
        evidence: `${section}.${name}: ${String(version)}`,
      });
    }
  }
}

function pushScriptFindings(findings: ManifestHygieneFinding[], filePath: string, pkg: Record<string, unknown>): void {
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return;
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string' || !command.includes('http://')) continue;
    findings.push({
      rule_id: 'manifest_insecure_script_url',
      severity: 'medium',
      file_path: filePath,
      message: 'Package script references an insecure http URL.',
      evidence: `scripts.${name}`,
    });
  }
}

const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];

function isLockfilePath(projectPath: string): boolean {
  const name = projectPath.split('/').pop() || projectPath;
  return LOCKFILE_NAMES.includes(name);
}

function lockfilePackageManager(lockfilePath: string): string {
  const name = lockfilePath.split('/').pop() || lockfilePath;
  if (name === 'yarn.lock') return 'yarn';
  if (name === 'pnpm-lock.yaml') return 'pnpm';
  return 'npm';
}

type DependencySectionCounts = {
  dependencies: number;
  devDependencies: number;
  peerDependencies: number;
  optionalDependencies: number;
};

type ManifestAuditResult = {
  path: string;
  valid: boolean;
  parse_error: string | null;
  dependency_counts: DependencySectionCounts;
  lockfile_coverage: {
    has_lockfile: boolean;
    lockfile_path: string | null;
    package_manager: string | null;
  };
};

type AdvisoryMatch = {
  advisory_id: string;
  title: string;
  severity: string;
  status: string;
  affected_package: string;
};

function emptySectionCounts(): DependencySectionCounts {
  return {
    dependencies: 0,
    devDependencies: 0,
    peerDependencies: 0,
    optionalDependencies: 0,
  };
}

function countSection(pkg: Record<string, unknown>): DependencySectionCounts {
  const counts = emptySectionCounts();
  for (const section of Object.keys(counts) as (keyof DependencySectionCounts)[]) {
    const value = pkg[section];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      counts[section] = Object.keys(value as Record<string, unknown>).length;
    }
  }
  return counts;
}

function findSiblingLockfile(manifestPath: string, filePaths: Set<string>): { path: string; package_manager: string } | null {
  const dir = dirname(manifestPath);
  for (const name of LOCKFILE_NAMES) {
    const candidate = joinPath(dir, name);
    if (filePaths.has(candidate)) {
      return { path: candidate, package_manager: lockfilePackageManager(candidate) };
    }
  }
  return null;
}

function auditDependencyFiles(files: ProjectFile[], advisories: ProjectSecurityAdvisory[]): {
  checked_files: string[];
  ecosystems: string[];
  package_managers: string[];
  dependency_counts: DependencySectionCounts;
  manifests: ManifestAuditResult[];
  lockfile_coverage: {
    total_manifests: number;
    manifests_with_lockfile: number;
    manifests_without_lockfile: number;
    lockfile_paths: string[];
  };
  known_advisory_matches: AdvisoryMatch[];
} {
  const checkedFiles = files
    .filter((file) => isPackageManifestPath(file.path) || isLockfilePath(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const filePathSet = new Set(checkedFiles.map((file) => file.path));
  const lockfilePaths = checkedFiles.filter((file) => isLockfilePath(file.path)).map((file) => file.path);

  const manifests: ManifestAuditResult[] = [];
  const aggregatedCounts = emptySectionCounts();
  const detectedPackageManagers = new Set<string>();
  const directDependencyNames = new Set<string>();

  for (const file of checkedFiles) {
    if (!isPackageManifestPath(file.path)) continue;

    let pkg: Record<string, unknown>;
    let valid = true;
    let parseError: string | null = null;
    try {
      const parsed = JSON.parse(file.content || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('package.json root must be an object');
      }
      pkg = parsed as Record<string, unknown>;
    } catch (err) {
      valid = false;
      parseError = err instanceof Error ? err.message : 'invalid JSON';
      pkg = {};
    }

    if (valid) {
      const sections = dependencySections(pkg);
      for (const deps of Object.values(sections)) {
        for (const name of Object.keys(deps as Record<string, unknown>)) {
          directDependencyNames.add(name);
        }
      }
    }

    const counts = valid ? countSection(pkg) : emptySectionCounts();
    for (const section of Object.keys(counts) as (keyof DependencySectionCounts)[]) {
      aggregatedCounts[section] += counts[section];
    }

    const lockfile = findSiblingLockfile(file.path, filePathSet);
    if (lockfile) detectedPackageManagers.add(lockfile.package_manager);

    manifests.push({
      path: file.path,
      valid,
      parse_error: parseError,
      dependency_counts: counts,
      lockfile_coverage: {
        has_lockfile: !!lockfile,
        lockfile_path: lockfile?.path ?? null,
        package_manager: lockfile?.package_manager ?? null,
      },
    });
  }

  const manifestsWithLockfile = manifests.filter((m) => m.lockfile_coverage.has_lockfile).length;

  const advisoryByPackage = new Map<string, AdvisoryMatch[]>();
  for (const advisory of advisories) {
    if (!advisory.affectedPackage) continue;
    const matches = advisoryByPackage.get(advisory.affectedPackage) ?? [];
    matches.push({
      advisory_id: advisory.id,
      title: advisory.title,
      severity: advisory.severity,
      status: advisory.status,
      affected_package: advisory.affectedPackage,
    });
    advisoryByPackage.set(advisory.affectedPackage, matches);
  }

  const knownAdvisoryMatches: AdvisoryMatch[] = [];
  for (const name of directDependencyNames) {
    const matches = advisoryByPackage.get(name);
    if (matches) knownAdvisoryMatches.push(...matches);
  }
  knownAdvisoryMatches.sort((a, b) => a.advisory_id.localeCompare(b.advisory_id));

  return {
    checked_files: checkedFiles.map((file) => file.path),
    ecosystems: ['npm'],
    package_managers: Array.from(detectedPackageManagers).sort(),
    dependency_counts: aggregatedCounts,
    manifests,
    lockfile_coverage: {
      total_manifests: manifests.length,
      manifests_with_lockfile: manifestsWithLockfile,
      manifests_without_lockfile: manifests.length - manifestsWithLockfile,
      lockfile_paths: lockfilePaths,
    },
    known_advisory_matches: knownAdvisoryMatches,
  };
}

function scanManifestFiles(files: ProjectFile[]): {
  checked_files: string[];
  finding_count: number;
  findings: ManifestHygieneFinding[];
} {
  const manifestFiles = files.filter((file) => isManifestHygienePath(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  const pathSet = new Set(manifestFiles.map((file) => file.path));
  const findings: ManifestHygieneFinding[] = [];

  if (manifestFiles.length === 0) {
    findings.push({
      rule_id: 'manifest_not_found',
      severity: 'info',
      file_path: '',
      message: 'No package manifest, lockfile, or npm configuration file was found in stored project files.',
    });
  }

  for (const file of manifestFiles) {
    if (isPackageManifestPath(file.path)) {
      let pkg: Record<string, unknown>;
      try {
        const parsed = JSON.parse(file.content || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package.json root must be an object');
        pkg = parsed as Record<string, unknown>;
      } catch (err) {
        findings.push({
          rule_id: 'manifest_json_invalid',
          severity: 'high',
          file_path: file.path,
          message: 'package.json could not be parsed as a JSON object.',
          evidence: err instanceof Error ? err.message : 'invalid JSON',
        });
        continue;
      }

      const dir = dirname(file.path);
      const hasLocalLockfile = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']
        .some((name) => pathSet.has(joinPath(dir, name)));
      if (hasDependencies(pkg) && !hasLocalLockfile) {
        findings.push({
          rule_id: 'manifest_missing_lockfile',
          severity: 'medium',
          file_path: file.path,
          message: 'package.json declares dependencies but no lockfile was found in the same directory.',
        });
      }

      pushDependencyFindings(findings, file.path, pkg);
      pushScriptFindings(findings, file.path, pkg);
    }

    if ((file.path.split('/').pop() || '') === '.npmrc' && (file.content || '').includes('http://')) {
      findings.push({
        rule_id: 'manifest_insecure_registry',
        severity: 'high',
        file_path: file.path,
        message: '.npmrc contains an insecure http URL.',
        evidence: '.npmrc contains http://',
      });
    }
  }

  return {
    checked_files: manifestFiles.map((file) => file.path),
    finding_count: findings.length,
    findings,
  };
}

function lockfileType(projectPath: string): string | null {
  const name = projectPath.split('/').pop() || projectPath;
  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') return 'npm';
  if (name === 'yarn.lock') return 'yarn';
  if (name === 'pnpm-lock.yaml') return 'pnpm';
  return null;
}

function scanLocalDependencyAudit(files: ProjectFile[], advisories: ProjectSecurityAdvisory[]) {
  const packageFiles = files.filter((file) => isPackageManifestPath(file.path)).sort((a, b) => a.path.localeCompare(b.path));
  const lockfiles = files
    .map((file) => ({ file, type: lockfileType(file.path) }))
    .filter((entry): entry is { file: ProjectFile; type: string } => !!entry.type)
    .sort((a, b) => a.file.path.localeCompare(b.file.path));
  const lockfilePaths = new Set(lockfiles.map((entry) => entry.file.path));
  const dependencies: LocalDependency[] = [];
  const invalidManifests: { file_path: string; message: string }[] = [];
  const manifests = packageFiles.map((file) => {
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(file.content || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package.json root must be an object');
      parsed = value as Record<string, unknown>;
      dependencies.push(...collectDependencies(file.path, parsed));
    } catch (err) {
      invalidManifests.push({
        file_path: file.path,
        message: err instanceof Error ? err.message : 'invalid JSON',
      });
    }
    const dir = dirname(file.path);
    const localLockfiles = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']
      .map((name) => joinPath(dir, name))
      .filter((candidate) => lockfilePaths.has(candidate));
    return {
      file_path: file.path,
      valid: !!parsed,
      dependency_count: parsed ? collectDependencies(file.path, parsed).length : 0,
      lockfiles: localLockfiles,
    };
  });
  const countsBySection = dependencies.reduce<Record<string, number>>((acc, dep) => {
    acc[dep.section] = (acc[dep.section] || 0) + 1;
    return acc;
  }, {});
  const directNames = new Set(dependencies.map((dep) => dep.name.toLowerCase()));
  const advisoryMatches = advisories
    .filter((advisory) => advisory.affectedPackage && directNames.has(advisory.affectedPackage.toLowerCase()))
    .sort((a, b) => {
      const packageCompare = (a.affectedPackage || '').localeCompare(b.affectedPackage || '');
      if (packageCompare !== 0) return packageCompare;
      return a.updatedAt > b.updatedAt ? -1 : 1;
    })
    .map((advisory) => ({
      advisory_id: advisory.id,
      title: advisory.title,
      severity: advisory.severity,
      status: advisory.status,
      affected_package: advisory.affectedPackage,
      cve_id: advisory.cveId,
      updated_at: advisory.updatedAt,
    }));

  return {
    checked_files: [
      ...packageFiles.map((file) => file.path),
      ...lockfiles.map((entry) => entry.file.path),
    ],
    package_managers: Array.from(new Set(lockfiles.map((entry) => entry.type))).sort(),
    manifest_count: packageFiles.length,
    lockfile_count: lockfiles.length,
    dependency_count: dependencies.length,
    dependency_counts_by_section: countsBySection,
    manifests,
    lockfiles: lockfiles.map((entry) => ({ file_path: entry.file.path, type: entry.type })),
    invalid_manifests: invalidManifests,
    known_advisory_matches: advisoryMatches,
    limitations: [
      'Local dependency audit uses stored project files only.',
      'No external vulnerability database, package registry, npm audit, installation, or auto-fix is executed.',
      'Advisory matches are limited to project-authored security advisories whose affected_package exactly matches a direct dependency name.',
      'Transitive dependency completeness is not claimed unless represented by stored lockfile metadata in a later implementation.',
    ],
  };
}

function validateQueryEnum(raw: unknown, allowed: Set<string>, field: string, values: string[], res: Response): string | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !allowed.has(raw)) {
    res.status(422).json({ detail: [{ loc: ['query', field], msg: `${field} must be ${values.join(', ')}`, type: 'invalid' }] });
    return null;
  }
  return raw;
}

router.get(
  '/v1/projects/:project_id/security-advisories',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const rawSkip = req.query.skip as string | undefined;
      const rawLimit = req.query.limit as string | undefined;
      const skip = rawSkip === undefined ? 0 : parseInt(rawSkip, 10);
      const limit = rawLimit === undefined ? 50 : parseInt(rawLimit, 10);
      if (!Number.isInteger(skip) || skip < 0) {
        res.status(422).json({ detail: [{ loc: ['query', 'skip'], msg: 'skip must be a non-negative integer', type: 'invalid' }] });
        return;
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        res.status(422).json({ detail: [{ loc: ['query', 'limit'], msg: 'limit must be between 1 and 100', type: 'invalid' }] });
        return;
      }
      const severity = validateQueryEnum(req.query.severity, ALLOWED_SEVERITIES, 'severity', Array.from(ALLOWED_SEVERITIES), res);
      if (severity === null) return;
      const status = validateQueryEnum(req.query.status, ALLOWED_STATUSES, 'status', Array.from(ALLOWED_STATUSES), res);
      if (status === null) return;
      const where: FindOptionsWhere<ProjectSecurityAdvisory> = { projectId };
      if (severity) where.severity = severity;
      if (status) where.status = status;

      const [advisories, total] = await advisoryRepo.findAndCount({
        where,
        order: { updatedAt: 'DESC' },
        skip,
        take: limit,
      });

      res.json({ data: advisories.map(serializeAdvisorySummary), meta: { total, skip, limit } });
    } catch (err) {
      console.error('List security advisories error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/security-advisories/:advisory_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const advisory = await advisoryRepo.findOne({
        where: { id: req.params.advisory_id, projectId: req.params.project_id },
      });
      if (!advisory) {
        res.status(404).json({ detail: 'Security advisory not found' });
        return;
      }
      res.json(serializeAdvisory(advisory));
    } catch (err) {
      console.error('Get security advisory error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/security-advisories',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const userId = req.user!.userId;
      const { title, slug, severity, status, affected_package, affected_version, fixed_version, cve_id, body, references } = req.body;

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        res.status(422).json({ detail: [{ loc: ['body', 'title'], msg: 'Title is required', type: 'missing' }] });
        return;
      }
      if (title.length > MAX_TITLE_LENGTH) {
        res.status(422).json({ detail: [{ loc: ['body', 'title'], msg: `Title must be ${MAX_TITLE_LENGTH} characters or fewer`, type: 'too_long' }] });
        return;
      }

      const normalizedSlug = slugify(typeof slug === 'string' && slug.trim() ? slug : title);
      if (!normalizedSlug) {
        res.status(422).json({ detail: [{ loc: ['body', 'slug'], msg: 'Slug must contain at least one alphanumeric character', type: 'invalid' }] });
        return;
      }

      const normalizedSeverity = severity === undefined ? 'medium' : severity;
      if (typeof normalizedSeverity !== 'string' || !ALLOWED_SEVERITIES.has(normalizedSeverity)) {
        res.status(422).json({ detail: [{ loc: ['body', 'severity'], msg: 'Severity must be low, medium, high, or critical', type: 'invalid' }] });
        return;
      }

      const normalizedStatus = status === undefined ? 'draft' : status;
      if (typeof normalizedStatus !== 'string' || !ALLOWED_STATUSES.has(normalizedStatus)) {
        res.status(422).json({ detail: [{ loc: ['body', 'status'], msg: 'Status must be draft, published, or resolved', type: 'invalid' }] });
        return;
      }

      const advisoryBody = body === undefined ? '' : body;
      if (typeof advisoryBody !== 'string') {
        res.status(422).json({ detail: [{ loc: ['body', 'body'], msg: 'Body must be a string', type: 'invalid' }] });
        return;
      }
      if (advisoryBody.length > MAX_BODY_LENGTH) {
        res.status(422).json({ detail: [{ loc: ['body', 'body'], msg: `Body must be ${MAX_BODY_LENGTH} characters or fewer`, type: 'too_long' }] });
        return;
      }

      const affectedPackage = normalizeOptionalString(affected_package, 255);
      const affectedVersion = normalizeOptionalString(affected_version, 255);
      const fixedVersion = normalizeOptionalString(fixed_version, 255);
      const cveId = normalizeOptionalString(cve_id, 64);
      if (affectedPackage === false || affectedVersion === false || fixedVersion === false || cveId === false) {
        res.status(422).json({ detail: [{ loc: ['body'], msg: 'Optional security fields must be strings within length limits', type: 'invalid' }] });
        return;
      }

      const parsedReferences = parseReferences(references);
      if (!parsedReferences.ok) {
        res.status(422).json({ detail: [{ loc: ['body', 'references'], msg: parsedReferences.message, type: 'invalid' }] });
        return;
      }

      const existing = await advisoryRepo.findOne({ where: { projectId, slug: normalizedSlug } });
      if (existing) {
        res.status(409).json({ detail: 'A security advisory with this slug already exists' });
        return;
      }

      const advisory = advisoryRepo.create({
        projectId,
        title: title.trim(),
        slug: normalizedSlug,
        severity: normalizedSeverity,
        status: normalizedStatus,
        affectedPackage,
        affectedVersion,
        fixedVersion,
        cveId,
        body: advisoryBody,
        references: parsedReferences.value,
        createdBy: userId,
        updatedBy: userId,
        publishedAt: normalizedStatus === 'draft' ? null : new Date(),
      });
      await advisoryRepo.save(advisory);

      await recordProjectModuleAudit(
        projectId,
        userId,
        ProjectAuditAction.SECURITY_ADVISORY_CREATED,
        { type: 'security_advisory', id: advisory.id, name: advisory.title },
        {
          slug: advisory.slug,
          severity: advisory.severity,
          status: advisory.status,
          affected_package: advisory.affectedPackage,
          cve_id: advisory.cveId,
          reference_count: decodeReferences(advisory.references).length,
        },
      ).catch((err) => console.error('Failed to record security_advisory_created audit:', err));

      res.status(201).json(serializeAdvisory(advisory));
    } catch (err) {
      console.error('Create security advisory error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.patch(
  '/v1/projects/:project_id/security-advisories/:advisory_id',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const advisoryId = req.params.advisory_id;
      const userId = req.user!.userId;
      const advisory = await advisoryRepo.findOne({ where: { id: advisoryId, projectId } });
      if (!advisory) {
        res.status(404).json({ detail: 'Security advisory not found' });
        return;
      }

      const before = {
        title: advisory.title,
        slug: advisory.slug,
        severity: advisory.severity,
        status: advisory.status,
        affectedPackage: advisory.affectedPackage,
        affectedVersion: advisory.affectedVersion,
        fixedVersion: advisory.fixedVersion,
        cveId: advisory.cveId,
      };

      const { title, slug, severity, status, affected_package, affected_version, fixed_version, cve_id, body, references } = req.body;
      let nextSlug = advisory.slug;

      if (title !== undefined) {
        if (typeof title !== 'string' || title.trim().length === 0) {
          res.status(422).json({ detail: [{ loc: ['body', 'title'], msg: 'Title must be a non-empty string', type: 'invalid' }] });
          return;
        }
        if (title.length > MAX_TITLE_LENGTH) {
          res.status(422).json({ detail: [{ loc: ['body', 'title'], msg: `Title must be ${MAX_TITLE_LENGTH} characters or fewer`, type: 'too_long' }] });
          return;
        }
        advisory.title = title.trim();
      }

      if (slug !== undefined) {
        if (typeof slug !== 'string' || slug.trim().length === 0) {
          res.status(422).json({ detail: [{ loc: ['body', 'slug'], msg: 'Slug must be a non-empty string', type: 'invalid' }] });
          return;
        }
        nextSlug = slugify(slug);
        if (!nextSlug) {
          res.status(422).json({ detail: [{ loc: ['body', 'slug'], msg: 'Slug must contain at least one alphanumeric character', type: 'invalid' }] });
          return;
        }
      }

      if (nextSlug !== advisory.slug) {
        const existing = await advisoryRepo.findOne({ where: { projectId, slug: nextSlug } });
        if (existing && existing.id !== advisoryId) {
          res.status(409).json({ detail: 'A security advisory with this slug already exists' });
          return;
        }
      }

      if (severity !== undefined) {
        if (typeof severity !== 'string' || !ALLOWED_SEVERITIES.has(severity)) {
          res.status(422).json({ detail: [{ loc: ['body', 'severity'], msg: 'Severity must be low, medium, high, or critical', type: 'invalid' }] });
          return;
        }
        advisory.severity = severity;
      }

      if (status !== undefined) {
        if (typeof status !== 'string' || !ALLOWED_STATUSES.has(status)) {
          res.status(422).json({ detail: [{ loc: ['body', 'status'], msg: 'Status must be draft, published, or resolved', type: 'invalid' }] });
          return;
        }
        advisory.status = status;
        if (status !== 'draft' && !advisory.publishedAt) advisory.publishedAt = new Date();
      }

      let bodyChanged = false;
      if (body !== undefined) {
        if (typeof body !== 'string') {
          res.status(422).json({ detail: [{ loc: ['body', 'body'], msg: 'Body must be a string', type: 'invalid' }] });
          return;
        }
        if (body.length > MAX_BODY_LENGTH) {
          res.status(422).json({ detail: [{ loc: ['body', 'body'], msg: `Body must be ${MAX_BODY_LENGTH} characters or fewer`, type: 'too_long' }] });
          return;
        }
        advisory.body = body;
        bodyChanged = true;
      }

      const optionalUpdates: [unknown, number, keyof ProjectSecurityAdvisory][] = [
        [affected_package, 255, 'affectedPackage'],
        [affected_version, 255, 'affectedVersion'],
        [fixed_version, 255, 'fixedVersion'],
        [cve_id, 64, 'cveId'],
      ];
      for (const [raw, max, field] of optionalUpdates) {
        if (raw !== undefined) {
          const value = normalizeOptionalString(raw, max);
          if (value === false) {
            res.status(422).json({ detail: [{ loc: ['body'], msg: 'Optional security fields must be strings within length limits', type: 'invalid' }] });
            return;
          }
          (advisory as any)[field] = value;
        }
      }

      let referencesChanged = false;
      if (references !== undefined) {
        const parsedReferences = parseReferences(references);
        if (!parsedReferences.ok) {
          res.status(422).json({ detail: [{ loc: ['body', 'references'], msg: parsedReferences.message, type: 'invalid' }] });
          return;
        }
        advisory.references = parsedReferences.value;
        referencesChanged = true;
      }

      advisory.slug = nextSlug;
      advisory.updatedBy = userId;
      await advisoryRepo.save(advisory);

      const changedFields: string[] = [];
      const metadata: Record<string, unknown> = {
        slug: advisory.slug,
        severity: advisory.severity,
        status: advisory.status,
        affected_package: advisory.affectedPackage,
        cve_id: advisory.cveId,
        reference_count: decodeReferences(advisory.references).length,
      };

      if (advisory.title !== before.title) {
        changedFields.push('title');
        metadata.previous_title = before.title;
        metadata.new_title = advisory.title;
      }
      if (advisory.slug !== before.slug) {
        changedFields.push('slug');
        metadata.previous_slug = before.slug;
        metadata.new_slug = advisory.slug;
      }
      if (advisory.severity !== before.severity) {
        changedFields.push('severity');
        metadata.previous_severity = before.severity;
        metadata.new_severity = advisory.severity;
      }
      if (advisory.status !== before.status) {
        changedFields.push('status');
        metadata.previous_status = before.status;
        metadata.new_status = advisory.status;
      }
      if (advisory.affectedPackage !== before.affectedPackage) {
        changedFields.push('affected_package');
        metadata.previous_affected_package = before.affectedPackage ?? null;
        metadata.new_affected_package = advisory.affectedPackage ?? null;
      }
      if (advisory.affectedVersion !== before.affectedVersion) {
        changedFields.push('affected_version');
        metadata.previous_affected_version = before.affectedVersion ?? null;
        metadata.new_affected_version = advisory.affectedVersion ?? null;
      }
      if (advisory.fixedVersion !== before.fixedVersion) {
        changedFields.push('fixed_version');
        metadata.previous_fixed_version = before.fixedVersion ?? null;
        metadata.new_fixed_version = advisory.fixedVersion ?? null;
      }
      if (advisory.cveId !== before.cveId) {
        changedFields.push('cve_id');
        metadata.previous_cve_id = before.cveId ?? null;
        metadata.new_cve_id = advisory.cveId ?? null;
      }
      if (bodyChanged) {
        changedFields.push('body');
      }
      if (referencesChanged) {
        changedFields.push('references');
      }

      if (changedFields.length > 0) {
        metadata.changed_fields = changedFields;
        await recordProjectModuleAudit(
          projectId,
          userId,
          ProjectAuditAction.SECURITY_ADVISORY_UPDATED,
          { type: 'security_advisory', id: advisory.id, name: advisory.title },
          metadata,
        ).catch((err) => console.error('Failed to record security_advisory_updated audit:', err));
      }

      res.json(serializeAdvisory(advisory));
    } catch (err) {
      console.error('Update security advisory error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.post(
  '/v1/projects/:project_id/security/manifest-hygiene-scan',
  authenticate,
  extractProjectId,
  requirePermission(Permission.EditProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const files = await AppDataSource.getRepository(ProjectFile).find({
        where: { projectId },
        order: { path: 'ASC' },
      });
      const scan = scanManifestFiles(files);
      res.json({
        scan_type: 'manifest_hygiene',
        is_vulnerability_scan: false,
        generated_at: new Date().toISOString(),
        ...scan,
      });
    } catch (err) {
      console.error('Run manifest hygiene scan error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

router.get(
  '/v1/projects/:project_id/security/dependency-audit',
  authenticate,
  extractProjectId,
  requirePermission(Permission.ViewProject),
  async (req: Request, res: Response) => {
    try {
      const projectId = req.params.project_id;
      const files = await AppDataSource.getRepository(ProjectFile).find({
        where: { projectId },
        order: { path: 'ASC' },
      });
      const advisories = await advisoryRepo.find({
        where: { projectId },
        order: { updatedAt: 'DESC' },
      });
      const audit = scanLocalDependencyAudit(files, advisories);
      res.json({
        audit_type: 'local_dependency_audit',
        is_external_vulnerability_scan: false,
        generated_at: new Date().toISOString(),
        ...audit,
      });
    } catch (err) {
      console.error('Get local dependency audit error:', err);
      res.status(500).json({ detail: 'Internal server error' });
    }
  },
);

export default router;
