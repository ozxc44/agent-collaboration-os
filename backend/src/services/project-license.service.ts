import { Repository } from 'typeorm';
import { ProjectFile } from '../entities/project-file.entity';

export interface ProjectLicense {
  /** Lower-case SPDX-style license key (e.g. `mit`, `apache-2.0`). */
  key: string;
  /** Human-readable license name. */
  name: string;
  /** Project-relative path of the matched root license file. */
  path: string;
}

const ROOT_LICENSE_NAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
];

/** Maximum bytes of license text to inspect per file. */
const MAX_LICENSE_BYTES = 32768;

interface LicensePattern {
  key: string;
  name: string;
}

const KNOWN_LICENSES: Record<string, LicensePattern> = {
  mit: { key: 'mit', name: 'MIT License' },
  'apache-2.0': { key: 'apache-2.0', name: 'Apache License 2.0' },
  'gpl-3.0': { key: 'gpl-3.0', name: 'GNU General Public License v3.0' },
  'bsd-2-clause': { key: 'bsd-2-clause', name: 'BSD 2-Clause "Simplified" License' },
  'bsd-3-clause': { key: 'bsd-3-clause', name: 'BSD 3-Clause "New" or "Revised" License' },
  'mpl-2.0': { key: 'mpl-2.0', name: 'Mozilla Public License 2.0' },
};

/**
 * Identify a well-known open-source license from its text using local keyword
 * patterns only. This is intentionally heuristic and makes no compliance or
 * SPDX/OSI certification claims.
 */
function identifyLicense(text: string): LicensePattern | null {
  const normalized = text.slice(0, MAX_LICENSE_BYTES).toLowerCase();

  // MIT: top-level mention plus the classic grant sentence.
  if (
    normalized.includes('mit license') &&
    normalized.includes('permission is hereby granted')
  ) {
    return KNOWN_LICENSES.mit;
  }

  // Apache-2.0
  if (
    (normalized.includes('apache license') ||
      normalized.includes('apache software license')) &&
    (normalized.includes('version 2.0') ||
      normalized.includes('licenses/license-2.0'))
  ) {
    return KNOWN_LICENSES['apache-2.0'];
  }

  // GPL-3.0
  if (
    normalized.includes('gnu general public license') &&
    normalized.includes('version 3')
  ) {
    return KNOWN_LICENSES['gpl-3.0'];
  }

  // MPL-2.0
  if (
    normalized.includes('mozilla public license') &&
    normalized.includes('version 2.0')
  ) {
    return KNOWN_LICENSES['mpl-2.0'];
  }

  // BSD by explicit SPDX-style name.
  if (
    normalized.includes('bsd 2-clause') ||
    normalized.includes('simplified bsd license')
  ) {
    return KNOWN_LICENSES['bsd-2-clause'];
  }
  if (
    normalized.includes('bsd 3-clause') ||
    normalized.includes('new bsd license') ||
    normalized.includes('revised bsd license')
  ) {
    return KNOWN_LICENSES['bsd-3-clause'];
  }

  // BSD by standard license text when no SPDX name is present.
  if (normalized.includes('redistribution and use in source and binary forms')) {
    // Count numbered condition lines such as "1. Redistributions of source code".
    const conditionMatches = normalized.match(/\d+\.\s+redistributions of/g) ?? [];
    if (conditionMatches.length >= 3) {
      return KNOWN_LICENSES['bsd-3-clause'];
    }
    if (conditionMatches.length >= 2) {
      return KNOWN_LICENSES['bsd-2-clause'];
    }
  }

  return null;
}

/**
 * Detect a root-level project license file and identify its type using local
 * pattern matching. Only the allowed root file names are considered; nested
 * license files are ignored. The scan is bounded to avoid expensive reads of
 * very large files.
 *
 * Returns `null` when no recognizable root license exists.
 */
export async function detectProjectLicense(
  projectId: string,
  fileRepo: Repository<ProjectFile>,
): Promise<ProjectLicense | null> {
  const lowerNames = ROOT_LICENSE_NAMES.map((name) => name.toLowerCase());

  const rows = (await fileRepo
    .createQueryBuilder('file')
    .where('file.projectId = :projectId', { projectId })
    .andWhere('LOWER(file.path) IN (:...names)', { names: lowerNames })
    .select('file.id', 'id')
    .addSelect('file.path', 'path')
    .addSelect(`SUBSTR(file.content, 1, ${MAX_LICENSE_BYTES})`, 'content')
    .orderBy('file.path', 'ASC')
    .getRawMany()) as Array<{ id: string; path: string; content: string | null }>;

  for (const row of rows) {
    if (!row.content) continue;
    const matched = identifyLicense(row.content);
    if (matched) {
      return { key: matched.key, name: matched.name, path: row.path };
    }
  }

  return null;
}
