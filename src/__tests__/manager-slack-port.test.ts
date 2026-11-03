import { beforeEach, expect, it, vi } from 'vitest';
import { createSlackConversationPort, SLACK_GOAL_APPROVE } from '../features/manager/slackConversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationError } from '../features/manager/conversationErrors.js';
import type { ConversationDelivery, ConversationInput, SnapshotRead } from '../features/manager/conversationPort.js';
import type { SlackClient } from '../infra/slack/client.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';

const assignment = vi.hoisted(() => vi.fn());
const inquiries = vi.hoisted(() => ({ find: vi.fn(), goal: vi.fn(), question: vi.fn(), save: vi.fn() }));
vi.mock('../features/manager/assignment.js', () => ({ resolveCurrentManagerAssignment: assignment }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: async () => '/canonical' }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string) => key }));
vi.mock('../infra/slack/inquiryBindings.js', async (original) => ({ ...await original<typeof import('../infra/slack/inquiryBindings.js')>(),
  SlackInquiryBindings: class { find = inquiries.find; question = inquiries.question; save = inquiries.save; } }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = inquiries.goal; } }));
beforeEach(() => {
  assignment.mockReset().mockResolvedValue({ kind: 'repository', repositoryDirectory: '/canonical', repositoryDirectories: ['/canonical'] });
  for (const mock of Object.values(inquiries)) mock.mockReset();
});
const endpoint = { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' };
function fixture() {
  const input: ConversationInput = { open: vi.fn(), submit: vi.fn(), snapshot: vi.fn(), detach: vi.fn() };
  const client: SlackClient = { start: vi.fn(), postMessage: vi.fn().mockResolvedValue({ kind: 'delivered', parentTs: endpoint.parentTs }),
    openModal: vi.fn().mockResolvedValue({ kind: 'delivered' }),
    postThreadMessage: vi.fn().mockResolvedValue({ kind: 'delivered' }), stopAccepting: vi.fn(), close: vi.fn() };
  const port = createSlackConversationPort({ repositoryDirectory: '/repo', configDirectory: '/config', channelId: 'C0123', input, client, language: 'ja' });
  return { input, client, port };
}
function read(): SnapshotRead {
  return { transferId: 'read', conversationId: 'conversation', revision: 0, stateSequence: 0, operationId: null,
    mode: 'initial', items: (async function* () {})(), complete: vi.fn(), cancel: vi.fn() };
}
it.each(['invalid', '{}', '{"conversationId":"other","revision":4}', '{"conversationId":"other","revision":-1}'])('ignores an invalid or mismatched goal button value %s', async (value) => {
  const { port, input } = fixture();
  await port.receiveAction(endpoint, SLACK_GOAL_APPROVE, value, undefined);
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
  expect(client.postThreadMessage).toHaveBeenCalledOnce();
  port.close();
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
  expect(client.postThreadMessage).toHaveBeenCalledOnce();
  port.close();
});
it('resolves the current shared assignment and preserves Slack binding and speaker namespaces', async () => {
  const { port } = fixture();
  assignment.mockResolvedValue({ kind: 'workspace', workspaceId: '11111111-1111-4111-8111-111111111111' });
  const resolved = await port.resolve(endpoint);
  expect(resolved.conversationId).toBe(conversationId({ kind: 'workspace', workspaceId: '11111111-1111-4111-8111-111111111111' }));
  expect(resolved.binding).toEqual({ port: 'slack', key: '["T1","C0123","1700000000.000001"]',
    counterpart: { namespace: 'slack-thread', id: '["T1","C0123","1700000000.000001"]' } });
  expect(resolved.speaker).toEqual({ namespace: 'slack-user', id: '["T1","U0AAA"]' });
});
it('delivers a result emitted before admission returns exactly once and detaches even on delivery failure', async () => {
  const { port, input, client } = fixture();
  let delivery!: ConversationDelivery;
  vi.mocked(input.open).mockImplementation(async (_open, value) => { delivery = value; return { attachmentId: 'attachment', read: read() }; });
  const delivered: Promise<unknown>[] = [];
  vi.mocked(input.submit).mockImplementation(async () => {
    delivered.push(delivery.deliver('conversation', { kind: 'result', operationId: 'operation', result: { kind: 'reply', message: 'reply' } },
      { revision: 1, stateSequence: 1, operationId: 'operation' }));
    return { kind: 'accepted', operationId: 'operation' };
  });
  vi.mocked(client.postThreadMessage).mockResolvedValue({ kind: 'unavailable', reason: 'failed' });
  await port.receive(endpoint, 'hello');
  await Promise.all(delivered);
  await port.delivery.deliver('conversation', { kind: 'result', operationId: 'operation', result: { kind: 'reply', message: 'duplicate' } },
    { revision: 1, stateSequence: 1, operationId: 'operation' });
  expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(endpoint, 'reply');
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
});
it.each(['open', 'submit'] as const)('reports busy from %s without resubmitting the message', async (stage) => {
  const { port, input, client } = fixture();
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  if (stage === 'open') vi.mocked(input.open).mockRejectedValue(new ConversationError('busy'));
  else vi.mocked(input.submit).mockResolvedValue({ kind: 'busy', operationId: 'other' });
  await port.receive(endpoint, 'rejected');
  await port.close();
  expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(endpoint, 'manager.conversation.busy');
  expect(input.submit).toHaveBeenCalledTimes(stage === 'open' ? 0 : 1);
});
it('stops receiving and releases accepted attachments on close without posting notices', async () => {
  const { port, input, client } = fixture();
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, 'hello');
  port.stopAccepting();
  await port.receive(endpoint, 'ignored');
  await port.delivery.deliver('conversation', { kind: 'notice', id: 'notice', message: 'completed' }, { revision: 0, stateSequence: 0, operationId: null });
  port.close();
  expect(input.submit).toHaveBeenCalledOnce();
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  expect(client.postThreadMessage).not.toHaveBeenCalled();
});
it('turns an inquiry reply into an answer command without creating a conversation message', async () => {
  const { port, input } = fixture();
  const question = createInquiry({ body: 'Width?' });
  const target = { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/canonical' };
  inquiries.find.mockReturnValue({ channelId: endpoint.channelId, parentTs: endpoint.parentTs, questionId: question.id, target });
  inquiries.goal.mockResolvedValue({ objective: 'Goal', questions: [question] });
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, '80');
  expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: {
    kind: 'answer_question', target, questionId: question.id, answer: { text: '80' }, source: 'slack',
  } }));
  port.close();
});

