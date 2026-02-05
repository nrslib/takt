/**
 * Session state management for TAKT
 *
 * Manages the last task execution state for interactive mode notification.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectConfigDir, ensureDir } from '../paths.js';
import { writeFileAtomic } from './sessionStore.js';

/** Last task execution state */
export interface SessionState {
  /** Task status */
  status: 'success' | 'error' | 'user_stopped';
  /** Task result summary (max 1000 chars) */
  taskResult?: string;
  /** Error message (if applicable) */
  errorMessage?: string;
  /** Execution timestamp (ISO8601) */
  timestamp: string;
  /** Piece name used */
  pieceName: string;
  /** Task content (max 200 chars) */
  taskContent?: string;
  /** Last movement name */
  lastMovement?: string;
}

/**
 * Get path for storing session state
 */
export function getSessionStatePath(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'session-state.json');
}

/**
 * Load session state from file
 * Returns null if file doesn't exist or parsing fails
 */
export function loadSessionState(projectDir: string): SessionState | null {
  const path = getSessionStatePath(projectDir);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
}

/**
 * Save session state to file (atomic write)
 */
export function saveSessionState(projectDir: string, state: SessionState): void {
  const path = getSessionStatePath(projectDir);
  ensureDir(getProjectConfigDir(projectDir));
  writeFileAtomic(path, JSON.stringify(state, null, 2));
}

/**
 * Clear session state file
 * Does nothing if file doesn't exist
 */
export function clearSessionState(projectDir: string): void {
  const path = getSessionStatePath(projectDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
