/**
 * takt-package.yaml parsing and validation.
 *
 * Handles:
 * - YAML parsing with default values
 * - path field validation (no absolute paths, no directory traversal)
 * - min_version format validation (strict semver X.Y.Z)
 * - Numeric semver comparison
 * - Package content presence check (facets/ or pieces/ must exist)
 * - Realpath validation to prevent symlink-based traversal outside root
 */

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { TAKT_PACKAGE_MANIFEST_FILENAME } from './constants.js';

export interface TaktPackConfig {
  description?: string;
  path: string;
  takt?: {
    min_version?: string;
  };
}

interface PackageContentCheckContext {
  manifestPath?: string;
  configuredPath?: string;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Parse takt-package.yaml content string into a TaktPackConfig.
 * Applies default path "." when not specified.
 */
export function parseTaktPackConfig(yaml: string): TaktPackConfig {
  const raw = (yaml.trim() ? parseYaml(yaml) : {}) as Record<string, unknown> | null;
  const data = raw ?? {};

  const description = typeof data['description'] === 'string' ? data['description'] : undefined;
  const path = typeof data['path'] === 'string' ? data['path'] : '.';
  const taktRaw = data['takt'];
  const takt = taktRaw && typeof taktRaw === 'object' && !Array.isArray(taktRaw)
    ? { min_version: (taktRaw as Record<string, unknown>)['min_version'] as string | undefined }
    : undefined;

  return { description, path, takt };
}

/**
 * Validate that the path field is safe:
 * - Must not start with "/" (absolute path)
 * - Must not start with "~" (home-relative path)
 * - Must not contain ".." segments (directory traversal)
 *
 * Throws on validation failure.
 */
export function validateTaktPackPath(path: string): void {
  if (path.startsWith('/')) {
    throw new Error(`${TAKT_PACKAGE_MANIFEST_FILENAME}: path must not be absolute, got "${path}"`);
  }
  if (path.startsWith('~')) {
    throw new Error(`${TAKT_PACKAGE_MANIFEST_FILENAME}: path must not start with "~", got "${path}"`);
  }
  const segments = path.split('/');
  if (segments.includes('..')) {
    throw new Error(`${TAKT_PACKAGE_MANIFEST_FILENAME}: path must not contain ".." segments, got "${path}"`);
  }
}

/**
 * Validate min_version format: must match /^\d+\.\d+\.\d+$/ exactly.
 * Pre-release suffixes (e.g. "1.0.0-alpha") and "v" prefix are rejected.
 *
 * Throws on validation failure.
 */
export function validateMinVersion(version: string): void {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      `${TAKT_PACKAGE_MANIFEST_FILENAME}: takt.min_version must match X.Y.Z (no "v" prefix, no pre-release), got "${version}"`,
    );
  }
}

/**
 * Compare versions numerically.
 *
 * @param minVersion     - minimum required version (X.Y.Z)
 * @param currentVersion - current installed version (X.Y.Z)
 * @returns true if currentVersion >= minVersion
 */
export function isVersionCompatible(minVersion: string, currentVersion: string): boolean {
  const parseParts = (v: string): [number, number, number] => {
    const [major, minor, patch] = v.split('.').map(Number);
    return [major ?? 0, minor ?? 0, patch ?? 0];
  };

  const [minMajor, minMinor, minPatch] = parseParts(minVersion);
  const [curMajor, curMinor, curPatch] = parseParts(currentVersion);

  if (curMajor !== minMajor) return curMajor > minMajor;
  if (curMinor !== minMinor) return curMinor > minMinor;
  return curPatch >= minPatch;
}

/**
 * Check that the package root contains at least one of facets/ or pieces/.
 * Throws if neither exists (empty package).
 */
export function checkPackageHasContent(packageRoot: string): void {
  const hasFacets = existsSync(join(packageRoot, 'facets'));
  const hasPieces = existsSync(join(packageRoot, 'pieces'));
  if (!hasFacets && !hasPieces) {
    throw new Error(
      `Package at "${packageRoot}" has neither facets/ nor pieces/ directory — empty package rejected`,
    );
  }
}

/**
 * Check package content and include user-facing diagnostics when empty.
 *
 * Adds manifest/configured-path details and a practical hint for nested layouts
 * (e.g. when actual content is under ".takt/" but path remains ".").
 */
export function checkPackageHasContentWithContext(
  packageRoot: string,
  context: PackageContentCheckContext,
): void {
  const hasFacets = existsSync(join(packageRoot, 'facets'));
  const hasPieces = existsSync(join(packageRoot, 'pieces'));
  if (hasFacets || hasPieces) return;

  const checkedFacets = join(packageRoot, 'facets');
  const checkedPieces = join(packageRoot, 'pieces');
  const configuredPath = context.configuredPath ?? '.';
  const manifestPath = context.manifestPath ?? '(unknown)';
  const hint = configuredPath === '.'
    ? `hint: If your package content is under ".takt/", set "path: .takt" in ${TAKT_PACKAGE_MANIFEST_FILENAME}.`
    : `hint: Verify "path: ${configuredPath}" points to a directory containing facets/ or pieces/.`;

  throw new Error(
    [
      'Package content not found.',
      `manifest: ${manifestPath}`,
      `configured path: ${configuredPath}`,
      `resolved package root: ${packageRoot}`,
      `checked: ${checkedFacets}`,
      `checked: ${checkedPieces}`,
      hint,
    ].join('\n'),
  );
}

/**
 * Resolve the path to takt-package.yaml within an extracted tarball directory.
 *
 * Search order (first found wins):
 *   1. {extractDir}/.takt/takt-package.yaml
 *   2. {extractDir}/takt-package.yaml
 *
 * @param extractDir - root of the extracted tarball
 * @throws if neither candidate exists
 */
export function resolvePackConfigPath(extractDir: string): string {
  const taktDirPath = join(extractDir, '.takt', TAKT_PACKAGE_MANIFEST_FILENAME);
  if (existsSync(taktDirPath)) return taktDirPath;

  const rootPath = join(extractDir, TAKT_PACKAGE_MANIFEST_FILENAME);
  if (existsSync(rootPath)) return rootPath;

  throw new Error(
    `${TAKT_PACKAGE_MANIFEST_FILENAME} not found in "${extractDir}": checked .takt/${TAKT_PACKAGE_MANIFEST_FILENAME} and ${TAKT_PACKAGE_MANIFEST_FILENAME}`,
  );
}

/**
 * Validate that resolvedPath is inside (or equal to) repoRoot after realpath normalization.
 * This prevents symlink-based traversal that would escape the package root.
 *
 * @param resolvedPath - absolute path to validate (must exist)
 * @param repoRoot     - absolute path of the repository/package root
 * @throws if resolvedPath does not exist, or if it resolves outside repoRoot
 */
export function validateRealpathInsideRoot(resolvedPath: string, repoRoot: string): void {
  let realPath: string;
  try {
    realPath = realpathSync(resolvedPath);
  } catch {
    throw new Error(`Path "${resolvedPath}" does not exist or cannot be resolved`);
  }
  const realRoot = realpathSync(repoRoot);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + '/')) {
    throw new Error(
      `Security: path resolves to "${realPath}" which is outside the package root "${realRoot}"`,
    );
  }
}
