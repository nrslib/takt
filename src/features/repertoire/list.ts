/**
 * Repertoire package listing.
 *
 * Scans the repertoire directory for installed packages and reads their
 * metadata (description, ref, truncated commit SHA) for display.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseTaktRepertoireConfig } from './takt-repertoire-config.js';
import { parseLockFile } from './lock-file.js';
import { TAKT_REPERTOIRE_MANIFEST_FILENAME, TAKT_REPERTOIRE_LOCK_FILENAME } from './constants.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const log = createLogger('repertoire-list');

export interface PackageInfo {
  /** e.g. "@nrslib/takt-fullstack" */
  scope: string;
  description?: string;
  ref: string;
  /** First 7 characters of the commit SHA. */
  commit: string;
}

/**
 * Read package metadata from a package directory.
 *
 * @param packageDir - absolute path to the package directory
 * @param scope      - e.g. "@nrslib/takt-fullstack"
 */
export function readPackageInfo(packageDir: string, scope: string): PackageInfo {
  const packConfigPath = join(packageDir, TAKT_REPERTOIRE_MANIFEST_FILENAME);
  const lockPath = join(packageDir, TAKT_REPERTOIRE_LOCK_FILENAME);

  const configYaml = existsSync(packConfigPath)
    ? readFileSync(packConfigPath, 'utf-8')
    : '';
  const config = parseTaktRepertoireConfig(configYaml);

  const lockYaml = existsSync(lockPath)
    ? readFileSync(lockPath, 'utf-8')
    : '';
  const lock = parseLockFile(lockYaml);

  return {
    scope,
    description: config.description,
    ref: lock.ref,
    commit: lock.commit.slice(0, 7),
  };
}

/**
 * List all installed packages under the repertoire directory.
 *
 * Directory structure:
 *   repertoireDir/
 *     @{owner}/
 *       {repo}/
 *         takt-repertoire.yaml
 *         .takt-repertoire-lock.yaml
 *
 * @param repertoireDir - absolute path to the repertoire root (~/.takt/repertoire)
 */
export function listPackages(repertoireDir: string): PackageInfo[] {
  if (!existsSync(repertoireDir)) return [];

  const packages: PackageInfo[] = [];

  for (const ownerEntry of readdirSync(repertoireDir)) {
    if (!ownerEntry.startsWith('@')) continue;
    const ownerDir = join(repertoireDir, ownerEntry);
    try { if (!statSync(ownerDir).isDirectory()) continue; } catch (e) { log.debug(`stat failed for ${ownerDir}: ${getErrorMessage(e)}`); continue; }

    for (const repoEntry of readdirSync(ownerDir)) {
      const packageDir = join(ownerDir, repoEntry);
      try { if (!statSync(packageDir).isDirectory()) continue; } catch (e) { log.debug(`stat failed for ${packageDir}: ${getErrorMessage(e)}`); continue; }
      const scope = `${ownerEntry}/${repoEntry}`;
      packages.push(readPackageInfo(packageDir, scope));
    }
  }

  return packages;
}
