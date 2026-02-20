/**
 * Tests for Claude Code session writer
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let mockSessionsDir: string;

vi.mock('../infra/config/project/sessionStore.js', () => ({
  getClaudeProjectSessionsDir: vi.fn(() => mockSessionsDir),
  writeFileAtomic: vi.fn((filePath: string, content: string) => {
    writeFileSync(filePath, content, 'utf-8');
  }),
}));

import { updateSessionIndex, getGitBranch } from '../infra/claude/session-writer.js';

describe('updateSessionIndex', () => {
  beforeEach(() => {
    mockSessionsDir = mkdtempSync(join(tmpdir(), 'session-writer-test-'));
  });

  it('creates sessions-index.json when it does not exist', () => {
    const indexPath = join(mockSessionsDir, 'sessions-index.json');
    expect(existsSync(indexPath)).toBe(false);

    updateSessionIndex('/any/project', 'session-123', 'Hello AI', 2, 'main');

    expect(existsSync(indexPath)).toBe(true);
    const content = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(content.version).toBe(1);
    expect(content.entries).toHaveLength(1);
    expect(content.entries[0]!.sessionId).toBe('session-123');
    expect(content.entries[0]!.firstPrompt).toBe('Hello AI');
    expect(content.entries[0]!.messageCount).toBe(2);
    expect(content.entries[0]!.gitBranch).toBe('main');
    expect(content.entries[0]!.isSidechain).toBe(false);
    expect(content.entries[0]!.fullPath).toContain('session-123.jsonl');
    expect(content.entries[0]!.modified).toBeDefined();
  });

  it('adds new session entry at the beginning', () => {
    const indexPath = join(mockSessionsDir, 'sessions-index.json');
    const existingIndex = {
      version: 1,
      entries: [
        {
          sessionId: 'existing-session',
          firstPrompt: 'Existing prompt',
          modified: '2026-01-28T10:00:00.000Z',
          messageCount: 5,
          gitBranch: 'main',
          isSidechain: false,
          fullPath: '/path/to/existing-session.jsonl',
        },
      ],
    };
    writeFileSync(indexPath, JSON.stringify(existingIndex));

    updateSessionIndex('/any/project', 'new-session', 'New prompt', 3, 'feature');

    const content = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(content.entries).toHaveLength(2);
    expect(content.entries[0]!.sessionId).toBe('new-session');
    expect(content.entries[1]!.sessionId).toBe('existing-session');
  });

  it('updates existing session entry with new messageCount and modified', () => {
    const indexPath = join(mockSessionsDir, 'sessions-index.json');
    const existingIndex = {
      version: 1,
      entries: [
        {
          sessionId: 'existing-session',
          firstPrompt: 'Original prompt',
          modified: '2026-01-28T10:00:00.000Z',
          messageCount: 5,
          gitBranch: 'main',
          isSidechain: false,
          fullPath: '/path/to/existing-session.jsonl',
        },
      ],
    };
    writeFileSync(indexPath, JSON.stringify(existingIndex));

    updateSessionIndex('/any/project', 'existing-session', 'Updated prompt', 10, 'feature');

    const content = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(content.entries).toHaveLength(1);
    expect(content.entries[0]!.sessionId).toBe('existing-session');
    expect(content.entries[0]!.firstPrompt).toBe('Original prompt');
    expect(content.entries[0]!.messageCount).toBe(10);
    expect(content.entries[0]!.gitBranch).toBe('feature');
    expect(content.entries[0]!.modified).not.toBe('2026-01-28T10:00:00.000Z');
  });

  it('does not change created field for existing entries', () => {
    const indexPath = join(mockSessionsDir, 'sessions-index.json');
    const existingIndex = {
      version: 1,
      entries: [
        {
          sessionId: 'existing-session',
          firstPrompt: 'Original prompt',
          modified: '2026-01-28T10:00:00.000Z',
          messageCount: 5,
          gitBranch: 'main',
          isSidechain: false,
          fullPath: '/path/to/existing-session.jsonl',
        },
      ],
    };
    writeFileSync(indexPath, JSON.stringify(existingIndex));

    updateSessionIndex('/any/project', 'existing-session', 'Updated prompt', 10, 'feature');

    const content = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(content.entries[0]!.firstPrompt).toBe('Original prompt');
  });

  it('handles missing entries array in existing file', () => {
    const indexPath = join(mockSessionsDir, 'sessions-index.json');
    writeFileSync(indexPath, JSON.stringify({ version: 1 }));

    updateSessionIndex('/any/project', 'new-session', 'New prompt', 3, 'main');

    const content = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(content.entries).toHaveLength(1);
    expect(content.entries[0]!.sessionId).toBe('new-session');
  });

  it('handles corrupted JSON gracefully', () => {
    const indexPath = join(mockSessionsDir, 'sessions-index.json');
    writeFileSync(indexPath, 'not valid json');

    updateSessionIndex('/any/project', 'new-session', 'New prompt', 3, 'main');

    const content = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(content.entries).toHaveLength(1);
    expect(content.entries[0]!.sessionId).toBe('new-session');
  });
});

describe('getGitBranch', () => {
  it('returns empty string when not in a git repository', () => {
    const result = getGitBranch('/nonexistent/path');
    expect(result).toBe('');
  });
});
