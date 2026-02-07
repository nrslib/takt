/**
 * Session storage for takt
 *
 * Manages persona sessions and input history persistence.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getProjectConfigDir, ensureDir } from '../paths.js';

/**
 * Write file atomically using temp file + rename.
 * This prevents corruption when multiple processes write simultaneously.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

// ============ Input History ============

/** Get path for storing input history */
export function getInputHistoryPath(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'input_history');
}

/** Maximum number of input history entries to keep */
export const MAX_INPUT_HISTORY = 100;

/** Load input history */
export function loadInputHistory(projectDir: string): string[] {
  const path = getInputHistoryPath(projectDir);
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as string;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is string => entry !== null);
    } catch {
      return [];
    }
  }
  return [];
}

/** Save input history (atomic write) */
export function saveInputHistory(projectDir: string, history: string[]): void {
  const path = getInputHistoryPath(projectDir);
  ensureDir(getProjectConfigDir(projectDir));
  const trimmed = history.slice(-MAX_INPUT_HISTORY);
  const content = trimmed.map((entry) => JSON.stringify(entry)).join('\n');
  writeFileAtomic(path, content);
}

/** Add an entry to input history */
export function addToInputHistory(projectDir: string, input: string): void {
  const history = loadInputHistory(projectDir);
  if (history[history.length - 1] !== input) {
    history.push(input);
  }
  saveInputHistory(projectDir, history);
}

// ============ Persona Sessions ============

import type { PersonaSessionData } from '../types.js';

export type { PersonaSessionData };

/** Get path for storing persona sessions */
export function getPersonaSessionsPath(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'persona_sessions.json');
}

/** Load saved persona sessions. Returns empty if provider has changed. */
export function loadPersonaSessions(projectDir: string, currentProvider?: string): Record<string, string> {
  const path = getPersonaSessionsPath(projectDir);
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content) as PersonaSessionData;
      // If provider has changed or is unknown (legacy data), sessions are incompatible — discard them
      if (currentProvider && data.provider !== currentProvider) {
        return {};
      }
      return data.personaSessions || {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Save persona sessions (atomic write) */
export function savePersonaSessions(
  projectDir: string,
  sessions: Record<string, string>,
  provider?: string
): void {
  const path = getPersonaSessionsPath(projectDir);
  ensureDir(getProjectConfigDir(projectDir));
  const data: PersonaSessionData = {
    personaSessions: sessions,
    updatedAt: new Date().toISOString(),
    provider,
  };
  writeFileAtomic(path, JSON.stringify(data, null, 2));
}

/**
 * Update a single persona session atomically.
 * Uses read-modify-write with atomic file operations.
 */
export function updatePersonaSession(
  projectDir: string,
  persona: string,
  sessionId: string,
  provider?: string
): void {
  const path = getPersonaSessionsPath(projectDir);
  ensureDir(getProjectConfigDir(projectDir));

  let sessions: Record<string, string> = {};
  let existingProvider: string | undefined;
  if (existsSync(path)) {
    try {
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content) as PersonaSessionData;
      existingProvider = data.provider;
      // If provider changed, discard old sessions
      if (provider && existingProvider && existingProvider !== provider) {
        sessions = {};
      } else {
        sessions = data.personaSessions || {};
      }
    } catch {
      sessions = {};
    }
  }

  sessions[persona] = sessionId;

  const data: PersonaSessionData = {
    personaSessions: sessions,
    updatedAt: new Date().toISOString(),
    provider: provider ?? existingProvider,
  };
  writeFileAtomic(path, JSON.stringify(data, null, 2));
}

