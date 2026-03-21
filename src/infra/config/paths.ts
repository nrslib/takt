/**
 * Path utilities for takt configuration
 *
 * This module provides pure path utilities without UI dependencies.
 * For initialization with language selection, use initialization.ts.
 */

import { isAbsolute, join, relative, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { Language } from '../../core/models/index.js';
import { getLanguageResourcesDir } from '../resources/index.js';

import type { FacetKind } from 'faceted-prompting';
import {
  getProjectConfigDir as resolveProjectConfigDir,
  getProjectConfigPath as resolveProjectConfigPath,
} from './project/projectConfigPaths.js';
import {
  getRepertoireDir,
} from './global/globalConfigPaths.js';

/** Facet types used in layer resolution */
export type { FacetKind as FacetType } from 'faceted-prompting';
export {
  getGlobalConfigDir,
  getGlobalConfigPath,
  getGlobalFacetDir,
  getGlobalLogsDir,
  getGlobalPersonasDir,
  getGlobalPiecesDir,
  getRepertoireDir,
  getRepertoirePackageDir,
} from './global/globalConfigPaths.js';

type FacetType = FacetKind;

/** Get builtin pieces directory (builtins/{lang}/pieces) */
export function getBuiltinPiecesDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'pieces');
}

/** Get builtin personas directory (builtins/{lang}/facets/personas) */
export function getBuiltinPersonasDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'facets', 'personas');
}

/** Get project takt config directory (.takt in project) */
export function getProjectConfigDir(projectDir: string): string {
  return resolveProjectConfigDir(projectDir);
}

/** Get project pieces directory (.takt/pieces in project) */
export function getProjectPiecesDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'pieces');
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

/** Get builtin facet directory (builtins/{lang}/facets/{facetType}) */
export function getBuiltinFacetDir(lang: Language, facetType: FacetType): string {
  return join(getLanguageResourcesDir(lang), 'facets', facetType);
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
  const resolvedBase = resolve(basePath);
  const resolvedTarget = resolve(targetPath);
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
