import { beforeEach, expect, it, vi } from 'vitest';
import { SlackInquiryBindings, slackInquiryKey } from '../infra/slack/inquiryBindings.js';
const files = vi.hoisted(() => ({ content: undefined as string | undefined, write: vi.fn() }));
vi.mock('../infra/daemon/privateFile.js', () => ({
  readPrivateFile: async () => files.content === undefined ? undefined : Buffer.from(files.content),
  writePrivateFile: files.write,
}));
vi.mock('../infra/daemon/lock.js', () => ({ FileAsyncLock: class {
  async exclusive<T>(_path: string, action: () => Promise<T>): Promise<T> { return action(); }
} }));
const binding = { channelId: 'C0123', parentTs: '1700000000.000001', questionId: '650e8400-e29b-41d4-a716-446655440001',
  target: { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/repo' } };
beforeEach(() => {
  vi.resetAllMocks(); files.content = undefined;
  files.write.mockImplementation(async (_path: string, content: string) => { files.content = content; });
});
it('rejects corrupt saved bindings', async () => {
  files.content = '[{"channelId":"C0123","token":"secret"}]';
  await expect(new SlackInquiryBindings('/config', '/repo').find('C0123', binding.parentTs)).rejects.toThrow();
});
it('distinguishes standalone owners using structured identities', () => {
  const repository = { goalId: null, owner: { kind: 'repository' as const, repositoryDirectory: '/repo' } };
  const workspace = { goalId: null, owner: { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001' } };
  expect(slackInquiryKey(repository, binding.questionId)).not.toBe(slackInquiryKey(workspace, binding.questionId));
});
it('saves a binding and restores it', async () => {
  const store = new SlackInquiryBindings('/config', '/repo');
  await store.save(binding);
  expect(JSON.parse(files.content!)).toEqual([binding]);
  expect(await new SlackInquiryBindings('/config', '/repo').find(binding.channelId, binding.parentTs)).toEqual(binding);
  expect(await store.question(binding.channelId, binding.target, binding.questionId)).toEqual(binding);
  await expect(store.save(binding)).rejects.toThrow();
});
it('does not retain a binding when writing fails', async () => {
  files.write.mockRejectedValue(new Error('write failed'));
  const store = new SlackInquiryBindings('/config', '/repo');
  await expect(store.save(binding)).rejects.toThrow();
  expect(await store.find(binding.channelId, binding.parentTs)).toBeUndefined();
});
