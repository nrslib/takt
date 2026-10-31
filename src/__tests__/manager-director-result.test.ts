import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConversationService } from '../features/manager/conversationService.js';
import type { ConversationRecord } from '../infra/conversations/schema.js';
import { conversationId } from '../infra/conversations/identity.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';

const doubles = vi.hoisted(() => ({
  records: vi.fn<() => AsyncGenerator<ConversationRecord>>(),
  saveConversation: vi.fn(), readResult: vi.fn(), saveResult: vi.fn(), createNotification: vi.fn(),
  label: vi.fn((_key: string, _language: string, values: Record<string, string>) => Object.values(values).join(' ')),
}));
vi.mock('../infra/conversations/store.js', () => ({ ConversationStore: class {
  iterate = doubles.records;
  write = doubles.saveConversation;
} }));
vi.mock('../infra/conversations/speakerStore.js', () => ({ ConversationSpeakerStore: class {} }));
vi.mock('../infra/conversations/directorMessageResults.js', () => ({ DirectorMessageResultStore: class {
  read = doubles.readResult;
  write = doubles.saveResult;
} }));
vi.mock('../infra/conversations/directorNotifications.js', () => ({ DirectorNotificationStore: class {
  create = doubles.createNotification;
} }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: async (path: string) => path }));
vi.mock('../features/manager/assignment.js', () => ({
  resolveCurrentManagerAssignment: async (assignment: { repositoryDirectory: string }) => ({
    ...assignment, repositoryDirectories: [assignment.repositoryDirectory],
  }),
}));
vi.mock('../infra/config/resolveConfigValue.js', () => ({ resolveConfigValue: () => 'en' }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: doubles.label }));

const owner = { pid: 1234, identity: { startTime: 'unit-owner' }, version: 'test', cliPath: '/test/cli.js' };
const operationId = '11111111-1111-4111-8111-111111111111';
const source = conversationId({ kind: 'daemon' });
let record: ConversationRecord;
let service: ReturnType<typeof createConversationService>;
const resolve = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  doubles.saveResult.mockReset();
  doubles.createNotification.mockReset();
  record = { ...conversationRecord('/test/repository'),
    running: { operationId, kind: 'message', owner: { pid: owner.pid, identity: owner.identity }, directorConversationId: source } };
  doubles.records.mockImplementation(async function* () { yield record; });
  service = createConversationService({ configDirectory: '/test/config', owner,
    runtime: { resolve, close: async () => {} }, onDomainChange: vi.fn() });
});
afterEach(async () => { await service.close(); });

it.each([
  { result: { kind: 'reply' as const, message: 'saved reply' }, label: 'director.managerReply' },
  { result: { kind: 'error' as const, code: 'operation_failed', message: 'saved error' }, label: 'director.managerError' },
  { result: { kind: 'error' as const, code: 'interrupted', message: 'saved interruption' }, label: 'director.managerInterrupted' },
])('saves the $label notification after its result and before clearing running', async ({ result, label }) => {
  const saved = { operationId, conversationId: record.id, directorConversationId: source, result };
  doubles.readResult.mockReturnValue(saved);

  await service.restore();

  expect(doubles.saveResult).toHaveBeenCalledExactlyOnceWith(saved);
  expect(doubles.label).toHaveBeenCalledExactlyOnceWith(label, 'en', {
    operationId, managerId: record.id, message: result.message,
  });
  expect(doubles.createNotification).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(operationId), {
    key: expect.any(String), state: result.kind,
  });
  expect(doubles.saveConversation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ running: null }));
  expect(doubles.saveResult.mock.invocationCallOrder[0]).toBeLessThan(doubles.createNotification.mock.invocationCallOrder[0]!);
  expect(doubles.createNotification.mock.invocationCallOrder[0]).toBeLessThan(doubles.saveConversation.mock.invocationCallOrder[0]!);
  expect(resolve).not.toHaveBeenCalled();
});

it.each(['result', 'notification'])('retains running when the recovered director %s cannot be saved', async (failure) => {
  const retained = structuredClone(record);
  const saved = { operationId, conversationId: record.id, directorConversationId: source,
    result: { kind: 'reply' as const, message: 'saved reply' } };
  doubles.readResult.mockReturnValue(saved);
  const error = new Error('storage unavailable');
  if (failure === 'result') doubles.saveResult.mockImplementationOnce(() => { throw error; });
  else doubles.createNotification.mockImplementationOnce(() => { throw error; });

  await expect(service.restore()).resolves.toBeUndefined();

  expect(doubles.saveResult).toHaveBeenCalledExactlyOnceWith(saved);
  expect(doubles.saveConversation).not.toHaveBeenCalled();
  expect(record).toEqual(retained);
  if (failure === 'result') expect(doubles.createNotification).not.toHaveBeenCalled();
  else expect(doubles.createNotification).toHaveBeenCalledOnce();
  expect(resolve).not.toHaveBeenCalled();

  await service.close();
  service = createConversationService({ configDirectory: '/test/config', owner,
    runtime: { resolve, close: async () => {} }, onDomainChange: vi.fn() });
  await expect(service.restore()).resolves.toBeUndefined();

  expect(doubles.saveResult).toHaveBeenLastCalledWith(saved);
  expect(doubles.createNotification).toHaveBeenLastCalledWith(expect.stringContaining(operationId), {
    key: expect.any(String), state: 'reply',
  });
  expect(doubles.saveConversation).toHaveBeenCalledExactlyOnceWith({ ...retained, running: null, sessionId: null });
  expect(resolve).not.toHaveBeenCalled();
});
