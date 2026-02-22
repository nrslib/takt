/**
 * Repertoire package removal helpers.
 *
 * Provides:
 * - findScopeReferences: scan YAML files for @scope references (for pre-removal warning)
 * - shouldRemoveOwnerDir: determine if the @owner directory should be deleted
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../../shared/utils/debug.js';

const log = createLogger('repertoire-remove');

export interface ScopeReference {
  /** Absolute path to the file containing the @scope reference. */
  filePath: string;
}

/**
 * Recursively scan a directory for YAML files containing the given @scope substring.
 */
function scanYamlFilesInDir(dir: string, scope: string, results: ScopeReference[]): void {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(filePath);
    } catch (err) {
      log.debug('Failed to stat file', { filePath, err });
      continue;
    }

    if (stats.isDirectory()) {
      scanYamlFilesInDir(filePath, scope, results);
      continue;
    }

    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      log.debug('Failed to read file', { filePath, err });
      continue;
    }

    if (content.includes(scope)) {
      results.push({ filePath });
    }
  }
}

/**
 * Configuration for scope reference scanning.
 *
 * Separates the two kinds of scan targets to enable precise control over
 * which paths are scanned, avoiding unintended paths from root-based derivation.
 */
export interface ScanConfig {
  /** Directories to recursively scan for YAML files containing the scope substring. */
  piecesDirs: string[];
  /** Individual YAML files to check for the scope substring (e.g. piece-categories.yaml). */
  categoriesFiles: string[];
}

/**
 * Find all files that reference a given @scope package.
 *
 * Scans the 3 spec-defined locations:
 * 1. piecesDirs entries recursively (e.g. ~/.takt/pieces, .takt/pieces)
 * 2. categoriesFiles entries individually (e.g. ~/.takt/preferences/piece-categories.yaml)
 *
 * @param scope  - e.g. "@nrslib/takt-fullstack"
 * @param config - explicit scan targets (piecesDirs + categoriesFiles)
 */
export function findScopeReferences(scope: string, config: ScanConfig): ScopeReference[] {
  const results: ScopeReference[] = [];

  for (const dir of config.piecesDirs) {
    scanYamlFilesInDir(dir, scope, results);
  }

  for (const filePath of config.categoriesFiles) {
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      if (content.includes(scope)) {
        results.push({ filePath });
      }
    } catch (err) {
      log.debug('Failed to read categories file', { filePath, err });
    }
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

  const remaining = readdirSync(ownerDir).filter((entry) => {
    if (entry === repoBeingRemoved) return false;
    const entryPath = join(ownerDir, entry);
    try {
      return statSync(entryPath).isDirectory();
    } catch (err) {
      log.debug('Failed to stat entry', { entryPath, err });
      return false;
    }
  });

  return remaining.length === 0;
}
