/**
 * Claude Code session writer
 *
 * Updates sessions-index.json with session information after AI calls.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getClaudeProjectSessionsDir, writeFileAtomic } from '../config/project/sessionStore.js';
import type { SessionIndexEntry } from './session-reader.js';

interface SessionsIndex {
  version: number;
  entries: SessionIndexEntry[];
}

export function updateSessionIndex(
  cwd: string,
  sessionId: string,
  firstPrompt: string,
  messageCount: number,
  gitBranch: string
): void {
  const sessionsDir = getClaudeProjectSessionsDir(cwd);
  const indexPath = join(sessionsDir, 'sessions-index.json');

  let index: SessionsIndex;
  if (existsSync(indexPath)) {
    try {
      const content = readFileSync(indexPath, 'utf-8');
      index = JSON.parse(content) as SessionsIndex;
    } catch {
      index = { version: 1, entries: [] };
    }
  } else {
    index = { version: 1, entries: [] };
  }

  if (!index.entries) {
    index.entries = [];
  }

  const existingIndex = index.entries.findIndex((e) => e.sessionId === sessionId);
  const fullPath = join(sessionsDir, `${sessionId}.jsonl`);
  const now = new Date().toISOString();

  if (existingIndex !== -1) {
    const existingEntry = index.entries[existingIndex]!;
    index.entries[existingIndex] = {
      ...existingEntry,
      firstPrompt: existingEntry.firstPrompt,
      modified: now,
      messageCount,
      gitBranch,
      fullPath,
    };
  } else {
    const newEntry: SessionIndexEntry = {
      sessionId,
      firstPrompt,
      modified: now,
      messageCount,
      gitBranch,
      isSidechain: false,
      fullPath,
    };
    index.entries.unshift(newEntry);
  }

  writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
}

export function getGitBranch(cwd: string): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return branch.trim();
  } catch {
    return '';
  }
}
