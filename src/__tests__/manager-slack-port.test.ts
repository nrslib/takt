import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ManagerAssignment } from '../features/manager/startupResolution.js';
import { createSlackConversationPort, SLACK_GOAL_APPROVE } from '../features/manager/slackConversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationError } from '../features/manager/conversationErrors.js';
import type { ConversationDelivery, ConversationInput, SnapshotRead, SnapshotItem } from '../features/manager/conversationPort.js';
import type { SlackClient } from '../infra/slack/client.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';

const inquiries = vi.hoisted(() => ({ find: vi.fn(), question: vi.fn(), save: vi.fn() }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string) => key }));
vi.mock('../infra/slack/inquiryBindings.js', async (original) => ({ ...await original<typeof import('../infra/slack/inquiryBindings.js')>(),
  SlackInquiryBindings: class { find = inquiries.find; question = inquiries.question; save = inquiries.save; } }));
beforeEach(() => {
  for (const mock of Object.values(inquiries)) mock.mockReset();
});
const endpoint = { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' };
function fixture() {
  const input: ConversationInput = { open: vi.fn(), submit: vi.fn(), snapshot: vi.fn(), detach: vi.fn() };
  const client: SlackClient = { start: vi.fn(), postMessage: vi.fn().mockResolvedValue({ kind: 'delivered', parentTs: endpoint.parentTs }),
    postThreadMessage: vi.fn().mockResolvedValue({ kind: 'delivered' }), stopAccepting: vi.fn(), close: vi.fn() };
  const resolveAssignment = vi.fn<() => Promise<ManagerAssignment>>(async () => ({ kind: 'repository', repositoryDirectory: '/canonical', repositoryDirectories: ['/canonical'] }));
  const port = createSlackConversationPort({ repositoryDirectory: '/canonical', configDirectory: '/config', resolveAssignment, channelId: 'C0123', input, client, language: 'ja' });
  return { input, client, port, resolveAssignment };
}
function read(items: SnapshotItem[] = []): SnapshotRead {
  return { transferId: 'read', conversationId: 'conversation', revision: 0, stateSequence: 0, operationId: null,
    mode: 'initial', items: (async function* () { yield* items; })(), complete: vi.fn(), cancel: vi.fn() };
}
it.each(['invalid', '{}', '{"conversationId":"other","revision":4}', '{"conversationId":"other","revision":-1}'])('ignores an invalid or mismatched goal button value %s', async (value) => {
  const { port, input } = fixture();
  await port.receiveAction(endpoint, SLACK_GOAL_APPROVE, value);
  expect(input.open).not.toHaveBeenCalled();
  expect(input.submit).not.toHaveBeenCalled();
});
it('detaches the operation if the proposal cannot be posted', async () => {
  const { port, input, client } = fixture();
  let delivery!: ConversationDelivery;
  vi.mocked(input.open).mockImplementation(async (_open, value) => { delivery = value; return { attachmentId: 'attachment', read: read() }; });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  vi.mocked(client.postThreadMessage).mockResolvedValue({ kind: 'unavailable', reason: 'failed' });
  await port.receive(endpoint, '/make-goal');
  const record = conversationRecord('/canonical');
  await delivery.deliver(record.id, { kind: 'pending', state: { conversationId: record.id, assignment: record.assignment,
    revision: record.revision, pending: record.pending, approval: null, running: null, interrupted: false } },
  { revision: record.revision, stateSequence: 1, operationId: 'operation' });
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  await delivery.deliver(record.id, { kind: 'result', operationId: 'operation', result: { kind: 'reply', message: 'reply' } },
    { revision: record.revision, stateSequence: 1, operationId: 'operation' });
  expect(client.postThreadMessage).toHaveBeenCalledTimes(2);
  await port.close();
});
it('posts a proposal once when another Slack attachment receives the same update', async () => {
  const { port, input, client } = fixture();
  const deliveries: ConversationDelivery[] = [];
  vi.mocked(input.open).mockImplementation(async (_open, delivery) => {
    deliveries.push(delivery);
    return { attachmentId: `attachment-${deliveries.length}`, read: read() };
  });
  vi.mocked(input.submit).mockResolvedValueOnce({ kind: 'accepted', operationId: 'first' })
    .mockResolvedValueOnce({ kind: 'accepted', operationId: 'second' });
  await port.receive(endpoint, '/make-goal');
  await port.receive(endpoint, 'another turn');
  const record = conversationRecord('/canonical');
  const output = { kind: 'pending' as const, state: { conversationId: record.id, assignment: record.assignment,
    revision: record.revision, pending: record.pending, approval: null, running: null, interrupted: false } };
  const version = { revision: record.revision, stateSequence: 1, operationId: 'first' };
  await Promise.all(deliveries.map((delivery) => delivery.deliver(record.id, output, version)));
  expect(client.postThreadMessage).toHaveBeenCalledTimes(3);
  await port.close();
});
it('resolves the current assignment and preserves Slack binding and speaker namespaces', async () => {
  const { port } = fixture();
  const resolved = await port.resolve(endpoint);
  expect(resolved.conversationId).toBe(conversationId({ kind: 'repository', repositoryDirectory: '/canonical' }));
  expect(resolved.binding).toEqual({ port: 'slack', key: '["T1","C0123","1700000000.000001"]',
    counterpart: { namespace: 'slack-thread', id: '["T1","C0123","1700000000.000001"]' } });
  expect(resolved.speaker).toEqual({ namespace: 'slack-user', id: '["T1","U0AAA"]' });
});
it('routes messages and standalone inquiry delivery and answers to the workspace created after startup', async () => {
  const { port, input, client, resolveAssignment } = fixture();
  const before = await port.resolve(endpoint);
  const workspace: ManagerAssignment = { kind: 'workspace', workspaceId: randomUUID(), name: 'workspace', repositoryDirectories: ['/canonical'] };
  resolveAssignment.mockResolvedValue(workspace);
  const id = conversationId(workspace);
  const target = { goalId: null, owner: { kind: 'workspace' as const, workspaceId: workspace.workspaceId } };
  const question = createInquiry({ body: 'Which option?' });
  vi.mocked(input.open).mockImplementation(async () => ({ attachmentId: randomUUID(), read: read([{ kind: 'inquiry', inquiry: { target, question } }]) }));
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: randomUUID() });
  await port.receive(endpoint, 'after workspace creation');
  expect(input.open).toHaveBeenCalledWith(expect.objectContaining({ conversationId: id, assignment: target.owner }), expect.any(Object));
  await port.delivery.deliver(before.conversationId, { kind: 'inquiry', target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: '/canonical' } }, question },
    { revision: 0, stateSequence: 1, operationId: null });
  expect(client.postMessage).not.toHaveBeenCalled();
  await port.delivery.deliver(id, { kind: 'inquiry', target, question }, { revision: 0, stateSequence: 2, operationId: null });
  expect(client.postMessage).toHaveBeenCalledOnce();
  expect(inquiries.save).toHaveBeenCalledWith(expect.objectContaining({ target, questionId: question.id }));
  inquiries.find.mockReturnValue({ channelId: endpoint.channelId, parentTs: endpoint.parentTs, target, questionId: question.id });
  await port.receive(endpoint, 'chosen option');
  expect(input.open).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: id, assignment: target.owner }), expect.any(Object));
  expect(input.submit).toHaveBeenLastCalledWith(expect.objectContaining({ command: { kind: 'answer_question', target,
    questionId: question.id, answer: { text: 'chosen option' }, source: 'slack' } }));
  await port.close();
});
it('delivers a result emitted before admission returns exactly once and detaches even on delivery failure', async () => {
  const { port, input, client } = fixture();
  let delivery!: ConversationDelivery;
  vi.mocked(input.open).mockImplementation(async (_open, value) => { delivery = value; return { attachmentId: 'attachment', read: read() }; });
  const delivered: Promise<unknown>[] = [];
  vi.mocked(input.submit).mockImplementation(async () => {
    delivered.push(delivery.deliver(conversationId({ kind: 'repository', repositoryDirectory: '/canonical' }), { kind: 'result', operationId: 'operation', result: { kind: 'reply', message: 'reply' } },
      { revision: 1, stateSequence: 1, operationId: 'operation' }));
    return { kind: 'accepted', operationId: 'operation' };
  });
  vi.mocked(client.postThreadMessage).mockResolvedValue({ kind: 'unavailable', reason: 'failed' });
  await port.receive(endpoint, 'hello');
  await Promise.all(delivered);
  await port.delivery.deliver(conversationId({ kind: 'repository', repositoryDirectory: '/canonical' }), { kind: 'result', operationId: 'operation', result: { kind: 'reply', message: 'duplicate' } },
    { revision: 1, stateSequence: 1, operationId: 'operation' });
  expect(client.postThreadMessage).toHaveBeenLastCalledWith(endpoint, 'reply');
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
});
it.each(['open', 'submit'] as const)('reports queue capacity rejection from %s without resubmitting the message', async (stage) => {
  const { port, input, client } = fixture();
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  if (stage === 'open') vi.mocked(input.open).mockRejectedValue(new ConversationError('queue_full'));
  else vi.mocked(input.submit).mockResolvedValue({ kind: 'error', code: 'queue_full', message: 'manager.conversation.queue_full' });
  await port.receive(endpoint, 'rejected');
  await port.close();
  expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(endpoint, 'manager.conversation.queue_full');
  expect(input.submit).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1);
});
it('stops receiving and releases accepted attachments on close without posting notices', async () => {
  const { port, input, client } = fixture();
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, 'hello');
  port.stopAccepting();
  await port.receive(endpoint, 'ignored');
  await port.delivery.deliver(conversationId({ kind: 'repository', repositoryDirectory: '/canonical' }), { kind: 'notice', id: 'notice', message: 'completed' }, { revision: 0, stateSequence: 0, operationId: null });
  await port.close();
  expect(input.submit).toHaveBeenCalledOnce();
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  expect(client.postThreadMessage).toHaveBeenCalledOnce();
});
it('turns an inquiry reply into an answer command without creating a conversation message', async () => {
  const { port, input } = fixture();
  const question = createInquiry({ body: 'Width?' });
  const target = { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/canonical' };
  inquiries.find.mockReturnValue({ channelId: endpoint.channelId, parentTs: endpoint.parentTs, questionId: question.id, target });
  vi.mocked(input.open).mockImplementation(async () => ({ attachmentId: 'read-attachment', read: read([{ kind: 'inquiry', inquiry: { target, question, objective: 'Goal' } }]) }));
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read([{ kind: 'inquiry', inquiry: { target, question, objective: 'Goal' } }]) });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, '80');
  expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: {
    kind: 'answer_question', target, questionId: question.id, answer: { text: '80' }, source: 'slack',
  } }));
  await port.close();
});

it.each([true, false])('identifies a saved inquiry thread without loading its current question, bound=%s', async (bound) => {
  const { port, input, client } = fixture();
  inquiries.find.mockReturnValue(bound ? { channelId: endpoint.channelId, parentTs: endpoint.parentTs,
    questionId: '550e8400-e29b-41d4-a716-446655440000', target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: '/canonical' } } } : undefined);
  expect(await port.isInquiryThread(endpoint.channelId, endpoint.parentTs)).toBe(bound);
  expect(inquiries.find).toHaveBeenCalledExactlyOnceWith(endpoint.channelId, endpoint.parentTs);
  expect(input.open).not.toHaveBeenCalled();
  expect(inquiries.save).not.toHaveBeenCalled();
  expect(client.postMessage).not.toHaveBeenCalled();
});

it('rejects an unreadable inquiry binding without misrouting its answer as conversation', async () => {
  const { port, input } = fixture();
  inquiries.find.mockImplementation(() => { throw new Error('Unreadable binding'); });
  await expect(port.isInquiryThread(endpoint.channelId, endpoint.parentTs)).rejects.toThrow();
  await expect(port.receive(endpoint, '80')).rejects.toThrow();
  expect(input.submit).not.toHaveBeenCalled();
  await port.close();
});
