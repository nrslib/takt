import { beforeEach, expect, it, vi } from 'vitest';
import { createDirectorSlackConversationPort } from '../features/director/slackConversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationError } from '../features/manager/conversationErrors.js';
import type { ConversationDelivery, ConversationInput, SnapshotRead } from '../features/manager/conversationPort.js';
import type { SlackClient } from '../infra/slack/client.js';
import { getLabel } from '../shared/i18n/index.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import type { SlackInquiryBinding } from '../infra/slack/inquiryBindings.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { SLACK_INQUIRY_ACTION } from '../features/manager/slackInquiryBlocks.js';

const inquiryBindings = vi.hoisted(() => new Map<string, SlackInquiryBinding>());
vi.mock('../infra/slack/inquiryBindings.js', async (original) => ({
  ...await original<typeof import('../infra/slack/inquiryBindings.js')>(),
  SlackInquiryBindings: class {
    async find(channelId: string, parentTs: string) { return inquiryBindings.get(JSON.stringify([channelId, parentTs])); }
    async question(channelId: string, target: SlackInquiryBinding['target'], questionId: string) {
      return [...inquiryBindings.values()].find((binding) => binding.channelId === channelId
        && binding.questionId === questionId && JSON.stringify(binding.target) === JSON.stringify(target));
    }
    async save(binding: SlackInquiryBinding) { inquiryBindings.set(JSON.stringify([binding.channelId, binding.parentTs]), binding); }
  },
}));

vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: vi.fn() }) }));
beforeEach(() => { vi.clearAllMocks(); inquiryBindings.clear(); });
const id = conversationId({ kind: 'daemon' });
const endpoint = { teamId: 'T1', channelId: 'C0DIR', userId: 'U0AAA', parentTs: '1700000000.000001' };
function fixture() {
  const read: SnapshotRead = { transferId: 'read', conversationId: id, revision: 0, stateSequence: 0, operationId: null,
    mode: 'initial', items: (async function* () {})(), complete: vi.fn(), cancel: vi.fn() };
  const input = { open: vi.fn<ConversationInput['open']>(), submit: vi.fn<ConversationInput['submit']>(),
    snapshot: vi.fn<ConversationInput['snapshot']>(), detach: vi.fn<ConversationInput['detach']>() };
  input.open.mockResolvedValue({ attachmentId: 'attachment', read });
  input.submit.mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  const client = { start: vi.fn<SlackClient['start']>(), postMessage: vi.fn<SlackClient['postMessage']>(),
    updateMessage: vi.fn<SlackClient['updateMessage']>().mockResolvedValue({ kind: 'delivered' }), postThreadMessage: vi.fn<SlackClient['postThreadMessage']>(),
    stopAccepting: vi.fn(), close: vi.fn<SlackClient['close']>() };
  client.postMessage.mockResolvedValue({ kind: 'delivered', parentTs: 'posted' });
  client.postThreadMessage.mockResolvedValue({ kind: 'delivered' });
  const port = createDirectorSlackConversationPort({ configDirectory: '/config', channelId: 'C0DIR', input, client, language: 'en' });
  return { port, input, client, read };
}
function result(operationId = 'operation') {
  return { kind: 'result' as const, operationId, result: { kind: 'reply' as const, message: 'Director reply' } };
}
const version = { revision: 1, stateSequence: 1, operationId: 'operation' };

it('updates an existing Slack question through promotion and return and rejects its old thread and buttons while delegated', async () => {
  const { port, input, client } = fixture();
  const target = { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/assigned' };
  let question = createInquiry({ body: 'Which format?', options: ['CSV', 'JSON'] });
  input.open.mockImplementation(async () => ({ attachmentId: 'current', read: {
    transferId: 'current', conversationId: id, revision: 0, stateSequence: 0, operationId: null, mode: 'initial',
    items: (async function* () { if (question.recipient === 'human') yield { kind: 'inquiry' as const, inquiry: { target, question } }; })(),
    complete: vi.fn(), cancel: vi.fn(),
  } }));
  const thread = { ...endpoint, parentTs: 'posted' };
  try {
    await port.delivery.deliver(id, { kind: 'inquiry', target, question }, version);
    expect(client.postMessage).toHaveBeenCalledOnce();
    question = { ...question, recipient: 'director' };
    await port.delivery.deliver(id, { kind: 'inquiry', target, question }, version);
    expect(client.updateMessage).toHaveBeenLastCalledWith({ channelId: 'C0DIR', parentTs: 'posted' }, expect.stringContaining('director'), []);
    await port.receive(thread, 'Old reply');
    await port.receiveAction(thread, `${SLACK_INQUIRY_ACTION}_option_0`, 'option_0');
    expect(input.submit).not.toHaveBeenCalled();
    question = { ...question, recipient: 'human' };
    await port.delivery.deliver(id, { kind: 'inquiry', target, question }, version);
    expect(client.postMessage).toHaveBeenCalledOnce();
    expect(client.updateMessage).toHaveBeenLastCalledWith({ channelId: 'C0DIR', parentTs: 'posted' }, expect.stringContaining('Which format?'),
      expect.arrayContaining([expect.objectContaining({ type: 'actions' })]));
    await port.receiveAction(thread, `${SLACK_INQUIRY_ACTION}_option_0`, 'option_0');
    expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: {
      kind: 'answer_question', target, questionId: question.id, answer: { text: 'CSV' }, source: 'slack',
    } }));
  } finally { await port.close(); }
});

