/** Helpers for scanning scoped repertoire references before package removal. */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isPathInside } from '../../shared/utils/pathBoundary.js';
import { isStepFragmentExtension } from './file-filter.js';

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function readDirectoryForReferenceScan(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    throw new Error(`Failed to read directory while scanning references: ${dir}`, { cause: error });
  }
}

function resolveDirectoryForReferenceScan(dir: string): string {
  try {
    return realpathSync(dir);
  } catch (error) {
    throw new Error(`Failed to resolve directory while scanning references: ${dir}`, { cause: error });
  }
}

function resolveStepDirectoryForReferenceScan(dir: string): string {
  try {
    return realpathSync(dir);
  } catch (error) {
    throw new Error(`Failed to resolve steps directory while scanning references: ${dir}`, { cause: error });
  }
}

function resolveStepFileForReferenceScan(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch (error) {
    throw new Error(`Failed to resolve step fragment while scanning references: ${filePath}`, { cause: error });
  }
}

export interface ScopeReference {
  /** Absolute path to the file containing the @scope reference. */
  filePath: string;
}

function scanYamlFilesInDir(
  dir: string,
  scope: string,
  results: ScopeReference[],
  visitedDirectories = new Set<string>(),
): void {
  let directoryStats: ReturnType<typeof statSync>;
  try {
    directoryStats = statSync(dir);
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw new Error(`Failed to inspect directory while scanning references: ${dir}`, { cause: err });
  }
  if (!directoryStats.isDirectory()) return;
  const realDir = resolveDirectoryForReferenceScan(dir);
  if (visitedDirectories.has(realDir)) return;
  visitedDirectories.add(realDir);

  for (const entry of readDirectoryForReferenceScan(dir)) {
    const filePath = join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(filePath);
    } catch (err) {
      throw new Error(`Failed to inspect YAML file while scanning references: ${filePath}`, { cause: err });
    }

    if (stats.isDirectory()) {
      scanYamlFilesInDir(filePath, scope, results, visitedDirectories);
      continue;
    }

    if (!isStepFragmentExtension(entry)) continue;

    addScopeReferenceIfPresent(filePath, scope, results, false);
  }
}

/** Scans direct step fragment files while rejecting links that escape the steps root. */
function scanStepFragmentFilesInDir(dir: string, scope: string, results: ScopeReference[]): void {
  let directoryStats: ReturnType<typeof statSync>;
  try {
    directoryStats = statSync(dir);
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw new Error(`Failed to inspect steps directory while scanning references: ${dir}`, { cause: err });
  }
  if (!directoryStats.isDirectory()) return;
  const realDir = resolveStepDirectoryForReferenceScan(dir);

  for (const entry of readDirectoryForReferenceScan(dir)) {
    if (!isStepFragmentExtension(entry)) continue;

    const filePath = join(dir, entry);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(filePath);
    } catch (err) {
      throw new Error(`Failed to inspect step fragment while scanning references: ${filePath}`, { cause: err });
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) continue;
    if (stats.isSymbolicLink()) {
      const realFilePath = resolveStepFileForReferenceScan(filePath);
      if (!isPathInside(realDir, realFilePath)) continue;
    }

    addScopeReferenceIfPresent(filePath, scope, results, false);
  }
}

function addScopeReferenceIfPresent(
  filePath: string,
  scope: string,
  results: ScopeReference[],
  allowNotFound: boolean,
): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (allowNotFound && isNotFoundError(err)) return;
    throw new Error(`Failed to read YAML file while scanning references: ${filePath}`, { cause: err });
  }
  if (containsScopeReference(content, scope)) {
    results.push({ filePath });
  }
}

function containsScopeReference(content: string, scope: string): boolean {
  const escapedScope = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escapedScope}(?=/|$|[^A-Za-z0-9._-])`, 'm').test(content);
}

export interface ScanConfig {
  /** Directories to recursively scan for workflow YAML files containing the scope substring. */
  workflowDirs: string[];
  /** Directories to recursively scan for provider_options YAML files containing the scope substring. */
  providerOptionsDirs: string[];
  /** Directories containing direct YAML step fragments to scan for the scope substring. */
  stepsDirs: string[];
  /** Individual YAML files to check for the scope substring (e.g. workflow-categories.yaml). */
  categoriesFiles: string[];
}

export function findScopeReferences(scope: string, config: ScanConfig): ScopeReference[] {
  const results: ScopeReference[] = [];
  const scannedDirs = new Set<string>();

  for (const dir of config.workflowDirs) {
    if (!scannedDirs.has(dir)) {
      scanYamlFilesInDir(dir, scope, results);
      scannedDirs.add(dir);
    }
  }

  for (const dir of config.providerOptionsDirs) {
    if (!scannedDirs.has(dir)) {
      scanYamlFilesInDir(dir, scope, results);
      scannedDirs.add(dir);
    }
  }

  for (const dir of config.stepsDirs) {
    if (!scannedDirs.has(dir)) {
      scanStepFragmentFilesInDir(dir, scope, results);
      scannedDirs.add(dir);
    }
  }

  for (const filePath of config.categoriesFiles) {
    addScopeReferenceIfPresent(filePath, scope, results, true);
  }

  return results;
}

/**
 * Determine whether the @owner directory can be removed after deleting a repo.
 *
 * Returns true if the owner directory would have no remaining subdirectories
 * once the given repo is removed.
 *
 * @param ownerDir         - absolute path to the @owner directory
 * @param repoBeingRemoved - repo name that will be deleted (excluded from check)
 */
export function shouldRemoveOwnerDir(ownerDir: string, repoBeingRemoved: string): boolean {
  if (!existsSync(ownerDir)) return false;

  const remaining = readDirectoryForReferenceScan(ownerDir).filter((entry) => {
    if (entry === repoBeingRemoved) return false;
    const entryPath = join(ownerDir, entry);
    try {
      return statSync(entryPath).isDirectory();
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw new Error(`Failed to inspect owner directory entry while scanning references: ${entryPath}`, { cause: error });
    }
  });

  return remaining.length === 0;
}