/** Clear all saved persona sessions */
export function clearPersonaSessions(projectDir: string): void {
  const path = getPersonaSessionsPath(projectDir);
  ensureDir(getProjectConfigDir(projectDir));
  const data: PersonaSessionData = {
    personaSessions: {},
    updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(path, JSON.stringify(data, null, 2));

  // Also clear Claude CLI project sessions
  clearClaudeProjectSessions(projectDir);
}

// ============ Worktree Sessions ============

/** Get the worktree sessions directory */
export function getWorktreeSessionsDir(projectDir: string): string {
  return join(getProjectConfigDir(projectDir), 'worktree-sessions');
}

/** Encode a worktree path to a safe filename */
export function encodeWorktreePath(worktreePath: string): string {
  const resolved = resolve(worktreePath);
  return resolved.replace(/[/\\:]/g, '-');
}

/** Get path for a worktree's session file */
export function getWorktreeSessionPath(projectDir: string, worktreePath: string): string {
  const dir = getWorktreeSessionsDir(projectDir);
  const encoded = encodeWorktreePath(worktreePath);
  return join(dir, `${encoded}.json`);
}

/** Load saved persona sessions for a worktree. Returns empty if provider has changed. */
export function loadWorktreeSessions(
  projectDir: string,
  worktreePath: string,
  currentProvider?: string
): Record<string, string> {
  const sessionPath = getWorktreeSessionPath(projectDir, worktreePath);
  if (existsSync(sessionPath)) {
    try {
      const content = readFileSync(sessionPath, 'utf-8');
      const data = JSON.parse(content) as PersonaSessionData;
      if (currentProvider && data.provider !== currentProvider) {
        return {};
      }
      return data.personaSessions || {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Update a single persona session for a worktree (atomic) */
export function updateWorktreeSession(
  projectDir: string,
  worktreePath: string,
  personaName: string,
  sessionId: string,
  provider?: string
): void {
  const dir = getWorktreeSessionsDir(projectDir);
  ensureDir(dir);

  const sessionPath = getWorktreeSessionPath(projectDir, worktreePath);
  let sessions: Record<string, string> = {};
  let existingProvider: string | undefined;

  if (existsSync(sessionPath)) {
    try {
      const content = readFileSync(sessionPath, 'utf-8');
      const data = JSON.parse(content) as PersonaSessionData;
      existingProvider = data.provider;
      if (provider && existingProvider && existingProvider !== provider) {
        sessions = {};
      } else {
        sessions = data.personaSessions || {};
      }
    } catch {
      sessions = {};
    }
  }

  sessions[personaName] = sessionId;

  const data: PersonaSessionData = {
    personaSessions: sessions,
    updatedAt: new Date().toISOString(),
    provider: provider ?? existingProvider,
  };
  writeFileAtomic(sessionPath, JSON.stringify(data, null, 2));
}

/**
 * Get the Claude CLI project session directory path.
 * Claude CLI stores sessions in ~/.claude/projects/{encoded-project-path}/
 */
export function getClaudeProjectSessionsDir(projectDir: string): string {
  const resolvedPath = resolve(projectDir);
  // Claude CLI encodes the path by replacing '/' and other special chars with '-'
  // Based on observed behavior: /Users/takt -> -Users-takt
  const encodedPath = resolvedPath.replace(/[/\\_ ]/g, '-');
  return join(homedir(), '.claude', 'projects', encodedPath);
}

/**
 * Clear Claude CLI project sessions.
 * Removes all session files (*.jsonl) from the project's session directory.
 */
export function clearClaudeProjectSessions(projectDir: string): void {
  const sessionDir = getClaudeProjectSessionsDir(projectDir);

  if (!existsSync(sessionDir)) {
    return;
  }

  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(sessionDir, entry.name);

      // Remove .jsonl session files and sessions-index.json
      if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name === 'sessions-index.json')) {
        try {
          unlinkSync(fullPath);
        } catch {
          // Ignore individual file deletion errors
        }
      }

      // Remove session subdirectories (some sessions have associated directories)
      if (entry.isDirectory()) {
        try {
          rmSync(fullPath, { recursive: true, force: true });
        } catch {
          // Ignore directory deletion errors
        }
      }
    }
  } catch {
    // Ignore errors if we can't read the directory
  }
}
