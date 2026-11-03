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

function recordCompletedTurn(owner: InteractiveSessionRecords, provider: string, sessionId: string, input: string, response: string): void {
  const inputRevision = owner.recordInput({ provider, sessionId, input });
  owner.recordResponse({ provider, sessionId, inputRevision, response });
}

it.each([false, true])('preserves cleaned records when subsequent reads fail: %s', async (failRead) => {
  recordTurn({ cwd: '/project', provider: 'codex', sessionId: 'A', input: 'input A', response: 'reply A' });
  const owner = new InteractiveSessionRecords('/project');
  disk.failAfterWrite = failRead;
  await owner.clean(async () => true);
  disk.failAfterWrite = false;
  const cleaned = disk.content;
  recordCompletedTurn(owner, 'codex', 'B', 'input B', 'reply B');
  expect(owner.list('codex').map((record) => record.sessionId)).toEqual(['B', 'A']);
  if (failRead) expect(disk.content).toBe(cleaned);
  disk.readError = false;
  recordCompletedTurn(owner, 'codex', 'B', 'next B', 'next reply');
  expect(JSON.parse(disk.content!)).toMatchObject([
    { sessionId: 'B', inputs: ['input B', 'next B'], response: 'next reply' },
    { sessionId: 'A', inputs: ['input A'], response: 'reply A' },
  ]);
});