it.each([true, false])('identifies a saved inquiry thread without loading its current question, bound=%s', (bound) => {
  const { port, input, client } = fixture();
  inquiries.find.mockReturnValue(bound ? { channelId: endpoint.channelId, parentTs: endpoint.parentTs,
    questionId: '550e8400-e29b-41d4-a716-446655440000', target: { goalId: null, owner: { kind: 'repository', repositoryDirectory: '/canonical' } } } : undefined);
  expect(port.isInquiryThread(endpoint.channelId, endpoint.parentTs)).toBe(bound);
  expect(inquiries.find).toHaveBeenCalledExactlyOnceWith(endpoint.channelId, endpoint.parentTs);
  expect(inquiries.goal).not.toHaveBeenCalled();
  expect(input.open).not.toHaveBeenCalled();
  expect(inquiries.save).not.toHaveBeenCalled();
  expect(client.postMessage).not.toHaveBeenCalled();
});

it('treats an unreadable inquiry binding as an ordinary thread in both classification and receive', async () => {
  const { port, input } = fixture();
  inquiries.find.mockImplementation(() => { throw new Error('Unreadable binding'); });
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  expect(port.isInquiryThread(endpoint.channelId, endpoint.parentTs)).toBe(false);
  await port.receive(endpoint, '80');
  expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: { kind: 'message', text: '80' } }));
  port.close();
});

it('opens a permission modal but submits only after the originating user confirms its sentence', async () => {
  const { port, input, client } = fixture();
  const question = createInquiry({ kind: 'approval', body: 'Allow?', operation: { toolName: 'Bash', args: 'npm test', cwd: '/canonical' } });
  const target = { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/canonical' };
  inquiries.find.mockReturnValue({ channelId: endpoint.channelId, parentTs: endpoint.parentTs, questionId: question.id, target });
  inquiries.goal.mockResolvedValue({ objective: 'Goal', questions: [question] });
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receiveAction(endpoint, 'takt_inquiry_answer_allow_project', 'allow_project', 'trigger');
  expect(input.submit).not.toHaveBeenCalled();
  const metadata = vi.mocked(client.openModal).mock.calls[0]![1].private_metadata!;
  expect(port.modalEndpoint(metadata)).toEqual(endpoint);
  await port.receiveModal({ ...endpoint, userId: 'U0BBB' }, metadata, 'Allow npm test.');
  expect(input.submit).not.toHaveBeenCalled();
  await port.receiveModal(endpoint, metadata, 'Allow npm test.');
  expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: {
    kind: 'answer_question', target, questionId: question.id, source: 'slack', answer: { decision: 'allow', scope: 'project' },
    permission: { scope: { kind: 'project', projectDirectory: '/canonical' }, sentence: 'Allow npm test.' },
  } }));
  expect(port.modalEndpoint(metadata)).toBeUndefined();
  port.close();
});
