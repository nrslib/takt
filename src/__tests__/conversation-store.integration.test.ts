import * as fs from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { conversationRecord, directorConversationRecord } from './helpers/conversation-fixtures.js';
import { DirectorMessageResultStore } from '../infra/conversations/directorMessageResults.js';
import { conversationId } from '../infra/conversations/identity.js';

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

it('restores the director session without replacing a repository manager record', () => {
  const manager = conversationRecord('/work/example');
  store.write(manager);
  const managerPath = join(directory, 'conversations', `${manager.id}.json`);
  const priorManager = fs.readFileSync(managerPath);
  const director = { ...directorConversationRecord(), sessionId: 'director-session' };

  store.write(director);
  const restored = new ConversationStore(directory).read(director.id, director.assignment);

  expect(restored).toEqual(director);
  expect(restored?.agent).toBe('director');
  expect(director.id).not.toBe(manager.id);
  expect(fs.readFileSync(managerPath)).toEqual(priorManager);
  expect(new ConversationStore(directory).read(manager.id, manager.assignment)).toEqual(manager);
});

it('keeps director conversations scoped to the daemon configuration directory', () => {
  const director = { ...directorConversationRecord(), sessionId: 'director-session' };
  store.write(director);
  const other = new ConversationStore(join(directory, 'other-daemon'));

  expect(other.read(director.id, director.assignment)).toBeUndefined();
  expect(store.read(director.id, director.assignment)).toEqual(director);
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

it('enumerates saved director inputs and restores them without changing their order or human proposal', async () => {
  const record = { ...conversationRecord('/work/example'), directorMessages: [1, 2].map((index) => ({
    operationId: `00000000-0000-4000-8000-00000000000${index}`, text: `director ${index}`,
    speaker: { namespace: 'agent' as const, id: 'director' as const }, directorConversationId: conversationId({ kind: 'daemon' }),
  })) };
  store.write(record);
  const restored = [];
  for await (const value of new ConversationStore(directory).iterate()) restored.push(value);
  expect(restored).toEqual([record]);
});

it.each(['reply', 'failure', 'interruption'] as const)('reads a durable director %s through a new result store instance', async (kind) => {
  const record = conversationRecord('/work/example');
  const result = kind === 'reply' ? { kind: 'reply' as const, message: 'director reply' }
    : { kind: 'error' as const, code: kind === 'failure' ? 'operation_failed' : 'interrupted', message: kind };
  const saved = { operationId: '00000000-0000-4000-8000-000000000001', conversationId: record.id,
    directorConversationId: conversationId({ kind: 'daemon' }), result };
  const results = new DirectorMessageResultStore(directory);
  expect(results.read(saved.operationId)).toBeUndefined();
  results.write(saved);
  results.write(saved);
  expect(new DirectorMessageResultStore(directory).read(saved.operationId)).toEqual(saved);
  const listed = [];
  for await (const value of results.iterate(record.id)) listed.push(value);
  expect(listed).toEqual([saved]);
  const unrelated = [];
  for await (const value of results.iterate(conversationRecord('/other/example').id)) unrelated.push(value);
  expect(unrelated).toEqual([]);
});

it('keeps an existing director result unchanged on conflicting write and on failed atomic publication', () => {
  const saved = { operationId: '00000000-0000-4000-8000-000000000001', conversationId: conversationRecord('/work/example').id,
    directorConversationId: conversationId({ kind: 'daemon' }), result: { kind: 'reply' as const, message: 'original reply' } };
  const results = new DirectorMessageResultStore(directory);
  results.write(saved);
  expect(() => results.write({ ...saved, result: { kind: 'reply', message: 'replacement' } })).toThrow();
  vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('publication failed'); });
  const other = { ...saved, operationId: '00000000-0000-4000-8000-000000000002' };
  expect(() => results.write(other)).toThrow();
  expect(results.read(saved.operationId)).toEqual(saved);
  expect(results.read(other.operationId)).toBeUndefined();
});

it('rejects corrupt and mismatched director results instead of treating them as missing', () => {
  const saved = { operationId: '00000000-0000-4000-8000-000000000001', conversationId: conversationRecord('/work/example').id,
    directorConversationId: conversationId({ kind: 'daemon' }), result: { kind: 'reply' as const, message: 'reply' } };
  const results = new DirectorMessageResultStore(directory); results.write(saved);
  const path = join(directory, 'director-message-results', `${saved.operationId}.json`);
  fs.writeFileSync(path, '{'); expect(() => results.read(saved.operationId)).toThrow();
  fs.writeFileSync(path, JSON.stringify({ ...saved, operationId: '00000000-0000-4000-8000-000000000002' }));
  expect(() => results.read(saved.operationId)).toThrow();
});

it.each(['json', 'identity', 'filename'] as const)('refuses an invalid %s during startup conversation enumeration', async (failure) => {
  const record = conversationRecord('/work/example');
  store.write(record);
  const path = join(directory, 'conversations', `${record.id}.json`);
  if (failure === 'json') fs.writeFileSync(path, '{');
  else if (failure === 'identity') fs.writeFileSync(path, JSON.stringify(conversationRecord('/other/repository')));
  else fs.renameSync(path, join(directory, 'conversations', 'invalid.json'));
  const enumerate = async () => {
    const records = [];
    for await (const value of store.iterate()) records.push(value);
    return records;
  };
  await expect(enumerate()).rejects.toThrow();
});