it('delivers a human inquiry to director Slack and saves a thread reply as an answer without asking the AI', async () => {
  const { port, input, client, read } = fixture();
  const notice: Extract<PortOutput, { kind: 'inquiry' }> = { kind: 'inquiry',
    target: { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/assigned' },
    question: { id: '650e8400-e29b-41d4-a716-446655440001', kind: 'question', recipient: 'human',
      status: 'pending', body: 'Which output format?' },
  };
  read.items = (async function* () { yield { kind: 'inquiry' as const, inquiry: { target: notice.target, question: notice.question } }; })();
  try {
    await port.delivery.deliver(id, notice, { ...version, operationId: null });

    expect(client.postMessage).toHaveBeenCalledExactlyOnceWith('C0DIR', expect.stringContaining(notice.question.body), expect.any(Array));
    expect(input.submit).not.toHaveBeenCalled();
    await port.receive({ ...endpoint, parentTs: 'posted' }, 'CSV');
    expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: {
      kind: 'answer_question', target: notice.target, questionId: notice.question.id, answer: { text: 'CSV' }, source: 'slack',
    } }));
  } finally { await port.close(); }
});

it('acknowledges queued speech and later delivers its result to the same thread', async () => {
  const { port, input, client } = fixture();
  input.submit.mockResolvedValueOnce({ kind: 'accepted', operationId: 'operation', queuedMessageCount: 2 });
  await port.receive(endpoint, 'status');
  expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith({ channelId: endpoint.channelId, parentTs: endpoint.parentTs },
    expect.any(String));
  expect(input.detach).not.toHaveBeenCalled();
  const delivery = input.open.mock.calls[0]![1];
  await delivery.deliver(id, result(), version);
  expect(client.postThreadMessage).toHaveBeenCalledTimes(2);
  expect(client.postThreadMessage).toHaveBeenLastCalledWith({ channelId: endpoint.channelId, parentTs: endpoint.parentTs }, 'Director reply');
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  await port.close();
});

it.each(['ja', 'en'] as const)('returns queue capacity rejection only to the originating Slack thread (%s)', async (lang) => {
  const { port, input, client } = fixture();
  const message = getLabel('manager.conversation.queue_full', lang);
  input.submit.mockResolvedValueOnce({ kind: 'error', code: 'queue_full', message });
  await port.receive(endpoint, 'capacity request');
  expect(input.submit).toHaveBeenCalledOnce();
  expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(
    { channelId: endpoint.channelId, parentTs: endpoint.parentTs }, message);
  expect(client.postMessage).not.toHaveBeenCalled();
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  await port.close();
});

it('binds Slack speech to the daemon conversation and preserves the original message', async () => {
  const { port, input, read } = fixture();
  await port.receive(endpoint, '/make-goal\n```text\nmessage\n```');
  const bindingKey = JSON.stringify(['T1', 'C0DIR', endpoint.parentTs]);
  expect(input.open).toHaveBeenCalledWith({ conversationId: id, assignment: { kind: 'daemon' },
    binding: { port: 'slack', key: bindingKey, counterpart: { namespace: 'slack-thread', id: bindingKey } },
    speaker: { namespace: 'slack-user', id: JSON.stringify(['T1', 'U0AAA']) } }, expect.any(Object));
  expect(input.submit).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: 'message', text: '/make-goal\n```text\nmessage\n```' } }));
  expect(read.cancel).toHaveBeenCalledOnce();
  await port.close();
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
});

