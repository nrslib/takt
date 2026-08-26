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
import { LanguageSchema } from '../../core/models/schema-base.js';
import { getLanguageResourcesDir, getResourcesDir } from '../resources/index.js';

import type { FacetKind } from 'faceted-prompting';
import { REPERTOIRE_DIR_NAME } from './constants.js';
import {
  getProjectConfigDir as resolveProjectConfigDir,
  getProjectConfigPath as resolveProjectConfigPath,
} from './project/projectConfigPaths.js';

/** Facet types used in layer resolution */
export type { FacetKind as FacetType } from 'faceted-prompting';

type FacetType = FacetKind;

let globalConfigDirOverride: string | undefined;

/** Run a synchronous historical-source load without consulting current global config. */
export function withGlobalConfigDirOverride<T>(configDir: string, action: () => T): T {
  if (globalConfigDirOverride !== undefined) {
    throw new Error('Nested global config directory overrides are not supported');
  }
  globalConfigDirOverride = configDir;
  try {
    return action();
  } finally {
    globalConfigDirOverride = undefined;
  }
}

/** Get takt global config directory (~/.takt or TAKT_CONFIG_DIR) */
export function getGlobalConfigDir(): string {
  if (globalConfigDirOverride !== undefined) return globalConfigDirOverride;
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

/** Get takt global schemas directory (~/.takt/schemas) */
export function getGlobalSchemasDir(): string {
  return join(getGlobalConfigDir(), 'schemas');
}

export function getGlobalProviderOptionsDir(): string {
  return join(getGlobalConfigDir(), 'provider-options');
}

export function getGlobalStepsDir(): string {
  return join(getGlobalConfigDir(), 'steps');
}

export function getGlobalCompanionsDir(): string {
  return join(getGlobalConfigDir(), 'companions');
}

/** Get takt global facet-pools directory (~/.takt/facet-pools) */
export function getGlobalFacetPoolsDir(): string {
  return join(getGlobalConfigDir(), 'facet-pools');
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

export function getBuiltinProviderOptionsDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'provider-options');
}

export function getBuiltinLanguageStepsDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'steps');
}

/** Legacy shared step-fragment root used before fragments became language-scoped. */
export function getBuiltinSharedStepsDir(): string {
  return join(getResourcesDir(), 'steps');
}

/** Get builtin language-scoped facet-pools directory (builtins/{lang}/facet-pools) */
export function getBuiltinLanguageFacetPoolsDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'facet-pools');
}

/** Get builtin language resources root (builtins/{lang}). Facet-pool owned facets live under builtins/{lang}/facets/, outside facet-pools/. */
export function getBuiltinLanguageResourcesDir(lang: Language): string {
  return getLanguageResourcesDir(lang);
}

export function getBuiltinCompanionsDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'companions');
}

/** Get builtin shared facet-pools directory (builtins/facet-pools) */
export function getBuiltinSharedFacetPoolsDir(): string {
  return join(getResourcesDir(), 'facet-pools');
}

export function isBuiltinWorkflowPath(filePath: string): boolean {
  const resolvedFilePath = resolve(filePath);
  return LanguageSchema.options.some((lang) => isPathSafe(getBuiltinWorkflowsDir(lang), resolvedFilePath));
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

/** Get project schemas directory (.takt/schemas in project) */
export function getProjectSchemasDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'schemas');
}

export function getProjectProviderOptionsDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'provider-options');
}

export function getProjectStepsDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'steps');
}

export function getProjectCompanionsDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'companions');
}

/** Get project facet-pools directory (.takt/facet-pools in project) */
export function getProjectFacetPoolsDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'facet-pools');
}

/** Get project config file path */
export function getProjectConfigPath(projectDir: string): string {
  return resolveProjectConfigPath(projectDir);
}

/** Return the resolved path when global and project configuration directories collide. */
export function getConfigDirCollision(projectDir: string): string | undefined {
  const resolvedGlobalConfigDir = resolvePathForComparison(getGlobalConfigDir());
  const resolvedProjectConfigDir = resolvePathForComparison(getProjectConfigDir(projectDir));

  return resolvedGlobalConfigDir === resolvedProjectConfigDir
    ? resolvedGlobalConfigDir
    : undefined;
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

export function getRepertoireProviderOptionsDir(owner: string, repo: string, repertoireDir?: string): string {
  const base = repertoireDir ?? getRepertoireDir();
  return join(base, `@${owner}`, repo, 'provider-options');
}

export function getRepertoireStepsDir(owner: string, repo: string, repertoireDir?: string): string {
  const base = repertoireDir ?? getRepertoireDir();
  return join(base, `@${owner}`, repo, 'steps');
}

/** Get repertoire facet-pools directory (~/.takt/repertoire/@{owner}/{repo}/facet-pools) */
export function getRepertoireFacetPoolsDir(owner: string, repo: string, repertoireDir?: string): string {
  const base = repertoireDir ?? getRepertoireDir();
  return join(base, `@${owner}`, repo, 'facet-pools');
}

/** Validate path is safe (no directory traversal) */
export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = resolvePathForComparison(basePath);
  const resolvedTarget = resolvePathForComparison(targetPath);
  const rel = relative(resolvedBase, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolvePathForComparison(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
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
