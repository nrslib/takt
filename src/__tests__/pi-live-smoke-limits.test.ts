import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

interface SmokeBudget {
  /** Begins an authorized turn, resetting per-turn but not total counters. */
  beginTurn(): void;
  /** Validates model/options and reserves the turn's single inference request. */
  request(model: object, options: object): void;
  /** Validates the Codex endpoint and reserves one HTTP submission for the turn. */
  submit(url: string): void;
  /** Returns consumed SDK and HTTP counters without reserving further requests. */
  counts(): { requests: number; submissions: number };
}
interface SmokeFiles {
  root: string;
  agentDir: string;
  files: string[];
  before: Map<string, string | undefined>;
}
interface SmokeFileIo {
  /** Supplies protected-file bytes, including simulated read failures. */
  readFile(file: string): Promise<Uint8Array>;
  /** Removes the isolated root even when protected-file verification fails. */
  rm(root: string, options: { recursive: true; force: true }): Promise<void>;
}
const harness: {
  /** Creates a fresh two-turn budget without running the live smoke entrypoint. */
  createSmokeBudget(): SmokeBudget;
  /** Reports verification/cleanup failures without discarding the original error. */
  verifySmokeFilesAndCleanup(files: SmokeFiles, io: SmokeFileIo): Promise<string[]>;
} = await import(
  new URL('../../scripts/pi-provider-live-smoke.mjs', import.meta.url).href
);
const model = { provider: 'openai-codex', id: 'gpt-6.1-sol', api: 'openai-codex-responses' };
const options = {
  maxRetries: 0, transport: 'sse', reasoning: 'high', timeoutMs: 120_000,
  signal: new AbortController().signal,
};
const endpoint = 'https://chatgpt.com/backend-api/codex/responses';

describe('Pi live smoke request limits', () => {
  it('permits exactly one request per turn and two in total', () => {
    const budget = harness.createSmokeBudget();
    for (let turn = 0; turn < 2; turn += 1) {
      budget.beginTurn();
      budget.request(model, options);
      budget.submit(endpoint);
      expect(() => budget.request(model, options)).toThrow();
      expect(() => budget.submit(endpoint)).toThrow();
    }
    expect(() => budget.beginTurn()).toThrow();
    expect(budget.counts()).toEqual({ requests: 2, submissions: 2 });
  });

  it.each([
    { maxRetries: 1 }, { transport: 'auto' }, { reasoning: 'low' },
    { timeoutMs: 120_001 }, { signal: undefined },
    { signal: AbortSignal.abort() },
  ])('rejects unsafe request settings before submission: %j', (override) => {
    const budget = harness.createSmokeBudget();
    budget.beginTurn();
    expect(() => budget.request(model, { ...options, ...override })).toThrow();
    expect(budget.counts()).toEqual({ requests: 0, submissions: 0 });
  });

  it('rejects a fallback model and a different inference endpoint', () => {
    const budget = harness.createSmokeBudget();
    budget.beginTurn();
    expect(() => budget.request({ ...model, id: 'different-model' }, options)).toThrow();
    budget.request(model, options);
    expect(() => budget.submit('https://example.com/codex/responses')).toThrow();
    expect(budget.counts().submissions).toBe(0);
  });
});

describe('Pi live smoke file verification and cleanup', () => {
  const original = Buffer.from('original');
  const before = new Map([['auth.json', createHash('sha256').update(original).digest('hex')]]);
  const input = { root: '/smoke', agentDir: '/agent', files: ['auth.json'], before };

  it('cleans up before returning a modified-file error without throwing', async () => {
    const events: string[] = [];
    const io = {
      readFile: vi.fn(/** Records verification before returning altered protected bytes. */ async () => { events.push('check'); return Buffer.from('modified'); }),
      rm: vi.fn(/** Records cleanup to prove it follows file verification. */ async () => { events.push('cleanup'); }),
    };
    await expect(harness.verifySmokeFilesAndCleanup(input, io)).resolves.toEqual(['auth.json must not be modified']);
    expect(events).toEqual(['check', 'cleanup']);
    expect(io.rm).toHaveBeenCalledExactlyOnceWith('/smoke', { recursive: true, force: true });
  });

  it('still cleans up when a protected file cannot be read', async () => {
    const io = {
      readFile: vi.fn(/** Simulates an access failure that must not skip cleanup. */ async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); }),
      rm: vi.fn(/** Observes cleanup after the simulated protected-file read failure. */ async () => {}),
    };
    await expect(harness.verifySmokeFilesAndCleanup(input, io)).resolves.toEqual(['auth.json could not be verified']);
    expect(io.rm).toHaveBeenCalledOnce();
  });

  it('accepts unchanged files and files that remain absent', async () => {
    const io = {
      readFile: vi.fn(/** Returns unchanged protected bytes. */ async () => original),
      rm: vi.fn(/** Observes successful cleanup without filesystem access. */ async () => {}),
    };
    await expect(harness.verifySmokeFilesAndCleanup(input, io)).resolves.toEqual([]);
    const absent = {
      readFile: vi.fn(/** Simulates a file that was absent before and after the smoke. */ async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); }),
      rm: vi.fn(/** Observes cleanup when protected files remain absent. */ async () => {}),
    };
    await expect(harness.verifySmokeFilesAndCleanup({ ...input, before: new Map([['auth.json', undefined]]) }, absent)).resolves.toEqual([]);
    expect(absent.rm).toHaveBeenCalledOnce();
  });

  it('reports cleanup failure without replacing a prior error with an exception', async () => {
    const io = {
      readFile: vi.fn(/** Returns unchanged bytes so the cleanup failure is isolated. */ async () => original),
      rm: vi.fn(/** Simulates removal failure for error aggregation, not exception replacement. */ async () => { throw new Error('cleanup failed'); }),
    };
    await expect(harness.verifySmokeFilesAndCleanup(input, io)).resolves.toEqual(['Smoke temporary directory cleanup failed']);
  });
});
