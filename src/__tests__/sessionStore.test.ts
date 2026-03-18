import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  getPersonaSessionsPath,
  resolvePersonaSessionId,
  updatePersonaSession,
} from '../infra/config/project/sessionStore.js';

describe('resolvePersonaSessionId', () => {
  it('scoped keyが存在する場合はscoped keyを優先する', () => {
    const sessions = {
      'interactive:claude': 'scoped-session',
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
      'interactive:claude': 'scoped-session',
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
    expect(data.personaSessions['interactive:claude']).toBe('session-1');
  });
});
