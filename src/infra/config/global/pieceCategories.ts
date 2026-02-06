/**
 * Piece categories file management.
 *
 * The categories file (~/.takt/preferences/piece-categories.yaml) uses the same
 * format as the builtin piece-categories.yaml (piece_categories key).
 * If the file doesn't exist, it's auto-copied from builtin defaults.
 */

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getGlobalConfigDir } from '../paths.js';
import { loadGlobalConfig } from './globalConfig.js';

function getDefaultPieceCategoriesPath(): string {
  return join(getGlobalConfigDir(), 'preferences', 'piece-categories.yaml');
}

/** Get the path to the user's piece categories file. */
export function getPieceCategoriesPath(): string {
  try {
    const config = loadGlobalConfig();
    if (config.pieceCategoriesFile) {
      return config.pieceCategoriesFile;
    }
  } catch {
    // Ignore errors, use default
  }
  return getDefaultPieceCategoriesPath();
}

/**
 * Ensure user categories file exists by copying from builtin defaults.
 * Returns the path to the user categories file.
 */
export function ensureUserCategoriesFile(defaultCategoriesPath: string): string {
  const userPath = getPieceCategoriesPath();
  if (existsSync(userPath)) {
    return userPath;
  }

  if (!existsSync(defaultCategoriesPath)) {
    throw new Error(`Default categories file not found: ${defaultCategoriesPath}`);
  }

  const dir = dirname(userPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  copyFileSync(defaultCategoriesPath, userPath);
  return userPath;
}

/**
 * Reset user categories file by overwriting with builtin defaults.
 */
export function resetPieceCategories(defaultCategoriesPath: string): void {
  if (!existsSync(defaultCategoriesPath)) {
    throw new Error(`Default categories file not found: ${defaultCategoriesPath}`);
  }

  const userPath = getPieceCategoriesPath();
  const dir = dirname(userPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  copyFileSync(defaultCategoriesPath, userPath);
}