it('delivers an immediate result once to its own thread and detaches after failed delivery', async () => {
  const { port, input, client, read } = fixture();
  let delivery!: ConversationDelivery;
  input.open.mockImplementationOnce(async (_open, value) => { delivery = value; return { attachmentId: 'attachment', read }; });
  let delivering!: Promise<unknown>;
  input.submit.mockImplementationOnce(async () => {
    delivering = delivery.deliver(id, result(), version);
    return { kind: 'accepted', operationId: 'operation' };
  });
  client.postThreadMessage.mockResolvedValue({ kind: 'unavailable', reason: 'failed' });
  await port.receive(endpoint, 'status');
  await delivering;
  await delivery.deliver(id, result(), version);
  expect(client.postThreadMessage).toHaveBeenLastCalledWith({ channelId: 'C0DIR', parentTs: endpoint.parentTs }, 'Director reply');
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  await port.close();
  expect(input.detach).toHaveBeenCalledOnce();
});

it('rejects results from another conversation or operation and delivers admitted work after receiving stops', async () => {
  const { port, input, client } = fixture();
  await port.receive(endpoint, 'status');
  client.postThreadMessage.mockClear();
  const delivery = input.open.mock.calls[0]![1];
  await delivery.deliver('other', result(), version);
  await delivery.deliver(id, result('other'), { ...version, operationId: 'other' });
  expect(client.postThreadMessage).not.toHaveBeenCalled();
  port.stopAccepting();
  await port.receive(endpoint, 'ignored');
  expect(input.submit).toHaveBeenCalledOnce();
  await delivery.deliver(id, result(), version);
  expect(client.postThreadMessage).toHaveBeenCalledOnce();
  expect(input.detach).toHaveBeenCalledOnce();
  await port.close();
});

it.each(['capacity', 'error', 'open failure', 'submit failure'] as const)('does not resubmit after %s and releases any attachment', async (outcome) => {
  const { port, input, client } = fixture();
  if (outcome === 'capacity') input.submit.mockResolvedValueOnce({ kind: 'error', code: 'queue_full', message: 'Queue full' });
  if (outcome === 'error') input.submit.mockResolvedValueOnce({ kind: 'error', code: 'storage_error', message: 'Cannot save' });
  if (outcome === 'open failure') input.open.mockRejectedValueOnce(new ConversationError('queue_full'));
  if (outcome === 'submit failure') input.submit.mockRejectedValueOnce(new Error('xapp-private xoxb-private'));
  await port.receive(endpoint, 'status');
  expect(input.submit).toHaveBeenCalledTimes(outcome === 'open failure' ? 0 : 1);
  expect(input.detach).toHaveBeenCalledTimes(outcome === 'open failure' ? 0 : 1);
  expect(client.postThreadMessage).toHaveBeenCalledOnce();
  for (const [, text] of client.postThreadMessage.mock.calls) {
    for (const secret of ['xapp-private', 'xoxb-private']) expect(text).not.toContain(secret);
  }
  await port.close();
});

it('does not submit after admission closes while open is pending', async () => {
  const { port, input, read } = fixture();
  let finishOpen!: (value: Awaited<ReturnType<ConversationInput['open']>>) => void;
  input.open.mockReturnValueOnce(new Promise((resolve) => { finishOpen = resolve; }));
  const receiving = port.receive(endpoint, 'status');
  await vi.waitFor(() => expect(input.open).toHaveBeenCalledOnce());
  port.stopAccepting();
  const closing = port.close();
  finishOpen({ attachmentId: 'attachment', read });
  await Promise.all([receiving, closing]);
  expect(input.submit).not.toHaveBeenCalled();
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
});

it.each(['delivered', 'unavailable'] as const)('posts one notification batch and awaits its %s outcome before close', async (kind) => {
  const { port, client } = fixture();
  let finishPost!: (value: Awaited<ReturnType<SlackClient['postMessage']>>) => void;
  client.postMessage.mockReturnValueOnce(new Promise((resolve) => { finishPost = resolve; }));
  await port.notifications.deliver([]);
  expect(client.postMessage).not.toHaveBeenCalled();
  port.stopAccepting();
  const sending = port.notifications.deliver([{ id: 'one', message: 'Completed A' }, { id: 'two', message: 'Decide B' }]);
  expect(client.postMessage).toHaveBeenCalledExactlyOnceWith('C0DIR', expect.stringContaining('Completed A\n\nDecide B'), []);
  let closed = false;
  const closing = port.close().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  finishPost(kind === 'delivered' ? { kind, parentTs: 'posted' } : { kind, reason: 'unavailable' });
  await Promise.all([sending, closing]);
  await port.notifications.deliver([{ id: 'late', message: 'ignored' }]);
  expect(client.postMessage).toHaveBeenCalledOnce();
});
