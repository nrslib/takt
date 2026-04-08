/**
 * Path utilities for takt configuration
 *
 * This module provides pure path utilities without UI dependencies.
 * For initialization with language selection, use initialization.ts.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import type { Language } from '../../core/models/index.js';
import { getLanguageResourcesDir } from '../resources/index.js';

import type { FacetKind } from 'faceted-prompting';
import { REPERTOIRE_DIR_NAME } from './constants.js';
import {
  getProjectConfigDir as resolveProjectConfigDir,
  getProjectConfigPath as resolveProjectConfigPath,
} from './project/projectConfigPaths.js';

/** Facet types used in layer resolution */
export type { FacetKind as FacetType } from 'faceted-prompting';

type FacetType = FacetKind;

/** Get takt global config directory (~/.takt or TAKT_CONFIG_DIR) */
export function getGlobalConfigDir(): string {
  return process.env.TAKT_CONFIG_DIR || join(homedir(), '.takt');
}

/** Get takt global personas directory (~/.takt/personas) */
export function getGlobalPersonasDir(): string {
  return join(getGlobalConfigDir(), 'personas');
}

/** Get takt global workflows directory (~/.takt/workflows) */
export function getGlobalWorkflowsDir(): string {
  return join(getGlobalConfigDir(), 'workflows');
}

/** Get takt global logs directory */
export function getGlobalLogsDir(): string {
  return join(getGlobalConfigDir(), 'logs');
}

/** Get takt global config file path */
export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), 'config.yaml');
}

/** Get builtin workflows directory (builtins/{lang}/workflows) */
export function getBuiltinWorkflowsDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'workflows');
}

/** Get builtin personas directory (builtins/{lang}/facets/personas) */
export function getBuiltinPersonasDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'facets', 'personas');
}

/** Get project takt config directory (.takt in project) */
export function getProjectConfigDir(projectDir: string): string {
  return resolveProjectConfigDir(projectDir);
}

/** Get project workflows directory (.takt/workflows in project) */
export function getProjectWorkflowsDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'workflows');
}

/** Get project config file path */
export function getProjectConfigPath(projectDir: string): string {
  return resolveProjectConfigPath(projectDir);
}

/** Get project tasks directory */
export function getProjectTasksDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'tasks');
}

/** Get project completed tasks directory */
export function getProjectCompletedDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'completed');
}

/** Get project logs directory */
export function getProjectLogsDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'logs');
}

/** Ensure a directory exists, create if not */
export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/** Get project facet directory (.takt/facets/{facetType} in project) */
export function getProjectFacetDir(projectDir: string, facetType: FacetType): string {
  return join(getProjectConfigDir(projectDir), 'facets', facetType);
}

/** Get global facet directory (~/.takt/facets/{facetType}) */
export function getGlobalFacetDir(facetType: FacetType): string {
  return join(getGlobalConfigDir(), 'facets', facetType);
}

/** Get builtin facet directory (builtins/{lang}/facets/{facetType}) */
export function getBuiltinFacetDir(lang: Language, facetType: FacetType): string {
  return join(getLanguageResourcesDir(lang), 'facets', facetType);
}

/** Get repertoire directory (~/.takt/repertoire/) */
export function getRepertoireDir(): string {
  return join(getGlobalConfigDir(), REPERTOIRE_DIR_NAME);
}

/** Get repertoire package directory (~/.takt/repertoire/@{owner}/{repo}/) */
export function getRepertoirePackageDir(owner: string, repo: string): string {
  return join(getRepertoireDir(), `@${owner}`, repo);
}

/**
 * Get repertoire facet directory.
 *
 * Defaults to the global repertoire dir when repertoireDir is not specified.
 * Pass repertoireDir explicitly when resolving facets within a custom repertoire root
 * (e.g. the package-local resolution layer).
 */
export function getRepertoireFacetDir(owner: string, repo: string, facetType: FacetType, repertoireDir?: string): string {
  const base = repertoireDir ?? getRepertoireDir();
  return join(base, `@${owner}`, repo, 'facets', facetType);
}

/** Validate path is safe (no directory traversal) */
export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = existsSync(basePath) ? realpathSync(basePath) : resolve(basePath);
  const resolvedTarget = existsSync(targetPath) ? realpathSync(targetPath) : resolve(targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Re-export project config functions
export {
  loadProjectConfig,
  saveProjectConfig,
  updateProjectConfig,
  type ProjectLocalConfig,
} from './project/projectConfig.js';
export {
  isVerboseMode,
} from './project/resolvedSettings.js';

// Re-export session storage functions
export {
  writeFileAtomic,
  getInputHistoryPath,
  MAX_INPUT_HISTORY,
  loadInputHistory,
  saveInputHistory,
  addToInputHistory,
  type PersonaSessionData,
  getPersonaSessionsPath,
  loadPersonaSessions,
  savePersonaSessions,
  updatePersonaSession,
  clearPersonaSessions,
  // Worktree sessions
  getWorktreeSessionsDir,
  encodeWorktreePath,
  getWorktreeSessionPath,
  loadWorktreeSessions,
  updateWorktreeSession,
} from './project/sessionStore.js';