it.each(['read', 'write'] as const)('retains updates after a normal %s failure and persists them after recovery', async (failure) => {
  const owner = new InteractiveSessionRecords('/project');
  await owner.clean(async () => undefined);
  recordCompletedTurn(owner, 'codex', 'other', 'other input', 'other reply');
  recordCompletedTurn(owner, 'codex', 's', 'first', 'reply first');
  const beforeFailure = disk.content;
  if (failure === 'read') disk.readError = true;
  else disk.writeError = true;
  expect(() => recordCompletedTurn(owner, 'codex', 's', 'second', 'reply second')).not.toThrow();
  expect(owner.list('codex')).toMatchObject([
    { sessionId: 's', inputs: ['first', 'second'], response: 'reply second', messageCount: 4 },
    { sessionId: 'other', inputs: ['other input'] },
  ]);
  expect(disk.content).toBe(beforeFailure);
  disk.readError = false;
  disk.writeError = false;
  recordCompletedTurn(owner, 'codex', 's', 'third', 'reply third');
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

it('records input before its response and ignores an older response after a newer input', () => {
  const owner = new InteractiveSessionRecords('/project');
  recordCompletedTurn(owner, 'codex', 'session', 'one', 'reply one');
  const olderRevision = owner.recordInput({ provider: 'codex', sessionId: 'session', input: 'two' });
  expect(owner.list('codex')).toMatchObject([{ inputs: ['one', 'two'], response: 'reply one', messageCount: 3 }]);

  const currentRevision = owner.recordInput({ provider: 'codex', sessionId: 'session', input: 'three' });
  owner.recordResponse({ provider: 'codex', sessionId: 'session', inputRevision: olderRevision, response: 'late reply' });
  expect(owner.list('codex')).toMatchObject([{ inputs: ['one', 'two', 'three'], response: 'reply one', messageCount: 4 }]);

  owner.recordResponse({ provider: 'codex', sessionId: 'session', inputRevision: currentRevision, response: 'reply three' });
  expect(listRecords('/project', 'codex')).toMatchObject([{ inputs: ['one', 'two', 'three'], response: 'reply three', messageCount: 5 }]);
});

it('keeps conversations ordered by their last input when an older response arrives', () => {
  const owner = new InteractiveSessionRecords('/project');
  const olderRevision = owner.recordInput({ provider: 'codex', sessionId: 'older', input: 'older input' });
  const modifiedOnInput = owner.list('codex')[0]!.modified;
  owner.recordInput({ provider: 'codex', sessionId: 'newer', input: 'newer input' });

  owner.recordResponse({ provider: 'codex', sessionId: 'older', inputRevision: olderRevision, response: 'older reply' });

  expect(owner.list('codex').map((record) => record.sessionId)).toEqual(['newer', 'older']);
  expect(owner.list('codex')[1]).toMatchObject({ modified: modifiedOnInput, response: 'older reply' });
});

it('discards only the selected provider session and ignores its late response', () => {
  const owner = new InteractiveSessionRecords('/project');
  recordCompletedTurn(owner, 'codex', 'selected', 'old input', 'old reply');
  recordCompletedTurn(owner, 'claude', 'selected', 'other input', 'other reply');
  const revision = owner.recordInput({ provider: 'codex', sessionId: 'selected', input: 'failed input' });

  owner.discard({ provider: 'codex', sessionId: 'selected' });
  owner.recordResponse({ provider: 'codex', sessionId: 'selected', inputRevision: revision, response: 'late reply' });

  expect(owner.list('codex')).toEqual([]);
  expect(owner.list('claude')).toMatchObject([{ sessionId: 'selected', response: 'other reply' }]);
});

it('does not restore a discarded session after a failed write recovers', () => {
  const owner = new InteractiveSessionRecords('/project');
  recordCompletedTurn(owner, 'codex', 'selected', 'old input', 'old reply');
  disk.writeError = true;
  owner.discard({ provider: 'codex', sessionId: 'selected' });
  expect(owner.list('codex')).toEqual([]);

  disk.writeError = false;
  recordCompletedTurn(owner, 'codex', 'new', 'new input', 'new reply');
  expect(listRecords('/project', 'codex')).toMatchObject([{ sessionId: 'new', response: 'new reply' }]);
  expect(listRecords('/project', 'codex')).toHaveLength(1);
});

it('does not restore a discarded session after a failed read recovers', () => {
  recordTurn({ cwd: '/project', provider: 'codex', sessionId: 'selected', input: 'old input', response: 'old reply' });
  const owner = new InteractiveSessionRecords('/project');
  disk.readError = true;
  owner.discard({ provider: 'codex', sessionId: 'selected' });
  expect(owner.list('codex')).toEqual([]);

  disk.readError = false;
  recordCompletedTurn(owner, 'codex', 'new', 'new input', 'new reply');
  expect(listRecords('/project', 'codex')).toMatchObject([{ sessionId: 'new', response: 'new reply' }]);
  expect(listRecords('/project', 'codex')).toHaveLength(1);
});

it('keeps unknown sessions and removes only confirmed missing sessions', async () => {
  for (const id of ['present', 'missing', 'unknown']) recordTurn({ cwd: '/project', provider: 'codex', sessionId: id, input: id, response: id });
  await cleanRecords('/project', async (_provider, id) => id === 'missing' ? false : id === 'present' ? true : undefined);
  expect(listRecords('/project', 'codex').map((entry) => entry.sessionId)).toEqual(['unknown', 'present']);
});

it('recreates empty records when startup cleanup cannot reread them', async () => {
  recordTurn({ cwd: '/project', provider: 'codex', sessionId: 'existing', input: 'old', response: 'old reply' });
  const owner = new InteractiveSessionRecords('/project');
  await owner.clean(async () => { disk.readError = true; return true; });
  expect(disk.content).toBe('[]');
  expect(owner.list('codex')).toEqual([]);

  disk.readError = false;
  recordCompletedTurn(owner, 'codex', 'new', 'new input', 'new reply');
  expect(listRecords('/project', 'codex')).toMatchObject([{ sessionId: 'new', response: 'new reply' }]);
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
  recordCompletedTurn(owner, 'codex', 'B', 'input B', 'reply B');
  expect(JSON.parse(disk.content!)).toMatchObject([{ sessionId: 'B', inputs: ['input B'], response: 'reply B' }]);
});

it('continues startup when corrupted records cannot be rewritten', async () => {
  disk.content = '{broken';
  disk.writeError = true;
  const records = new InteractiveSessionRecords('/project');
  await expect(records.clean(async () => undefined)).resolves.toBeUndefined();
  expect(records.list('codex')).toEqual([]);
  recordCompletedTurn(records, 'codex', 's', 'first', 'reply');
  expect(records.list('codex')).toMatchObject([{ sessionId: 's', inputs: ['first'] }]);
  expect(disk.content).toBe('{broken');
  disk.writeError = false;
  recordCompletedTurn(records, 'codex', 's', 'second', 'reply 2');
  expect(JSON.parse(disk.content!)).toMatchObject([{ sessionId: 's', inputs: ['first', 'second'], response: 'reply 2' }]);
});
