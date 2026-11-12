import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCodexRolloutObservation,
  detectCodexCompaction,
} from '../infra/codex/compaction.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function rolloutLine(type: string): string {
  const payload = type === 'compacted'
    ? { message: '', replacement_history: [] }
    : {};
  return `${JSON.stringify({ timestamp: '2026-11-12T12:00:00.000Z', ordinal: 0, type, payload })}\n`;
}

describe('Codex rollout compaction detection', () => {
  let codexHome: string;

  beforeEach(() => {
    vi.mocked(readdirSync).mockImplementation(actualFs.readdirSync);
    vi.mocked(statSync).mockImplementation(actualFs.statSync);
    codexHome = mkdtempSync(join(tmpdir(), 'codex-compaction-'));
  });

  afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('ignores compaction before the call and detects a record appended after its starting offset', async () => {
    const sessionId = 'existing-session';
    const directory = join(codexHome, 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    const rolloutPath = join(directory, `rollout-2026-11-12T12-00-00-${sessionId}.jsonl`);
    writeFileSync(rolloutPath, rolloutLine('compacted') + rolloutLine('event_msg'));
    const observation = await createCodexRolloutObservation(
      { CODEX_HOME: codexHome },
      sessionId,
      new Date(2026, 10, 12, 12, 1, 0),
    );

    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(false);
    appendFileSync(rolloutPath, rolloutLine('compacted'));
    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(true);
  });

  it('finds a new session rollout created after observation starts', async () => {
    const sessionId = 'new-session';
    const startedAt = new Date(2026, 10, 12, 12, 1, 0);
    const observation = await createCodexRolloutObservation(
      { CODEX_HOME: codexHome },
      undefined,
      startedAt,
    );
    const directory = join(codexHome, 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-11-12T12-01-00-${sessionId}.jsonl`),
      rolloutLine('event_msg') + rolloutLine('compacted'),
    );

    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(true);
  });

  it('finds an existing session rollout below the effective HOME', async () => {
    const sessionId = 'existing-home-session';
    const directory = join(codexHome, '.codex', 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    const rolloutPath = join(directory, `rollout-2026-11-12T12-00-00-${sessionId}.jsonl`);
    writeFileSync(rolloutPath, rolloutLine('event_msg'));
    const observation = createCodexRolloutObservation(
      { HOME: codexHome },
      sessionId,
      new Date(2026, 10, 12, 12, 1, 0),
    );

    appendFileSync(rolloutPath, rolloutLine('compacted'));

    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(true);
  });

  it('finds a new session rollout below the effective HOME', async () => {
    const sessionId = 'new-home-session';
    const observation = createCodexRolloutObservation(
      { HOME: codexHome },
      undefined,
      new Date(2026, 10, 12, 12, 1, 0),
    );
    const directory = join(codexHome, '.codex', 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-11-12T12-01-00-${sessionId}.jsonl`),
      rolloutLine('compacted'),
    );

    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(true);
  });

  it('returns false when the rollout has no compaction record', async () => {
    const sessionId = 'new-session';
    const observation = await createCodexRolloutObservation(
      { CODEX_HOME: codexHome },
      undefined,
      new Date(2026, 10, 12, 12, 1, 0),
    );
    const directory = join(codexHome, 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-11-12T12-01-00-${sessionId}.jsonl`),
      rolloutLine('event_msg'),
    );

    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(false);
  });

  it('does not treat an assistant response as a compaction event', async () => {
    const sessionId = 'new-session';
    const observation = await createCodexRolloutObservation(
      { CODEX_HOME: codexHome },
      undefined,
      new Date(2026, 10, 12, 12, 1, 0),
    );
    const directory = join(codexHome, 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-11-12T12-01-00-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', content: [{ text: '作業依頼を教えてください' }] },
      })}\n`,
    );

    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(false);
  });

  it('disables resume observation when an unrelated sessions subdirectory cannot be read', async () => {
    const sessionsRoot = join(codexHome, 'sessions');
    mkdirSync(join(sessionsRoot, 'unreadable'), { recursive: true });
    vi.mocked(readdirSync)
      .mockImplementationOnce(actualFs.readdirSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      });

    const observation = createCodexRolloutObservation(
      { CODEX_HOME: codexHome },
      'existing-session',
      new Date(2026, 10, 12, 12, 1, 0),
    );

    expect(observation).toMatchObject({ rolloutPath: undefined, byteOffset: 0 });
    await expect(detectCodexCompaction(observation, 'existing-session')).resolves.toBe(false);
  });

  it('disables resume observation when the rollout disappears before its size is read', async () => {
    const sessionId = 'existing-session';
    const directory = join(codexHome, 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-11-12T12-00-00-${sessionId}.jsonl`),
      rolloutLine('event_msg'),
    );
    vi.mocked(statSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('rollout removed'), { code: 'ENOENT' });
    });

    const observation = createCodexRolloutObservation(
      { CODEX_HOME: codexHome },
      sessionId,
      new Date(2026, 10, 12, 12, 1, 0),
    );

    expect(observation).toMatchObject({ rolloutPath: undefined, byteOffset: 0 });
    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(false);
  });

  it('treats an incomplete rollout JSON line as no compaction detection', async () => {
    const sessionId = 'new-session';
    const observation = createCodexRolloutObservation(
      { CODEX_HOME: codexHome },
      undefined,
      new Date(2026, 10, 12, 12, 1, 0),
    );
    const directory = join(codexHome, 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-11-12T12-01-00-${sessionId}.jsonl`),
      '{"type":',
    );

    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(false);
  });

  it('treats a rollout removed after observation as no compaction detection', async () => {
    const sessionId = 'existing-session';
    const directory = join(codexHome, 'sessions', '2026', '11', '12');
    mkdirSync(directory, { recursive: true });
    const rolloutPath = join(directory, `rollout-2026-11-12T12-00-00-${sessionId}.jsonl`);
    writeFileSync(rolloutPath, rolloutLine('compacted'));
    const observation = createCodexRolloutObservation(
      { CODEX_HOME: codexHome },
      sessionId,
      new Date(2026, 10, 12, 12, 1, 0),
    );
    rmSync(rolloutPath);

    await expect(detectCodexCompaction(observation, sessionId)).resolves.toBe(false);
  });
});
