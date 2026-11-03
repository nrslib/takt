import { beforeEach, expect, it, vi } from 'vitest';
import { SlackInquiryBindings, slackInquiryKey } from '../infra/slack/inquiryBindings.js';

const files = vi.hoisted(() => ({ content: undefined as string | undefined, write: vi.fn(), ensure: vi.fn() }));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: files.ensure,
  readPrivateFileState: () => files.content === undefined ? { state: { exists: false } } : { content: Buffer.from(files.content) } }));
vi.mock('../shared/utils/private-path-identity.js', () => ({ assertSafePath: vi.fn(), lstatOrUndefined: () => ({}) }));
vi.mock('../infra/config/project/sessionStore.js', () => ({ writeFileAtomic: files.write }));
const binding = { channelId: 'C0123', parentTs: '1700000000.000001', questionId: '650e8400-e29b-41d4-a716-446655440001',
  target: { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/repo' } };
beforeEach(() => {
  vi.resetAllMocks(); files.content = undefined;
  files.write.mockImplementation((_path: string, content: string) => { files.content = content; });
});

it('rejects corrupt saved bindings', () => {
  files.content = '[{"channelId":"C0123","token":"secret"}]';
  expect(() => new SlackInquiryBindings('/config', '/repo').find('C0123', binding.parentTs)).toThrow();
});

it('distinguishes standalone owners using structured identities', () => {
  const repository = { goalId: null, owner: { kind: 'repository' as const, repositoryDirectory: '/repo' } };
  const workspace = { goalId: null, owner: { kind: 'workspace' as const, workspaceId: '750e8400-e29b-41d4-a716-446655440001' } };
  expect(slackInquiryKey(repository, binding.questionId)).not.toBe(slackInquiryKey(workspace, binding.questionId));
});


it('saves a binding without publication state and restores it', () => {
  const store = new SlackInquiryBindings('/config', '/repo');
  store.save(binding);
  expect(JSON.parse(files.content!)).toEqual([binding]);
  expect(new SlackInquiryBindings('/config', '/repo').find(binding.channelId, binding.parentTs)).toEqual(binding);
  expect(() => store.save(binding)).toThrow();
});

it('does not retain a binding when writing fails', () => {
  files.write.mockImplementation(() => { throw new Error('write failed'); });
  const store = new SlackInquiryBindings('/config', '/repo');
  expect(() => store.save(binding)).toThrow('write failed');
  expect(store.find(binding.channelId, binding.parentTs)).toBeUndefined();
});


