import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCodexRolloutObservation,
  detectCodexCompaction,
} from '../infra/codex/compaction.js';

function rolloutLine(type: string): string {
  const payload = type === 'compacted'
    ? { message: '', replacement_history: [] }
    : {};
  return `${JSON.stringify({ timestamp: '2026-11-12T12:00:00.000Z', ordinal: 0, type, payload })}\n`;
}

describe('Codex rollout compaction detection', () => {
  let codexHome: string;

  beforeEach(() => {
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
});
