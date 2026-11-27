import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';

const picker = vi.hoisted(() => vi.fn());
const kiroExec = vi.hoisted(() => vi.fn());
const openCodeAcquire = vi.hoisted(() => vi.fn());
vi.mock('../infra/kiro/process.js', () => ({ execKiro: kiroExec }));
vi.mock('../shared/prompt/index.js', () => ({ selectOption: picker }));
vi.mock('../infra/opencode/server-pool.js', () => ({ acquireOpenCodeClient: openCodeAcquire }));

import * as recordsStore from '../features/interactive/interactiveSessionRecords.js';
import { selectRecentSession } from '../features/interactive/sessionSelector.js';
import { interactiveSessionExists } from '../features/interactive/interactiveSessionExistence.js';

let cwd: string;

beforeEach(() => {
  cwd = join(getGlobalConfigDir(), 'project');
  mkdirSync(cwd, { recursive: true });
  picker.mockReset().mockResolvedValue(null);
  kiroExec.mockReset();
  openCodeAcquire.mockReset();
});

async function turn(store: typeof recordsStore, provider: string, sessionId: string, input: string, response = 'reply') {
  await store.recordTurn({ cwd, provider, sessionId, input, response });
}

type Option = { value: string; label: string; details?: string[] };
async function options(provider: string): Promise<Option[]> {
  await selectRecentSession(cwd, 'en', provider);
  expect(picker).toHaveBeenCalled();
  return picker.mock.calls.at(-1)![1] as Option[];
}

it('lists recorded interactive conversations alongside neither CLI nor internal sessions', async () => {
  const store = recordsStore;
  await turn(store, 'claude', 'interactive', 'real conversation');
  const displayed = await options('claude');
  expect(displayed.map((option) => option.value)).toEqual(['__new__', 'interactive']);
});

it('lists only sessions from the current provider', async () => {
  const store = recordsStore;
  await turn(store, 'claude', 'claude-session', 'claude input');
  await turn(store, 'codex', 'codex-session', 'codex input');
  const displayed = await options('codex');
  expect(displayed.map((option) => option.value)).toEqual(['__new__', 'codex-session']);
});

it('moves a previously recorded conversation to the front after another input', async () => {
  const store = recordsStore;
  await turn(store, 'codex', 'A', 'first A');
  await turn(store, 'codex', 'B', 'first B');
  expect((await options('codex')).map((item) => item.value)).toEqual(['__new__', 'B', 'A']);
  await turn(store, 'codex', 'A', 'second A');
  expect((await options('codex')).map((item) => item.value)).toEqual(['__new__', 'A', 'B']);
});

it('retains the latest three inputs and displays them in order with the latest reply', async () => {
  const store = recordsStore;
  for (const input of ['first', 'second', 'third', 'fourth']) {
    await turn(store, 'codex', 'conversation', input, `reply to ${input}`);
  }
  const saved = await store.listRecords(cwd, 'codex');
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ sessionId: 'conversation', inputs: ['second', 'third', 'fourth'], response: 'reply to fourth' });
  const displayed = await options('codex');
  const item = displayed.find((option) => option.value === 'conversation');
  expect(item?.label).toBe('fourth');
  expect(item?.details).toHaveLength(3);
  expect(item?.details?.[0]).toContain('third');
  expect(item?.details?.[1]).toContain('second');
  expect(item?.details?.[2]).toContain('reply to fourth');
  expect([item?.label, ...(item?.details ?? [])].every((line) => line !== undefined && !line.includes('\n'))).toBe(true);
});

it.each(['claude', 'codex', 'opencode'])('removes missing %s sessions during startup cleanup', async (provider) => {
  const store = recordsStore;
  await turn(store, provider, 'present', 'present input');
  await turn(store, provider, 'missing', 'missing input');
  await store.cleanRecords(cwd, async (_provider, id) => id === 'present');
  expect((await store.listRecords(cwd, provider)).map((entry) => entry.sessionId)).toEqual(['present']);
});

it('retains and lists sessions whose provider cannot be checked', async () => {
  const store = recordsStore;
  await turn(store, 'pi', 'pi-session', 'pi input');
  await store.cleanRecords(cwd, async () => undefined);
  expect((await store.listRecords(cwd, 'pi')).map((entry) => entry.sessionId)).toEqual(['pi-session']);
  expect((await options('pi')).map((item) => item.value)).toEqual(['__new__', 'pi-session']);
});

it('retains Kiro records found in the list or present only in an unrecognized diagnostic', async () => {
  const store = recordsStore;
  const present = '123e4567-e89b-12d3-a456-426614174000';
  const unknown = '123e4567-e89b-12d3-a456-426614174001';
  await turn(store, 'kiro', present, 'present');
  await turn(store, 'kiro', unknown, 'unknown');
  kiroExec.mockResolvedValue({ stdout: '', stderr: `${present}  updated just now\ndiagnostic ${unknown}` });
  await store.cleanRecords(cwd, (provider, sessionId) => interactiveSessionExists(cwd, provider, sessionId));
  expect((await store.listRecords(cwd, 'kiro')).map((entry) => entry.sessionId)).toEqual([unknown, present]);
});

