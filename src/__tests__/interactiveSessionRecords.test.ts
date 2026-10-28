import { beforeEach, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ content: undefined as string | undefined, writeError: false, readError: false, failAfterWrite: false }));
vi.mock('node:fs', () => ({
  existsSync: () => disk.content !== undefined,
  mkdirSync: vi.fn(),
  readFileSync: () => { if (disk.readError) throw new Error('read failed'); return disk.content; },
}));
vi.mock('../infra/config/paths.js', () => ({ getProjectConfigDir: () => '/project/.takt' }));
vi.mock('../infra/config/project/sessionStore.js', () => ({
  writeFileAtomic: (_path: string, value: string) => { if (disk.writeError) throw new Error('write failed'); disk.content = value; if (disk.failAfterWrite) disk.readError = true; },
}));
import { cleanRecords, listRecords, recordTurn, InteractiveSessionRecords } from '../features/interactive/interactiveSessionRecords.js';

beforeEach(() => { disk.content = undefined; disk.writeError = false; disk.readError = false; disk.failAfterWrite = false; });

it.each([false, true])('preserves cleaned records when subsequent reads fail: %s', async (failRead) => {
  recordTurn({ cwd: '/project', provider: 'codex', sessionId: 'A', input: 'input A', response: 'reply A' });
  const owner = new InteractiveSessionRecords('/project');
  disk.failAfterWrite = failRead;
  await owner.clean(async () => true);
  disk.failAfterWrite = false;
  const cleaned = disk.content;
  owner.record({ provider: 'codex', sessionId: 'B', input: 'input B', response: 'reply B' });
  expect(owner.list('codex').map((record) => record.sessionId)).toEqual(['B', 'A']);
  if (failRead) expect(disk.content).toBe(cleaned);
  disk.readError = false;
  owner.record({ provider: 'codex', sessionId: 'B', input: 'next B', response: 'next reply' });
  expect(JSON.parse(disk.content!)).toMatchObject([
    { sessionId: 'B', inputs: ['input B', 'next B'], response: 'next reply' },
    { sessionId: 'A', inputs: ['input A'], response: 'reply A' },
  ]);
});

it.each(['read', 'write'] as const)('retains updates after a normal %s failure and persists them after recovery', async (failure) => {
  const owner = new InteractiveSessionRecords('/project');
  await owner.clean(async () => undefined);
  owner.record({ provider: 'codex', sessionId: 'other', input: 'other input', response: 'other reply' });
  owner.record({ provider: 'codex', sessionId: 's', input: 'first', response: 'reply first' });
  const beforeFailure = disk.content;
  if (failure === 'read') disk.readError = true;
  else disk.writeError = true;
  expect(() => owner.record({ provider: 'codex', sessionId: 's', input: 'second', response: 'reply second' })).not.toThrow();
  expect(owner.list('codex')).toMatchObject([
    { sessionId: 's', inputs: ['first', 'second'], response: 'reply second', messageCount: 4 },
    { sessionId: 'other', inputs: ['other input'] },
  ]);
  expect(disk.content).toBe(beforeFailure);
  disk.readError = false;
  disk.writeError = false;
  owner.record({ provider: 'codex', sessionId: 's', input: 'third', response: 'reply third' });
  expect(JSON.parse(disk.content!)).toMatchObject([
    { sessionId: 's', inputs: ['first', 'second', 'third'], response: 'reply third', messageCount: 6 },
    { sessionId: 'other', inputs: ['other input'], response: 'other reply' },
  ]);
});

it('updates a conversation with the last three inputs and most recent response', () => {
  for (const input of ['one', 'two', 'three', 'four']) {
    recordTurn({ cwd: '/project', provider: 'codex', sessionId: 'session', input, response: `response ${input}` });
  }
  expect(listRecords('/project', 'codex')).toMatchObject([{ inputs: ['two', 'three', 'four'], response: 'response four', messageCount: 8 }]);
  expect(listRecords('/project', 'claude')).toEqual([]);
});

it('keeps unknown sessions and removes only confirmed missing sessions', async () => {
  for (const id of ['present', 'missing', 'unknown']) recordTurn({ cwd: '/project', provider: 'codex', sessionId: id, input: id, response: id });
  await cleanRecords('/project', async (_provider, id) => id === 'missing' ? false : id === 'present' ? true : undefined);
  expect(listRecords('/project', 'codex').map((entry) => entry.sessionId)).toEqual(['unknown', 'present']);
});

it('recreates corrupted stored records as an empty readable list', async () => {
  disk.content = '{broken';
  await cleanRecords('/project', async () => undefined);
  expect(JSON.parse(disk.content!)).toEqual([]);
  expect(listRecords('/project', 'codex')).toEqual([]);
});

it('uses the empty recovered records for subsequent conversation updates', async () => {
  disk.content = '{broken';
  const owner = new InteractiveSessionRecords('/project');
  await owner.clean(async () => undefined);
  expect(JSON.parse(disk.content!)).toEqual([]);
  expect(owner.list('codex')).toEqual([]);
  owner.record({ provider: 'codex', sessionId: 'B', input: 'input B', response: 'reply B' });
  expect(JSON.parse(disk.content!)).toMatchObject([{ sessionId: 'B', inputs: ['input B'], response: 'reply B' }]);
});

it('continues startup when corrupted records cannot be rewritten', async () => {
  disk.content = '{broken';
  disk.writeError = true;
  const records = new InteractiveSessionRecords('/project');
  await expect(records.clean(async () => undefined)).resolves.toBeUndefined();
  expect(records.list('codex')).toEqual([]);
  records.record({ provider: 'codex', sessionId: 's', input: 'first', response: 'reply' });
  expect(records.list('codex')).toMatchObject([{ sessionId: 's', inputs: ['first'] }]);
  expect(disk.content).toBe('{broken');
  disk.writeError = false;
  records.record({ provider: 'codex', sessionId: 's', input: 'second', response: 'reply 2' });
  expect(JSON.parse(disk.content!)).toMatchObject([{ sessionId: 's', inputs: ['first', 'second'], response: 'reply 2' }]);
});
