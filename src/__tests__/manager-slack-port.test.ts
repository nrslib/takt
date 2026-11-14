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
import { getLabel } from '../shared/i18n/index.js';

const inquiries = vi.hoisted(() => ({ find: vi.fn(), question: vi.fn(), save: vi.fn() }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: vi.fn((key: string) => key) }));
vi.mock('../infra/slack/inquiryBindings.js', async (original) => ({ ...await original<typeof import('../infra/slack/inquiryBindings.js')>(),
  SlackInquiryBindings: class { find = inquiries.find; question = inquiries.question; save = inquiries.save; } }));
beforeEach(() => {
  for (const mock of Object.values(inquiries)) mock.mockReset();
  vi.mocked(getLabel).mockImplementation((key: string) => key);
});
const endpoint = { teamId: 'T1', channelId: 'C0123', userId: 'U0AAA', parentTs: '1700000000.000001' };
function fixture(language: 'ja' | 'en' = 'ja') {
  const input: ConversationInput = { open: vi.fn(), submit: vi.fn(), snapshot: vi.fn(), detach: vi.fn() };
  const client: SlackClient = { start: vi.fn(), postMessage: vi.fn().mockResolvedValue({ kind: 'delivered', parentTs: endpoint.parentTs }),
    postThreadMessage: vi.fn().mockResolvedValue({ kind: 'delivered' }), stopAccepting: vi.fn(), close: vi.fn() };
  const resolveAssignment = vi.fn<() => Promise<ManagerAssignment>>(async () => ({ kind: 'repository', repositoryDirectory: '/canonical', repositoryDirectories: ['/canonical'] }));
  const port = createSlackConversationPort({ repositoryDirectory: '/canonical', configDirectory: '/config', resolveAssignment, channelId: 'C0123', input, client, language });
  return { input, client, port, resolveAssignment };
}
function read(items: SnapshotItem[] = []): SnapshotRead {
  return { transferId: 'read', conversationId: 'conversation', revision: 0, stateSequence: 0, operationId: null,
    mode: 'initial', items: (async function* () { yield* items; })(), complete: vi.fn(), cancel: vi.fn() };
}
it.each(['reply', 'notice', 'error'] as const)('posts the original %s in a MarkdownBlock and fallback text without changing conversation output', async (kind) => {
  const { port, input, client } = fixture();
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, '確認してください');
  vi.mocked(client.postThreadMessage).mockClear();
  const record = conversationRecord('/canonical');
  const message = '## 結果\n**競合の中身**: [PR](https://example.test/pr)\n`**保存する文字**`\n**/*.ts\n\n**/*.js\n説明 ```md\n**x**\n```\n<https://example.test|手順 > 詳細>';
  const result = kind === 'error' ? { kind, code: 'operation_failed', message } : { kind, message };
  const output = { kind: 'result' as const, operationId: 'operation', result };
  const before = structuredClone(output);
  try {
    expect(await port.delivery.deliver(record.id, output, { revision: record.revision, stateSequence: 1, operationId: 'operation' }))
      .toEqual({ kind: 'delivered' });
    expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(endpoint, message, [{ type: 'markdown', text: message }]);
    expect(output).toEqual(before);
  } finally { await port.close(); }
});

it.each([
  { length: 11_999, markdown: true },
  { length: 12_000, markdown: true },
  { length: 12_001, markdown: false },
  { length: 24_001, markdown: false },
  { length: 40_001, markdown: false },
])('posts a $length-character reply exactly once (markdown=$markdown)', async ({ length, markdown }) => {
  const { port, input, client } = fixture();
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, '長い返事をください');
  const post = vi.mocked(client.postThreadMessage);
  post.mockClear();
  const record = conversationRecord('/canonical');
  const opening = '```ts\n';
  const closing = '\n```';
  const message = opening + 'あ'.repeat(length - opening.length - closing.length) + closing;
  const output = { kind: 'result' as const, operationId: 'operation', result: { kind: 'reply' as const, message } };
  const before = structuredClone(output);
  try {
    expect(await port.delivery.deliver(record.id, output, { revision: record.revision, stateSequence: 1, operationId: 'operation' }))
      .toEqual({ kind: 'delivered' });
    const blocks = markdown ? [{ type: 'markdown', text: message }] : undefined;
    expect(post).toHaveBeenCalledExactlyOnceWith(endpoint, message, blocks);
    expect(output).toEqual(before);
  } finally { await port.close(); }
});