it('keeps the newest ten independently for each provider', async () => {
  const store = recordsStore;
  await turn(store, 'pi', 'old-other', 'other');
  for (let index = 0; index < 11; index++) await turn(store, 'codex', `session-${index}`, `input-${index}`);
  const checked: string[] = [];
  await store.cleanRecords(cwd, async (_provider, sessionId) => {
    checked.push(sessionId);
    return undefined;
  });
  expect(checked).toEqual([
    ...Array.from({ length: 10 }, (_, index) => `session-${10 - index}`),
    'old-other',
  ]);
  expect((await store.listRecords(cwd, 'codex')).map((entry) => entry.sessionId)).toEqual(
    Array.from({ length: 10 }, (_, index) => `session-${10 - index}`),
  );
  expect((await store.listRecords(cwd, 'pi')).map((entry) => entry.sessionId)).toEqual(['old-other']);
});

it('recreates unreadable records as empty and continues startup', async () => {
  const store = recordsStore;
  const path = store.getRecordsPath(cwd);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{invalid json');
  await expect(store.cleanRecords(cwd, async () => undefined)).resolves.toBeUndefined();
  expect(await store.listRecords(cwd, 'codex')).toEqual([]);
});

it('retains records when provider existence checks throw', async () => {
  const store = recordsStore;
  await turn(store, 'codex', 'uncheckable', 'uncertain');
  await turn(store, 'codex', 'missing', 'gone');
  await store.cleanRecords(cwd, async (_provider, sessionId) => {
    if (sessionId === 'uncheckable') throw new Error('provider unavailable');
    return false;
  });
  expect((await store.listRecords(cwd, 'codex')).map((entry) => entry.sessionId)).toEqual(['uncheckable']);
});

it('keeps records added or updated by another writer during startup cleanup', async () => {
  const project = mkdtempSync(join(tmpdir(), 'takt-clean-records-'));
  const writeTurn = (sessionId: string, input: string) => recordsStore.recordTurn({
    cwd: project, provider: 'codex', sessionId, input, response: `reply ${input}`,
  });
  let release: (() => void) | undefined;
  try {
    writeTurn('updated', 'before');
    writeTurn('missing', 'gone');
    const held = new Promise<void>((resolve) => { release = resolve; });
    const checked: string[] = [];
    const cleaning = recordsStore.cleanRecords(project, async (_provider, sessionId) => {
      checked.push(sessionId);
      if (sessionId === 'missing') await held;
      return false;
    });
    expect(checked).toEqual(['missing']);

    writeTurn('new', 'new input');
    writeTurn('updated', 'after');
    release?.();
    await cleaning;

    expect(recordsStore.listRecords(project, 'codex')).toMatchObject([
      { sessionId: 'updated', inputs: ['before', 'after'], response: 'reply after' },
      { sessionId: 'new', inputs: ['new input'] },
    ]);
  } finally {
    release?.();
    rmSync(project, { recursive: true, force: true });
  }
});

it('sanitizes recorded inputs and replies before displaying them', async () => {
  const store = recordsStore;
  await turn(store, 'codex', 'unsafe', 'previous\u001b[31mtext\u001b[0m\r');
  await turn(store, 'codex', 'unsafe', 'latest\u001b[32mtext\u001b[0m\r', 'reply\u001b]0;title\u0007\r');

  const displayed = await options('codex');
  const item = displayed.find((option) => option.value === 'unsafe');
  expect(item?.label).toBe('latesttext\\r');
  expect(item?.details?.[0]).toContain('previoustext\\r');
  expect(item?.details?.[1]).toContain('reply\\r');
  expect([item?.label, ...(item?.details ?? [])].every((line) => line !== undefined && !/[\u001b\r\u0000-\u001f\u007f-\u009f]/u.test(line))).toBe(true);
});

it('returns unknown when the OpenCode session lookup exceeds its deadline', async () => {
  const timeoutController = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
  const invalidationSignal = new AbortController().signal;
  const release = vi.fn();
  let resolveGetStarted: () => void = () => {};
  const getStarted = new Promise<void>((resolve) => {
    resolveGetStarted = resolve;
  });
  const sessionGet = vi.fn((_request: unknown, options: { signal: AbortSignal }) => {
    resolveGetStarted();
    return new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  });
  openCodeAcquire.mockResolvedValue({
    client: { session: { get: sessionGet } },
    release,
    invalidationSignal,
  });

  const check = interactiveSessionExists(cwd, 'opencode', 'session');
  try {
    await getStarted;
    expect(timeout).toHaveBeenCalledWith(10_000);
    timeoutController.abort();
    await expect(check).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    timeoutController.abort();
    timeout.mockRestore();
  }
});
