import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getSessionStatePath,
  saveSessionState,
  takeSessionState,
  type SessionState,
} from '../infra/config/project/sessionState.js';

describe('session state envelope', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'takt-session-state-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function state(timestamp: string, taskResult: string): SessionState {
    return {
      status: 'success',
      taskResult,
      timestamp,
      workflowName: 'coding',
    };
  }

  it('pending stateを一度だけ取得してconsumed envelopeを残す', () => {
    const saved = state('2026-07-28T00:00:00.000Z', 'done');
    saveSessionState(testDir, 'publication-a', saved);

    expect(takeSessionState(testDir)).toEqual(saved);
    expect(takeSessionState(testDir)).toBeNull();
    expect(existsSync(getSessionStatePath(testDir))).toBe(true);
    expect(JSON.parse(readFileSync(
      getSessionStatePath(testDir),
      'utf-8',
    ))).toMatchObject({
      version: 1,
      publicationId: 'publication-a',
      status: 'consumed',
      state: saved,
      consumedAt: expect.any(String),
    });
  });

  it('consumed済みpublicationの再saveでpendingへ戻さない', () => {
    const saved = state('2026-07-28T00:00:00.000Z', 'done');
    saveSessionState(testDir, 'publication-a', saved);
    expect(takeSessionState(testDir)).toEqual(saved);

    saveSessionState(testDir, 'publication-a', saved);

    expect(takeSessionState(testDir)).toBeNull();
  });

  it('同一時刻ではpublicationIdを使った全順序で新旧を決める', () => {
    const timestamp = '2026-07-28T00:00:00.000Z';
    saveSessionState(testDir, 'publication-b', state(timestamp, 'newer'));
    saveSessionState(testDir, 'publication-a', state(timestamp, 'older'));

    expect(takeSessionState(testDir)).toMatchObject({
      taskResult: 'newer',
    });
  });

  it('take後に保存されたnewer stateを旧takeが削除しない', () => {
    saveSessionState(
      testDir,
      'publication-a',
      state('2026-07-28T00:00:00.000Z', 'first'),
    );
    expect(takeSessionState(testDir)).toMatchObject({ taskResult: 'first' });

    saveSessionState(
      testDir,
      'publication-b',
      state('2026-07-28T00:00:01.000Z', 'second'),
    );

    expect(takeSessionState(testDir)).toMatchObject({ taskResult: 'second' });
  });

  it('malformed envelopeを通知なしとして握りつぶさない', () => {
    saveSessionState(
      testDir,
      'publication-a',
      state('2026-07-28T00:00:00.000Z', 'first'),
    );
    writeFileSync(getSessionStatePath(testDir), '{"version":1}');

    expect(() => takeSessionState(testDir)).toThrow(/session state/i);
  });
});