it.each(['ja', 'en'] as const)('posts labeled repository and optional branches with registration buttons in %s', async (lang) => {
  const labels = await vi.importActual<typeof import('../shared/i18n/index.js')>('../shared/i18n/index.js');
  vi.mocked(getLabel).mockImplementation(labels.getLabel);
  const { port, input, client } = fixture(lang);
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, '/make-goal');
  const record = conversationRecord('/canonical');
  const specifications = { gherkin: 'Feature: CSV\n  Scenario: Export', quint: 'module csv {}\n```\nRemaining specification', alloy: 'sig CSV {}\n`````\nRemaining specification' };
  const pending = { ...record.pending!, repositoryDirectory: '/workspace/selected-repository',
    summary: { ...record.pending!.summary, specifications } };
  try {
    for (const branches of [{}, { startBranch: 'release' }, { integrationBranch: 'main' }, { startBranch: 'release', integrationBranch: 'main' }]) {
      const firstMessage = vi.mocked(client.postThreadMessage).mock.calls.length;
      await port.delivery.deliver(record.id, { kind: 'pending', state: { conversationId: record.id, assignment: record.assignment,
        revision: record.revision, pending: { ...pending, summary: { ...pending.summary, ...branches } },
        approval: null, running: null, interrupted: false } },
      { revision: record.revision, stateSequence: 1, operationId: 'operation' });
      const messages = vi.mocked(client.postThreadMessage).mock.calls.slice(firstMessage);
      const text = messages.map(([, text]) => text).join('\n');
      const blocks = messages.flatMap(([, , blocks]) => blocks ?? []);
      expect(text).toContain(lang === 'ja' ? 'リポジトリ: /workspace/selected-repository' : 'Repository: /workspace/selected-repository');
      expect(text).toContain(`${getLabel('manager.summary.objective', lang)}:\n${pending.summary.objective}`);
      for (const field of ['startBranch', 'integrationBranch'] as const) {
        const label = getLabel(`manager.summary.${field}`, lang);
        if (branches[field] === undefined) expect(text).not.toContain(label);
        else expect(text).toContain(`${label}: ${branches[field]}`);
      }
      for (const [notation, code] of Object.entries(specifications)) {
        const fence = '`'.repeat(notation === 'gherkin' ? 3 : notation === 'quint' ? 4 : 6);
        expect(text).toContain(`${fence}${notation}\n${code}\n${fence}`);
      }
      expect(text).not.toContain(getLabel('manager.summary.dismissHint', lang));
      expect(blocks).toContainEqual(expect.objectContaining({ type: 'actions', elements: [
        expect.objectContaining({ action_id: SLACK_GOAL_APPROVE, text: { type: 'plain_text', text: lang === 'ja' ? '登録する' : 'Register goal' } }),
        expect.objectContaining({ text: { type: 'plain_text', text: lang === 'ja' ? '登録せずに会話に戻る' : 'Return to conversation without registering' } }),
      ] }));
    }
  } finally { await port.close(); }
});
it.each(['ja', 'en'] as const)('posts explicit empty list items and preserves populated lists in %s', async (lang) => {
  const labels = await vi.importActual<typeof import('../shared/i18n/index.js')>('../shared/i18n/index.js');
  vi.mocked(getLabel).mockImplementation(labels.getLabel);
  const { port, input, client } = fixture(lang);
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, '/make-goal');
  const record = conversationRecord('/canonical');
  const fields = ['outOfScope', 'acceptanceCriteria', 'constraints'] as const;
  try {
    for (const empty of [[], ['outOfScope'], ['acceptanceCriteria'], ['constraints'], [...fields]]) {
      const summary = { ...record.pending!.summary,
        outOfScope: empty.includes('outOfScope') ? [] : ['Notifications', 'Email'],
        acceptanceCriteria: empty.includes('acceptanceCriteria') ? [] : ['Export CSV'],
        constraints: empty.includes('constraints') ? [] : ['Use mocks'],
      };
      await port.delivery.deliver(record.id, { kind: 'pending', state: { conversationId: record.id, assignment: record.assignment,
        revision: record.revision, pending: { ...record.pending!, summary }, approval: null, running: null, interrupted: false } },
      { revision: record.revision, stateSequence: 1, operationId: 'operation' });
      const [, text, blocks] = vi.mocked(client.postThreadMessage).mock.calls.at(-1)!;
      for (const field of fields) {
        const items = summary[field].length === 0 ? [lang === 'ja' ? 'なし' : 'None'] : summary[field];
        const section = `${getLabel(`manager.summary.${field}`, lang)}:\n${items.map((item) => `- ${item}`).join('\n')}`;
        expect(text).toContain(section);
        expect(blocks).toContainEqual({ type: 'section', text: { type: 'plain_text', text: section } });
      }
    }
  } finally { await port.close(); }
});
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
  resolveAssignment.mockResolvedValue({ kind: 'repository', repositoryDirectory: '/canonical', repositoryDirectories: ['/canonical'] });
  await port.receive(endpoint, 'chosen option');
  expect(input.open).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: id, assignment: target.owner }), expect.any(Object));
  expect(input.submit).toHaveBeenLastCalledWith(expect.objectContaining({ command: { kind: 'answer_question', target,
    questionId: question.id, answer: { text: 'chosen option' }, source: 'slack' } }));
  await port.close();
});
it.each(['reply', 'notice'] as const)('delivers a %s result emitted before admission returns exactly once and detaches even on delivery failure', async (kind) => {
  const { port, input, client } = fixture();
  let delivery!: ConversationDelivery;
  vi.mocked(input.open).mockImplementation(async (_open, value) => { delivery = value; return { attachmentId: 'attachment', read: read() }; });
  const delivered: Promise<unknown>[] = [];
  vi.mocked(input.submit).mockImplementation(async () => {
    delivered.push(delivery.deliver(conversationId({ kind: 'repository', repositoryDirectory: '/canonical' }), { kind: 'result', operationId: 'operation', result: { kind, message: 'reply' } },
      { revision: 1, stateSequence: 1, operationId: 'operation' }));
    return { kind: 'accepted', operationId: 'operation' };
  });
  vi.mocked(client.postThreadMessage).mockResolvedValue({ kind: 'unavailable', reason: 'failed' });
  await port.receive(endpoint, 'hello');
  await Promise.all(delivered);
  await port.delivery.deliver(conversationId({ kind: 'repository', repositoryDirectory: '/canonical' }), { kind: 'result', operationId: 'operation', result: { kind: 'reply', message: 'duplicate' } },
    { revision: 1, stateSequence: 1, operationId: 'operation' });
  expect(client.postThreadMessage).toHaveBeenLastCalledWith(endpoint, 'reply', [{ type: 'markdown', text: 'reply' }]);
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
});
it.each(['failed', 'error'] as const)('posts the retained %s verification as the interrupted final result to the same thread', async (verdict) => {
  const { port, input, client } = fixture();
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, '/verify');
  vi.mocked(client.postThreadMessage).mockClear();
  const id = conversationId({ kind: 'repository', repositoryDirectory: '/canonical' });
  const message = JSON.stringify({ verdict, runDirectory: '/canonical/.takt/runs/verify-test' });
  const output = { kind: 'result' as const, operationId: 'operation', result: { kind: 'error' as const, code: 'interrupted', message } };
  const version = { revision: 0, stateSequence: 1, operationId: 'operation' };
  await port.delivery.deliver('other-conversation', output, version);
  await port.delivery.deliver(id, output, { ...version, operationId: 'other-operation' });
  await port.delivery.deliver(id, { ...output, operationId: 'other-operation' }, { ...version, operationId: 'other-operation' });
  expect(client.postThreadMessage).not.toHaveBeenCalled();
  await port.delivery.deliver(id, output, version);
  expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(endpoint, message, [{ type: 'markdown', text: message }]);
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  await port.delivery.deliver(id, output, version);
  expect(client.postThreadMessage).toHaveBeenCalledOnce();
  await port.close();
});
it('delivers the interrupted verification result once to its originating Slack thread when several turns are attached', async () => {
  const { port, input, client } = fixture();
  const deliveries: ConversationDelivery[] = [];
  vi.mocked(input.open).mockImplementation(async (_open, delivery) => {
    deliveries.push(delivery);
    return { attachmentId: `attachment-${deliveries.length}`, read: read() };
  });
  vi.mocked(input.submit).mockResolvedValueOnce({ kind: 'accepted', operationId: 'first' });
  vi.mocked(input.submit).mockResolvedValueOnce({ kind: 'accepted', operationId: 'second' });
  await port.receive(endpoint, '/verify');
  await port.receive({ ...endpoint, parentTs: 'another-thread' }, '/verify');
  vi.mocked(client.postThreadMessage).mockClear();
  const id = conversationId({ kind: 'repository', repositoryDirectory: '/canonical' });
  await Promise.all(deliveries.map((delivery) => delivery.deliver(id,
    { kind: 'result', operationId: 'first', result: { kind: 'error', code: 'interrupted', message: 'retained verification result' } },
    { revision: 0, stateSequence: 1, operationId: 'first' })));
  expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(endpoint, 'retained verification result', [{ type: 'markdown', text: 'retained verification result' }]);
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment-1');
  await port.close();
  expect(input.detach).toHaveBeenCalledTimes(2);
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
it.each(['resolve', 'open', 'submit'] as const)('posts a sanitized failure reason from %s without replaying the command', async (stage) => {
  const labels = await vi.importActual<typeof import('../shared/i18n/index.js')>('../shared/i18n/index.js');
  vi.mocked(getLabel).mockImplementation(labels.getLabel);
  const { port, input, client, resolveAssignment } = fixture();
  const error = new Error(`provider.transport: ECONNRESET\nsocket closed; api_\u001b[31mtoken\u001b[0m=slack-test-secret\u0007 ${'x'.repeat(2_000)}`);
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  if (stage === 'resolve') resolveAssignment.mockRejectedValue(error);
  else if (stage === 'open') vi.mocked(input.open).mockRejectedValue(error);
  else vi.mocked(input.submit).mockRejectedValue(error);

  try {
    await port.receive(endpoint, '確認してください');

    expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(endpoint, expect.any(String));
    const [, message] = vi.mocked(client.postThreadMessage).mock.calls[0]!;
    expect(message).toContain('provider.transport: ECONNRESET socket closed');
    expect(message).toContain('api_token=[REDACTED]');
    expect(message).not.toContain('slack-test-secret');
    expect(message).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
    expect(message.length).toBeLessThan(600);
    expect(resolveAssignment).toHaveBeenCalledOnce();
    expect(input.open).toHaveBeenCalledTimes(stage === 'resolve' ? 0 : 1);
    expect(input.submit).toHaveBeenCalledTimes(stage === 'submit' ? 1 : 0);
    if (stage === 'submit') expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
    else expect(input.detach).not.toHaveBeenCalled();
  } finally { await port.close(); }
});
it.each(['ja', 'en'] as const)('keeps a classified operation failure label unchanged in %s', async (language) => {
  const labels = await vi.importActual<typeof import('../shared/i18n/index.js')>('../shared/i18n/index.js');
  vi.mocked(getLabel).mockImplementation(labels.getLabel);
  const { port, input, client } = fixture(language);
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockRejectedValue(new ConversationError('operation_failed'));

  try {
    await port.receive(endpoint, '確認してください');

    expect(client.postThreadMessage).toHaveBeenCalledExactlyOnceWith(endpoint, labels.getLabel('manager.conversation.operation_failed', language));
    expect(input.submit).toHaveBeenCalledOnce();
    expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  } finally { await port.close(); }
});
it.each(['resolve', 'open', 'submit', 'rejected', 'result'] as const)('escapes failure mentions at the Slack %s boundary while preserving links', async (stage) => {
  const labels = await vi.importActual<typeof import('../shared/i18n/index.js')>('../shared/i18n/index.js');
  vi.mocked(getLabel).mockImplementation(labels.getLabel);
  const { port, input, client, resolveAssignment } = fixture('en');
  const reason = 'failed <@U012AB3CD> <!channel> <!here> <!everyone> <!subteam^S0123|team> <https://example.test/path?q=1&x=2|details>';
  const error = new Error(reason);
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  if (stage === 'resolve') resolveAssignment.mockRejectedValue(error);
  else if (stage === 'open') vi.mocked(input.open).mockRejectedValue(error);
  else if (stage === 'submit') vi.mocked(input.submit).mockRejectedValue(error);
  else if (stage === 'rejected') vi.mocked(input.submit).mockResolvedValue({ kind: 'error', code: 'operation_failed', message: reason });
  else vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });

  try {
    await port.receive(endpoint, 'check');
    if (stage === 'result') {
      vi.mocked(client.postThreadMessage).mockClear();
      await port.delivery.deliver(conversationId({ kind: 'repository', repositoryDirectory: '/canonical' }), {
        kind: 'result', operationId: 'operation', result: { kind: 'error', code: 'operation_failed', message: reason },
      }, { revision: 0, stateSequence: 1, operationId: 'operation' });
    }

    expect(client.postThreadMessage).toHaveBeenCalledOnce();
    const [, message, blocks] = vi.mocked(client.postThreadMessage).mock.calls[0]!;
    const sent = [message, ...(blocks ?? []).flatMap((block) => block.type === 'markdown' ? [block.text] : [])];
    for (const text of sent) {
      expect(text).not.toMatch(/<[@!]/u);
      expect(text).toContain('&lt;@U012AB3CD>');
      expect(text).toContain('&lt;!channel>');
      expect(text).toContain('<https://example.test/path?q=1&x=2|details>');
      expect(text.replace(/&lt;/gu, '<')).toContain(reason);
    }
    expect(input.submit).toHaveBeenCalledTimes(stage === 'resolve' || stage === 'open' ? 0 : 1);
  } finally { await port.close(); }
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
it.each(['80', '/make-goal'])('turns inquiry reply %s into an answer command without requesting a proposal', async (text) => {
  const { port, input } = fixture();
  const question = createInquiry({ body: 'Width?' });
  const target = { goalId: '550e8400-e29b-41d4-a716-446655440000', repositoryDirectory: '/canonical' };
  inquiries.find.mockReturnValue({ channelId: endpoint.channelId, parentTs: endpoint.parentTs, questionId: question.id, target });
  vi.mocked(input.open).mockImplementation(async () => ({ attachmentId: 'read-attachment', read: read([{ kind: 'inquiry', inquiry: { target, question, objective: 'Goal' } }]) }));
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read([{ kind: 'inquiry', inquiry: { target, question, objective: 'Goal' } }]) });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  await port.receive(endpoint, text);
  expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: {
    kind: 'answer_question', target, questionId: question.id, answer: { text }, source: 'slack',
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


it.each(['ja', 'en'] as const)('marks only explicit /make-goal messages as proposal requests in Slack (%s)', async (language) => {
  const { port, input } = fixture(language);
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  try {
    for (const text of ['hello', '/make-goal please', getLabel('manager.goSummaryRequest', language), '  /make-goal  ']) {
      await port.receive(endpoint, text);
    }
    expect(vi.mocked(input.submit).mock.calls.map(([request]) => request.command)).toEqual([
      { kind: 'message', text: 'hello' },
      { kind: 'message', text: '/make-goal please' },
      { kind: 'message', text: getLabel('manager.goSummaryRequest', language) },
      { kind: 'message', text: getLabel('manager.goSummaryRequest', language), display: false, requestProposal: true },
    ]);
  } finally { await port.close(); }
});

it('passes a human /verify message from Slack to the manager conversation', async () => {
  const { port, input } = fixture();
  vi.mocked(input.open).mockResolvedValue({ attachmentId: 'attachment', read: read() });
  vi.mocked(input.submit).mockResolvedValue({ kind: 'accepted', operationId: 'verify-operation' });
  try {
    await port.receive(endpoint, '/verify');
    expect(input.submit).toHaveBeenCalledWith(expect.objectContaining({ command: { kind: 'message', text: '/verify' } }));
  } finally { await port.close(); }
});
