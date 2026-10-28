import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';

const picker = vi.hoisted(() => vi.fn());
const kiroExec = vi.hoisted(() => vi.fn());
vi.mock('../infra/kiro/process.js', () => ({ execKiro: kiroExec }));
vi.mock('../shared/prompt/index.js', () => ({ selectOption: picker }));
vi.mock('../infra/claude/session-reader.js', () => ({
  loadSessionIndex: () => [
    { sessionId: 'cli', firstPrompt: 'CLI', modified: '2026-01-01T00:00:00Z', messageCount: 1 },
    { sessionId: 'internal', firstPrompt: 'Internal', modified: '2026-01-01T00:00:00Z', messageCount: 1 },
  ],
  extractLastAssistantResponse: () => null,
}));

import { selectRecentSession } from '../features/interactive/sessionSelector.js';
import { interactiveSessionExists } from '../features/interactive/interactiveSessionExistence.js';

type RecordEntry = {
  provider: string;
  sessionId: string;
  inputs: string[];
  response: string;
};
type Records = {
  recordTurn: (args: { cwd: string; provider: string; sessionId: string; input: string; response: string }) => Promise<void>;
  listRecords: (cwd: string, provider: string) => Promise<RecordEntry[]>;
  cleanRecords: (cwd: string, exists: (provider: string, sessionId: string) => Promise<boolean | undefined>) => Promise<void>;
  getRecordsPath: (cwd: string) => string;
};

// The implementation supplies this internal boundary; its name is provisional.
const recordsModulePath = '../features/interactive/interactiveSessionRecords.js';
const records = async (): Promise<Records> => import(recordsModulePath) as Promise<Records>;
const select = selectRecentSession as unknown as (cwd: string, lang: 'en', provider: string) => Promise<string | null>;
let cwd: string;

beforeEach(() => {
  cwd = join(getGlobalConfigDir(), 'project');
  mkdirSync(cwd, { recursive: true });
  picker.mockReset().mockResolvedValue(null);
});

async function turn(store: Records, provider: string, sessionId: string, input: string, response = 'reply') {
  await store.recordTurn({ cwd, provider, sessionId, input, response });
}

type Option = { value: string; label: string; details?: string[] };
async function options(provider: string): Promise<Option[]> {
  await select(cwd, 'en', provider);
  expect(picker).toHaveBeenCalled();
  return picker.mock.calls.at(-1)![1] as Option[];
}

it('lists recorded interactive conversations alongside neither CLI nor internal sessions', async () => {
  const store = await records();
  await turn(store, 'claude', 'interactive', 'real conversation');
  const displayed = await options('claude');
  expect(displayed.map((option) => option.value)).toEqual(['__new__', 'interactive']);
});

it('lists only sessions from the current provider', async () => {
  const store = await records();
  await turn(store, 'claude', 'claude-session', 'claude input');
  await turn(store, 'codex', 'codex-session', 'codex input');
  const displayed = await options('codex');
  expect(displayed.map((option) => option.value)).toEqual(['__new__', 'codex-session']);
});

it('moves a previously recorded conversation to the front after another input', async () => {
  const store = await records();
  await turn(store, 'codex', 'A', 'first A');
  await turn(store, 'codex', 'B', 'first B');
  expect((await options('codex')).map((item) => item.value)).toEqual(['__new__', 'B', 'A']);
  await turn(store, 'codex', 'A', 'second A');
  expect((await options('codex')).map((item) => item.value)).toEqual(['__new__', 'A', 'B']);
});

it('retains the latest three inputs and displays them in order with the latest reply', async () => {
  const store = await records();
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
  const store = await records();
  await turn(store, provider, 'present', 'present input');
  await turn(store, provider, 'missing', 'missing input');
  await store.cleanRecords(cwd, async (_provider, id) => id === 'present');
  expect((await store.listRecords(cwd, provider)).map((entry) => entry.sessionId)).toEqual(['present']);
});

it('retains and lists sessions whose provider cannot be checked', async () => {
  const store = await records();
  await turn(store, 'pi', 'pi-session', 'pi input');
  await store.cleanRecords(cwd, async () => undefined);
  expect((await store.listRecords(cwd, 'pi')).map((entry) => entry.sessionId)).toEqual(['pi-session']);
  expect((await options('pi')).map((item) => item.value)).toEqual(['__new__', 'pi-session']);
});

it('retains Kiro records found in the list or present only in an unrecognized diagnostic', async () => {
  const store = await records();
  const present = '123e4567-e89b-12d3-a456-426614174000';
  const unknown = '123e4567-e89b-12d3-a456-426614174001';
  await turn(store, 'kiro', present, 'present');
  await turn(store, 'kiro', unknown, 'unknown');
  kiroExec.mockResolvedValue({ stdout: '', stderr: `${present}  updated just now\ndiagnostic ${unknown}` });
  await store.cleanRecords(cwd, (provider, sessionId) => interactiveSessionExists(cwd, provider, sessionId));
  expect((await store.listRecords(cwd, 'kiro')).map((entry) => entry.sessionId)).toEqual([unknown, present]);
});

it('keeps the newest ten independently for each provider', async () => {
  const store = await records();
  await turn(store, 'pi', 'old-other', 'other');
  for (let index = 0; index < 11; index++) await turn(store, 'codex', `session-${index}`, `input-${index}`);
  await store.cleanRecords(cwd, async () => undefined);
  expect((await store.listRecords(cwd, 'codex')).map((entry) => entry.sessionId)).toEqual(
    Array.from({ length: 10 }, (_, index) => `session-${10 - index}`),
  );
  expect((await store.listRecords(cwd, 'pi')).map((entry) => entry.sessionId)).toEqual(['old-other']);
});

it('recreates unreadable records as empty and continues startup', async () => {
  const store = await records();
  const path = store.getRecordsPath(cwd);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '{invalid json');
  await expect(store.cleanRecords(cwd, async () => undefined)).resolves.toBeUndefined();
  expect(await store.listRecords(cwd, 'codex')).toEqual([]);
});
