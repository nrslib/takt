import { beforeEach, expect, it, vi } from 'vitest';
import { createDirectorSlackConversationPort } from '../features/director/slackConversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationError } from '../features/manager/conversationErrors.js';
import type { ConversationDelivery, ConversationInput, SnapshotRead } from '../features/manager/conversationPort.js';
import type { SlackClient } from '../infra/slack/client.js';

vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: vi.fn() }) }));
beforeEach(() => vi.clearAllMocks());
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
    postThreadMessage: vi.fn<SlackClient['postThreadMessage']>(), openModal: vi.fn<SlackClient['openModal']>(),
    stopAccepting: vi.fn(), close: vi.fn<SlackClient['close']>() };
  client.postMessage.mockResolvedValue({ kind: 'delivered', parentTs: 'posted' });
  client.postThreadMessage.mockResolvedValue({ kind: 'delivered' });
  const port = createDirectorSlackConversationPort({ channelId: 'C0DIR', input, client, language: 'en' });
  return { port, input, client, read };
}
function result(operationId = 'operation') {
  return { kind: 'result' as const, operationId, result: { kind: 'reply' as const, message: 'Director reply' } };
}
const version = { revision: 1, stateSequence: 1, operationId: 'operation' };

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
  expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith({ channelId: 'C0DIR', parentTs: endpoint.parentTs }, 'Director reply');
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  await port.close();
  expect(input.detach).toHaveBeenCalledOnce();
});

it('rejects results from another conversation or operation and delivers admitted work after receiving stops', async () => {
  const { port, input, client } = fixture();
  await port.receive(endpoint, 'status');
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

it.each(['busy', 'error', 'open failure', 'submit failure'] as const)('does not resubmit after %s and releases any attachment', async (outcome) => {
  const { port, input, client } = fixture();
  if (outcome === 'busy') input.submit.mockResolvedValueOnce({ kind: 'busy', operationId: 'other' });
  if (outcome === 'error') input.submit.mockResolvedValueOnce({ kind: 'error', code: 'storage_error', message: 'Cannot save' });
  if (outcome === 'open failure') input.open.mockRejectedValueOnce(new ConversationError('busy'));
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
