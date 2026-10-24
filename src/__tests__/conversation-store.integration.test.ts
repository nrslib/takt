import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync) };
});

let store: ConversationStore;
let directory: string;
beforeEach(() => {
  directory = getGlobalConfigDir();
  store = new ConversationStore(directory);
});
afterEach(() => vi.restoreAllMocks());

it('round-trips the complete record, reserved goal identity and provider session', () => {
  const record = conversationRecord('/work/example');
  record.approval = { state: 'reserved', revision: 4, goalId: '11111111-1111-4111-8111-111111111111', repositoryDirectory: '/work/example' };
  record.running = { operationId: '22222222-2222-4222-8222-222222222222', kind: 'approve_summary', owner: { pid: 1234, identity: { startTime: 'owner-A' } } };
  store.write(record);
  expect(store.read(record.id, record.assignment)).toEqual(record);
  const path = join(directory, 'conversations', `${record.id}.json`);
  expect(JSON.parse(fs.readFileSync(path, 'utf8'))).toEqual(record);
  if (process.platform !== 'win32') {
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(join(directory, 'conversations')).mode & 0o777).toBe(0o700);
  }
});

it('returns missing only for a missing conversation and rejects malformed or unsupported records', () => {
  const record = conversationRecord('/work/example');
  expect(store.read(record.id, record.assignment)).toBeUndefined();
  store.write(record);
  const path = join(directory, 'conversations', `${record.id}.json`);
  for (const content of ['{', '{}', JSON.stringify({ ...record, schemaVersion: 2 })]) {
    fs.writeFileSync(path, content);
    expect(() => store.read(record.id, record.assignment)).toThrow();
  }
});

it('rejects an ID or filename that belongs to another assignment', () => {
  const record = conversationRecord('/work/example');
  const other = conversationRecord('/other/example');
  store.write(record);
  expect(() => store.read(record.id, other.assignment)).toThrow();
  fs.writeFileSync(join(directory, 'conversations', `${record.id}.json`), JSON.stringify(other));
  expect(() => store.read(record.id, record.assignment)).toThrow();
});

it.each(['temporary-write', 'rename'] as const)('preserves the prior complete file and cleans up after %s failure', (failure) => {
  const record = conversationRecord('/work/example');
  store.write(record);
  const path = join(directory, 'conversations', `${record.id}.json`);
  const prior = fs.readFileSync(path);
  const error = new Error('injected storage failure');
  if (failure === 'rename') vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw error; });
  else vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw error; });
  expect(() => store.write({ ...record, sessionId: 'new-session' })).toThrow(error);
  expect(fs.readFileSync(path)).toEqual(prior);
  expect(fs.readdirSync(join(directory, 'conversations'))).toEqual([`${record.id}.json`]);
});

it('rejects conversation text and history fields before writing any record', () => {
  const record = conversationRecord('/work/example');
  for (const field of ['message', 'reply', 'history', 'prompt']) {
    expect(() => store.write({ ...record, [field]: 'あいことばキリン' })).toThrow();
  }
  expect(store.read(record.id, record.assignment)).toBeUndefined();
});
