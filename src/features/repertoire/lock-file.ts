/**
 * Lock file generation and parsing for repertoire packages.
 *
 * The .takt-repertoire-lock.yaml records the installation provenance:
 *   source:      github:{owner}/{repo}
 *   ref:         tag or branch (defaults to "HEAD")
 *   commit:      full SHA from tarball directory name
 *   imported_at: ISO 8601 timestamp
 */

import { parse as parseYaml } from 'yaml';

export interface PackageLock {
  source: string;
  ref: string;
  commit: string;
  imported_at: string;
}

interface GenerateLockFileParams {
  source: string;
  ref: string | undefined;
  commitSha: string;
  importedAt: Date;
}

/**
 * Extract the commit SHA from a GitHub tarball directory name.
 *
 * GitHub tarball directories follow the format: {owner}-{repo}-{sha}
 * The SHA is always the last hyphen-separated segment.
 *
 * @param dirName - directory name without trailing slash
 */
export function extractCommitSha(dirName: string): string {
  const parts = dirName.split('-');
  const sha = parts[parts.length - 1];
  if (!sha) {
    throw new Error(`Cannot extract commit SHA from directory name: "${dirName}"`);
  }
  return sha;
}

/**
 * Generate a PackageLock object from installation parameters.
 *
 * @param params.source     - e.g. "github:nrslib/takt-fullstack"
 * @param params.ref        - tag, branch, or undefined (defaults to "HEAD")
 * @param params.commitSha  - full commit SHA from tarball directory
 * @param params.importedAt - installation timestamp
 */
export function generateLockFile(params: GenerateLockFileParams): PackageLock {
  return {
    source: params.source,
    ref: params.ref ?? 'HEAD',
    commit: params.commitSha,
    imported_at: params.importedAt.toISOString(),
  };
}

/**
 * Parse .takt-repertoire-lock.yaml content into a PackageLock object.
 * Returns empty-valued lock when yaml is empty (lock file missing).
 */
export function parseLockFile(yaml: string): PackageLock {
  const rawOrNull = (yaml.trim() ? parseYaml(yaml) : null) as Record<string, unknown> | null;
  const raw = rawOrNull ?? {};
  return {
    source: String(raw['source'] ?? ''),
    ref: String(raw['ref'] ?? 'HEAD'),
    commit: String(raw['commit'] ?? ''),
    imported_at: String(raw['imported_at'] ?? ''),
  };
}
