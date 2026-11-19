import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  getPersonaSessionsPath,
  getWorktreeSessionPath,
  loadPersonaSessions,
  loadWorktreeSessions,
  resolvePersonaSessionId,
  updatePersonaSession,
  updateWorktreeSession,
} from '../infra/config/project/sessionStore.js';
import { CODEX_SESSION_CONTRACT } from '../shared/codex-session-contract.js';

describe('resolvePersonaSessionId', () => {
  it('scoped keyが存在する場合はscoped keyを優先する', () => {
    const sessions = {
      'interactive:claude-sdk': 'scoped-session',
      interactive: 'legacy-session',
    };

    expect(resolvePersonaSessionId(sessions, 'interactive', 'claude')).toBe('scoped-session');
  });

  it('scoped keyがない場合はlegacy keyへフォールバックする', () => {
    const sessions = {
      interactive: 'legacy-session',
    };

    expect(resolvePersonaSessionId(sessions, 'interactive', 'claude')).toBe('legacy-session');
  });

  it('provider未指定時はlegacy keyのみを参照する', () => {
    const sessions = {
      'interactive:claude-sdk': 'scoped-session',
      interactive: 'legacy-session',
    };

    expect(resolvePersonaSessionId(sessions, 'interactive')).toBe('legacy-session');
  });
});

describe('updatePersonaSession', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    createdDirs.length = 0;
  });

  it('provider指定時はlegacy/scoped keyを同時に更新する', () => {
    const testDir = join(tmpdir(), `takt-session-store-${randomUUID()}`);
    createdDirs.push(testDir);
    mkdirSync(testDir, { recursive: true });

    updatePersonaSession(testDir, 'interactive', 'session-1', 'claude');

    const data = JSON.parse(readFileSync(getPersonaSessionsPath(testDir), 'utf-8')) as {
      personaSessions: Record<string, string>;
    };
    expect(data.personaSessions.interactive).toBe('session-1');
    expect(data.personaSessions['interactive:claude-sdk']).toBe('session-1');
  });

  it('rejects old Codex persona sessions and keeps sessions saved under the current developer contract', () => {
    const testDir = join(tmpdir(), `takt-session-store-${randomUUID()}`);
    createdDirs.push(testDir);
    mkdirSync(join(testDir, '.takt'), { recursive: true });
    writeFileSync(getPersonaSessionsPath(testDir), JSON.stringify({
      provider: 'codex', personaSessions: { interactive: 'old-session' }, updatedAt: new Date().toISOString(),
    }));

    expect(loadPersonaSessions(testDir, 'codex')).toEqual({});
    updatePersonaSession(testDir, 'interactive', 'new-session', 'codex');
    const saved = JSON.parse(readFileSync(getPersonaSessionsPath(testDir), 'utf-8')) as {
      codexSessionContract?: string; personaSessions: Record<string, string>;
    };
    expect(saved.codexSessionContract).toBe(CODEX_SESSION_CONTRACT);
    expect(saved.personaSessions.interactive).toBe('new-session');
    expect(loadPersonaSessions(testDir, 'codex').interactive).toBe('new-session');
  });

  it('sessionIdがundefinedの場合はlegacy/scoped keyを同時に削除する', () => {
    const testDir = join(tmpdir(), `takt-session-store-${randomUUID()}`);
    createdDirs.push(testDir);
    mkdirSync(testDir, { recursive: true });

    updatePersonaSession(testDir, 'interactive', 'session-1', 'claude');
    updatePersonaSession(testDir, 'interactive', undefined, 'claude');

    const data = JSON.parse(readFileSync(getPersonaSessionsPath(testDir), 'utf-8')) as {
      personaSessions: Record<string, string>;
    };
    expect(data.personaSessions.interactive).toBeUndefined();
    expect(data.personaSessions['interactive:claude-sdk']).toBeUndefined();
  });

  it('scoped key入力でもprovider付きlegacy/scoped keyを両方削除する', () => {
    const testDir = join(tmpdir(), `takt-session-store-${randomUUID()}`);
    createdDirs.push(testDir);
    mkdirSync(testDir, { recursive: true });

    updatePersonaSession(testDir, 'coder:opencode', 'session-1', 'opencode');
    updatePersonaSession(testDir, 'coder:opencode', undefined, 'opencode');

    const data = JSON.parse(readFileSync(getPersonaSessionsPath(testDir), 'utf-8')) as {
      personaSessions: Record<string, string>;
    };
    expect(data.personaSessions['coder:opencode']).toBeUndefined();
    expect(data.personaSessions['coder:opencode:opencode']).toBeUndefined();
  });

  it('worktree sessionIdがundefinedの場合はlegacy/scoped keyを同時に削除する', () => {
    const testDir = join(tmpdir(), `takt-session-store-${randomUUID()}`);
    const worktreePath = join(testDir, 'worktree');
    createdDirs.push(testDir);
    mkdirSync(testDir, { recursive: true });

    updateWorktreeSession(testDir, worktreePath, 'coder', 'session-1', 'opencode');
    updateWorktreeSession(testDir, worktreePath, 'coder', undefined, 'opencode');

    expect(loadWorktreeSessions(testDir, worktreePath, 'opencode')).toEqual({});
    const data = JSON.parse(readFileSync(getWorktreeSessionPath(testDir, worktreePath), 'utf-8')) as {
      personaSessions: Record<string, string>;
    };
    expect(data.personaSessions.coder).toBeUndefined();
    expect(data.personaSessions['coder:opencode']).toBeUndefined();
  });
});
