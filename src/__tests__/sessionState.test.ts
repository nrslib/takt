import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  existsSync,
  mkdirSync,
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

  function writeSerializedSessionState(serialized: string): void {
    mkdirSync(join(testDir, '.takt'), { recursive: true });
    writeFileSync(getSessionStatePath(testDir), serialized, 'utf-8');
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

  it('should migrate a legacy session state to a consumed envelope when it includes errorMessage', () => {
    const legacyState: SessionState = {
      status: 'error',
      errorMessage: 'user_interrupted',
      timestamp: '2026-07-28T00:00:00.000Z',
      workflowName: 'coding',
      taskContent: 'Interrupted task',
      lastStep: 'implement',
    };
    mkdirSync(join(testDir, '.takt'), { recursive: true });
    writeFileSync(
      getSessionStatePath(testDir),
      JSON.stringify(legacyState, null, 2),
      'utf-8',
    );

    expect(takeSessionState(testDir)).toEqual(legacyState);
    expect(JSON.parse(readFileSync(
      getSessionStatePath(testDir),
      'utf-8',
    ))).toMatchObject({
      version: 1,
      publicationId: 'legacy-session-state',
      status: 'consumed',
      state: legacyState,
      consumedAt: expect.any(String),
    });
    expect(takeSessionState(testDir)).toBeNull();
  });

  it('should reject a v1 envelope when it contains an unknown field', () => {
    const serialized = JSON.stringify({
      version: 1,
      publicationId: 'publication-a',
      status: 'pending',
      state: state('2026-07-28T00:00:00.000Z', 'done'),
      unknownField: true,
    }, null, 2);
    writeSerializedSessionState(serialized);

    expect(() => takeSessionState(testDir)).toThrow(
      'Session state envelope contains unknown field "unknownField"',
    );
    expect(readFileSync(getSessionStatePath(testDir), 'utf-8')).toBe(serialized);
  });

  const validLegacyState: SessionState = {
    status: 'error',
    taskResult: 'partial result',
    errorMessage: 'user_interrupted',
    timestamp: '2026-07-28T00:00:00.000Z',
    workflowName: 'coding',
    taskContent: 'Interrupted task',
    lastStep: 'implement',
  };

  it.each([
    [
      'status is missing',
      ({ status: _status, ...legacyState }: SessionState) => legacyState,
      'Session state status is invalid',
    ],
    [
      'timestamp is missing',
      ({ timestamp: _timestamp, ...legacyState }: SessionState) => legacyState,
      'Session state timestamp must be a non-empty string',
    ],
    [
      'workflowName is missing',
      ({
        workflowName: _workflowName,
        ...legacyState
      }: SessionState) => legacyState,
      'Session state workflowName must be a non-empty string',
    ],
    [
      'status is invalid',
      (legacyState: SessionState) => ({ ...legacyState, status: 'failed' }),
      'Session state status is invalid',
    ],
    [
      'timestamp is invalid',
      (legacyState: SessionState) => ({
        ...legacyState,
        timestamp: 'not-a-timestamp',
      }),
      'Session state timestamp is invalid: not-a-timestamp',
    ],
    [
      'workflowName is empty',
      (legacyState: SessionState) => ({ ...legacyState, workflowName: '' }),
      'Session state workflowName must be a non-empty string',
    ],
  ] as const)(
    'should reject a legacy session state when %s',
    (_condition, makeInvalidLegacyState, expectedError) => {
      const legacyState = makeInvalidLegacyState(validLegacyState);
      const serialized = JSON.stringify(legacyState, null, 2);
      writeSerializedSessionState(serialized);

      expect(() => takeSessionState(testDir)).toThrow(expectedError);
      expect(readFileSync(getSessionStatePath(testDir), 'utf-8')).toBe(serialized);
    },
  );

  it('malformed envelopeを通知なしとして握りつぶさない', () => {
    saveSessionState(
      testDir,
      'publication-a',
      state('2026-07-28T00:00:00.000Z', 'first'),
    );
    const malformedEnvelope = '{"version":1}';
    writeFileSync(getSessionStatePath(testDir), malformedEnvelope);

    expect(() => takeSessionState(testDir)).toThrow(
      'Session state envelope version or status is invalid',
    );
    expect(readFileSync(getSessionStatePath(testDir), 'utf-8')).toBe(
      malformedEnvelope,
    );
  });
});
