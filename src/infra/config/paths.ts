/**
 * Path utilities for takt configuration
 *
 * This module provides pure path utilities without UI dependencies.
 * For initialization with language selection, use initialization.ts.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { Language } from '../../core/models/index.js';
import { getLanguageResourcesDir } from '../resources/index.js';

/** Facet types used in layer resolution */
export type FacetType = 'personas' | 'policies' | 'knowledge' | 'instructions' | 'output-contracts';

/** Get takt global config directory (~/.takt or TAKT_CONFIG_DIR) */
export function getGlobalConfigDir(): string {
  return process.env.TAKT_CONFIG_DIR || join(homedir(), '.takt');
}

/** Get takt global personas directory (~/.takt/personas) */
export function getGlobalPersonasDir(): string {
  return join(getGlobalConfigDir(), 'personas');
}

/** Get takt global pieces directory (~/.takt/pieces) */
export function getGlobalPiecesDir(): string {
  return join(getGlobalConfigDir(), 'pieces');
}

/** Get takt global logs directory */
export function getGlobalLogsDir(): string {
  return join(getGlobalConfigDir(), 'logs');
}

/** Get takt global config file path */
export function getGlobalConfigPath(): string {
  return join(getGlobalConfigDir(), 'config.yaml');
}

/** Get builtin pieces directory (builtins/{lang}/pieces) */
export function getBuiltinPiecesDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'pieces');
}

/** Get builtin personas directory (builtins/{lang}/personas) */
export function getBuiltinPersonasDir(lang: Language): string {
  return join(getLanguageResourcesDir(lang), 'personas');
}

/** Get project takt config directory (.takt in project) */
export function getProjectConfigDir(projectDir: string): string {
  return join(resolve(projectDir), '.takt');
}

/** Get project pieces directory (.takt/pieces in project) */
export function getProjectPiecesDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'pieces');
}

/** Get project config file path */
export function getProjectConfigPath(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'config.yaml');
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

/** Get project facet directory (.takt/{facetType} in project) */
export function getProjectFacetDir(projectDir: string, facetType: FacetType): string {
  return join(getProjectConfigDir(projectDir), facetType);
}

/** Get global facet directory (~/.takt/{facetType}) */
export function getGlobalFacetDir(facetType: FacetType): string {
  return join(getGlobalConfigDir(), facetType);
}

/** Get builtin facet directory (builtins/{lang}/{facetType}) */
export function getBuiltinFacetDir(lang: Language, facetType: FacetType): string {
  return join(getLanguageResourcesDir(lang), facetType);
}

/** Validate path is safe (no directory traversal) */
export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = resolve(basePath);
  const resolvedTarget = resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase);
}

// Re-export project config functions
export {
  loadProjectConfig,
  saveProjectConfig,
  updateProjectConfig,
  getCurrentPiece,
  setCurrentPiece,
  isVerboseMode,
  type ProjectLocalConfig,
} from './project/projectConfig.js';

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
