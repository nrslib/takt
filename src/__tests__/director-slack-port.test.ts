import { beforeEach, expect, it, vi } from 'vitest';
import { createDirectorSlackConversationPort } from '../features/director/slackConversationPort.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationError } from '../features/manager/conversationErrors.js';
import type { ConversationDelivery, ConversationInput, SnapshotRead } from '../features/manager/conversationPort.js';
import type { SlackClient, SlackDeliveryResult } from '../infra/slack/client.js';
import { getLabel } from '../shared/i18n/index.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import type { SlackInquiryBinding } from '../infra/slack/inquiryBindings.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import { SLACK_INQUIRY_ACTION } from '../features/manager/slackInquiryBlocks.js';
import { SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS } from '../features/manager/slackConversationPort.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { KnownBlock } from '@slack/types';

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
function fixture(language: 'ja' | 'en' = 'en') {
  const read: SnapshotRead = { transferId: 'read', conversationId: id, revision: 0, stateSequence: 0, operationId: null,
    mode: 'initial', items: (async function* () {})(), complete: vi.fn(), cancel: vi.fn() };
  const input = { prepareImage: vi.fn<ConversationInput['prepareImage']>().mockRejectedValue(new Error('Images are not supported by director')), open: vi.fn<ConversationInput['open']>(), submit: vi.fn<ConversationInput['submit']>(),
    snapshot: vi.fn<ConversationInput['snapshot']>(), detach: vi.fn<ConversationInput['detach']>() };
  input.open.mockResolvedValue({ attachmentId: 'attachment', read });
  input.submit.mockResolvedValue({ kind: 'accepted', operationId: 'operation' });
  const client = { start: vi.fn<SlackClient['start']>(), postMessage: vi.fn<SlackClient['postMessage']>(),
    updateMessage: vi.fn<SlackClient['updateMessage']>(), postThreadMessage: vi.fn<SlackClient['postThreadMessage']>(),
    stopAccepting: vi.fn(), close: vi.fn<SlackClient['close']>() };
  const posts = new Map<string, { text: string; blocks: KnownBlock[] }>();
  const postResults: SlackDeliveryResult[] = [];
  const updateResults: SlackDeliveryResult[] = [];
  client.postMessage.mockImplementation(async (_channel, text, blocks) => {
    const result = postResults.shift();
    if (result?.kind === 'unavailable') return result;
    const parentTs = posts.size === 0 ? 'posted' : `posted-${posts.size + 1}`;
    posts.set(parentTs, { text, blocks });
    return { kind: 'delivered', parentTs };
  });
  client.updateMessage.mockImplementation(async (thread, text, blocks) => {
    const result = updateResults.shift() ?? { kind: 'delivered' as const };
    if (result.kind === 'delivered') posts.set(thread.parentTs, { text, blocks });
    return result;
  });
  client.postThreadMessage.mockResolvedValue({ kind: 'delivered' });
  const port = createDirectorSlackConversationPort({ configDirectory: '/config', channelId: 'C0DIR', input, client, language });
  return { port, input, client, read, posts, postResults, updateResults };
}
function result(operationId = 'operation') {
  return { kind: 'result' as const, operationId, result: { kind: 'reply' as const, message: 'Director reply' } };
}
const version = { revision: 1, stateSequence: 1, operationId: 'operation' };

function proposal(revision = 4) {
  const pending = { revision, managerId: conversationId({ kind: 'repository', repositoryDirectory: '/blog' }), repositoryDirectory: '/blog',
    summary: { objective: revision === 4 ? '記事一覧' : '検索付き記事一覧', outOfScope: ['記事編集'], acceptanceCriteria: ['公開記事を一覧できる'], constraints: [] } };
  return { kind: 'pending' as const, state: { conversationId: id, assignment: { kind: 'daemon' as const }, revision,
    pending, approval: null, running: null, interrupted: false } };
}
function proposalButtons(blocks: readonly KnownBlock[]) {
  return blocks.flatMap((block) => block.type === 'actions' ? block.elements.filter((element) => element.type === 'button') : []);
}

function registeredProposal(revision = 4) {
  const state = proposal(revision).state;
  return { kind: 'pending' as const, state: { ...state, revision: revision + 1, pending: null,
    approval: { state: 'registered' as const, revision, goalId: goalRecord().id,
      managerId: state.pending.managerId, repositoryDirectory: state.pending.repositoryDirectory } } };
}

function proposalWithObjective(revision: number, objective: string) {
  const current = proposal(revision);
  return { ...current, state: { ...current.state, pending: { ...current.state.pending,
    summary: { ...current.state.pending.summary, objective } } } };
}

it.each(['registered', 'dismissed'] as const)('terminates only the successful initial post as %s after a later post fails', async (outcome) => {
  const { port, client, posts, postResults } = fixture();
  try {
    postResults.push({ kind: 'delivered' }, { kind: 'unavailable', reason: 'post-offline' });
    expect(await port.delivery.deliver(id, proposalWithObjective(4, 'A'.repeat(30000)), version)).toMatchObject({ kind: 'unavailable' });
    expect(client.postMessage).toHaveBeenCalledTimes(2);
    expect([...posts.keys()]).toEqual(['posted']);
    const cleared = registeredProposal();
    await port.delivery.deliver(id, outcome === 'registered' ? cleared
      : { ...cleared, state: { ...cleared.state, approval: null } }, version);
    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.updateMessage.mock.calls[0]![0]).toEqual({ channelId: 'C0DIR', parentTs: 'posted' });
    expect(posts.get('posted')).toEqual({ text: outcome === 'registered'
      ? getLabel('director.slackGoalRegistered', 'en', { id: goalRecord().id }) : getLabel('manager.slackGoalDismiss', 'en'), blocks: [] });
  } finally { await port.close(); }
});

it.each(['delivered', 'unavailable'] as const)('keeps the revised registration target when an additional post is %s', async (kind) => {
  const { port, client, posts, postResults } = fixture();
  try {
    await port.delivery.deliver(id, proposal(), version);
    postResults.push(kind === 'delivered' ? { kind } : { kind, reason: 'post-offline' });
    expect(await port.delivery.deliver(id, proposalWithObjective(5, 'B'.repeat(30000)), version)).toMatchObject({ kind });
    expect(posts.size).toBe(kind === 'delivered' ? 2 : 1);
    const ids = [...posts.keys()];
    client.updateMessage.mockClear();
    await port.delivery.deliver(id, registeredProposal(5), version);
    expect(client.updateMessage.mock.calls.map(([thread]) => thread.parentTs)).toEqual(ids);
    for (const post of posts.values()) expect(post).toEqual({ text: getLabel('director.slackGoalRegistered', 'en', { id: goalRecord().id }), blocks: [] });
  } finally { await port.close(); }
});

it.each(['delivered', 'unavailable'] as const)('keeps the revised registration target when the first update is %s', async (kind) => {
  const { port, client, posts, updateResults } = fixture();
  try {
    await port.delivery.deliver(id, proposal(), version);
    const before = structuredClone(posts.get('posted'));
    updateResults.push(kind === 'delivered' ? { kind } : { kind, reason: 'revision-offline' });
    expect(await port.delivery.deliver(id, proposal(5), version)).toMatchObject({ kind });
    if (kind === 'unavailable') expect(posts.get('posted')).toEqual(before);
    else expect(posts.get('posted')!.text).toContain('検索付き記事一覧');
    await port.delivery.deliver(id, registeredProposal(5), version);
    expect(client.updateMessage).toHaveBeenCalledTimes(2);
    expect(posts.get('posted')).toEqual({ text: getLabel('director.slackGoalRegistered', 'en', { id: goalRecord().id }), blocks: [] });
  } finally { await port.close(); }
});

it.each([4, 6])('classifies a partially delivered revision six using approval revision %s', async (approvalRevision) => {
  const { port, client, posts, updateResults } = fixture();
  try {
    await port.delivery.deliver(id, proposalWithObjective(4, 'A'.repeat(30000)), version);
    updateResults.push({ kind: 'delivered' }, { kind: 'unavailable', reason: 'revision-offline' });
    expect(await port.delivery.deliver(id, proposalWithObjective(6, 'B'.repeat(30000)), version)).toMatchObject({ kind: 'unavailable' });
    const registered = registeredProposal(approvalRevision);
    await port.delivery.deliver(id, { ...registered, state: { ...registered.state, revision: 7 } }, version);
    expect(client.updateMessage).toHaveBeenCalledTimes(4);
    for (const post of posts.values()) expect(post).toEqual({ text: approvalRevision === 6
      ? getLabel('director.slackGoalRegistered', 'en', { id: goalRecord().id }) : getLabel('manager.slackGoalDismiss', 'en'), blocks: [] });
  } finally { await port.close(); }
});

it('dismisses both posts of a partially delivered revision without an approval', async () => {
  const { port, posts, updateResults } = fixture();
  try {
    await port.delivery.deliver(id, proposalWithObjective(4, 'A'.repeat(30000)), version);
    updateResults.push({ kind: 'delivered' }, { kind: 'unavailable', reason: 'revision-offline' });
    expect(await port.delivery.deliver(id, proposalWithObjective(5, 'B'.repeat(30000)), version)).toMatchObject({ kind: 'unavailable' });
    await port.delivery.deliver(id, { kind: 'pending', state: { ...proposal(5).state, revision: 6, pending: null } }, version);
    expect(posts.size).toBe(2);
    for (const post of posts.values()) expect(post).toEqual({ text: getLabel('manager.slackGoalDismiss', 'en'), blocks: [] });
  } finally { await port.close(); }
});

it('retains the registration target until all terminal updates succeed', async () => {
  const { port, client, posts, updateResults } = fixture();
  try {
    await port.delivery.deliver(id, proposalWithObjective(4, 'A'.repeat(30000)), version);
    updateResults.push({ kind: 'delivered' }, { kind: 'unavailable', reason: 'terminal-offline' });
    expect(await port.delivery.deliver(id, registeredProposal(), version)).toMatchObject({ kind: 'unavailable' });
    expect(proposalButtons(posts.get('posted-2')!.blocks)).toHaveLength(2);
    expect(await port.delivery.deliver(id, registeredProposal(), version)).toEqual({ kind: 'delivered' });
    expect(client.updateMessage).toHaveBeenCalledTimes(4);
    for (const post of posts.values()) expect(post).toEqual({ text: getLabel('director.slackGoalRegistered', 'en', { id: goalRecord().id }), blocks: [] });
    await port.delivery.deliver(id, registeredProposal(), version);
    expect(client.updateMessage).toHaveBeenCalledTimes(4);
  } finally { await port.close(); }
});

it.each(['delivered', 'unavailable'] as const)('resends the same proposal only when its first delivery was %s', async (kind) => {
  const { port, client, posts, updateResults } = fixture();
  try {
    await port.delivery.deliver(id, proposalWithObjective(4, 'A'.repeat(30000)), version);
    const revised = proposalWithObjective(5, 'B'.repeat(30000));
    updateResults.push({ kind: 'delivered' }, kind === 'delivered' ? { kind } : { kind, reason: 'revision-offline' });
    expect(await port.delivery.deliver(id, revised, version)).toMatchObject({ kind });
    expect(client.updateMessage).toHaveBeenCalledTimes(2);
    expect(await port.delivery.deliver(id, revised, version)).toEqual({ kind: 'delivered' });
    expect(client.updateMessage).toHaveBeenCalledTimes(kind === 'delivered' ? 2 : 4);
    const count = client.updateMessage.mock.calls.length;
    await port.delivery.deliver(id, revised, version);
    expect(client.updateMessage).toHaveBeenCalledTimes(count);
    expect(posts.get('posted')!.text).toContain('B'.repeat(100));
    for (const button of proposalButtons(posts.get('posted-2')!.blocks)) expect(JSON.parse(button.value!)).toEqual({ conversationId: id, revision: 5 });
  } finally { await port.close(); }
});

it.each(['ja', 'en'] as const)('keeps the registered goal visible when only its detailed update fails (%s)', async (language) => {
  const { port, client, posts, updateResults } = fixture(language);
  try {
    await port.delivery.deliver(id, proposal(), version);
    updateResults.push({ kind: 'delivered' }, { kind: 'unavailable', reason: 'detail-offline' });
    expect(await port.delivery.deliver(id, registeredProposal(), version)).toEqual({ kind: 'delivered' });
    expect(await port.delivery.deliver(id, { kind: 'result', operationId: 'operation',
      result: { kind: 'goal_registered', goal: goalRecord() } }, version)).toMatchObject({ kind: 'unavailable' });
    expect(client.updateMessage).toHaveBeenCalledTimes(2);
    const displayed = posts.get('posted')!;
    expect(displayed.text).toBe(getLabel('director.slackGoalRegistered', language, { id: goalRecord().id }));
    expect(displayed.text).toContain(goalRecord().id);
    expect(displayed.text).not.toContain(getLabel('manager.slackGoalDismiss', language));
    expect(proposalButtons(displayed.blocks)).toEqual([]);
  } finally { await port.close(); }
});

it('still delivers the detailed registration after its preceding update fails', async () => {
  const { port, client, posts, updateResults } = fixture();
  try {
    await port.delivery.deliver(id, proposal(), version);
    updateResults.push({ kind: 'unavailable', reason: 'receipt-offline' }, { kind: 'delivered' });
    expect(await port.delivery.deliver(id, registeredProposal(), version)).toMatchObject({ kind: 'unavailable' });
    expect(proposalButtons(posts.get('posted')!.blocks)).toHaveLength(2);
    expect(await port.delivery.deliver(id, { kind: 'result', operationId: 'operation',
      result: { kind: 'goal_registered', goal: goalRecord() } }, version)).toEqual({ kind: 'delivered' });
    expect(client.updateMessage).toHaveBeenCalledTimes(2);
    const displayed = posts.get('posted')!;
    for (const value of [goalRecord().id, goalRecord().objective, goalRecord().branch]) expect(displayed.text).toContain(value);
    expect(proposalButtons(displayed.blocks)).toEqual([]);
  } finally { await port.close(); }
});

it('preserves a completed post on later empty output and dismisses a newer proposal despite an older approval', async () => {
  const { port, client, posts } = fixture();
  try {
    await port.delivery.deliver(id, proposal(), version);
    const registered = registeredProposal();
    await port.delivery.deliver(id, registered, version);
    await port.delivery.deliver(id, { kind: 'result', operationId: 'operation',
      result: { kind: 'goal_registered', goal: goalRecord() } }, version);
    const completed = structuredClone(posts.get('posted'));
    const count = client.updateMessage.mock.calls.length;
    await port.delivery.deliver(id, registered, version);
    expect(posts.get('posted')).toEqual(completed);
    expect(client.updateMessage).toHaveBeenCalledTimes(count);

    const next = proposal(6);
    await port.delivery.deliver(id, { ...next, state: { ...next.state, approval: registered.state.approval } }, version);
    for (const button of proposalButtons(posts.get('posted')!.blocks)) expect(JSON.parse(button.value!).revision).toBe(6);
    await port.delivery.deliver(id, { ...registered, state: { ...registered.state, revision: 7 } }, version);
    expect(posts.get('posted')).toEqual({ text: getLabel('manager.slackGoalDismiss', 'en'), blocks: [] });
    expect(posts.get('posted')!.text).not.toContain(goalRecord().id);
  } finally { await port.close(); }
});

it.each(['reserved', 'registered'] as const)('displays the current proposal while an approval is %s', async (state) => {
  const { port, posts } = fixture();
  try {
    const current = proposal(6);
    const approval = { ...registeredProposal().state.approval, state, revision: state === 'reserved' ? 6 : 4 };
    await port.delivery.deliver(id, { ...current, state: { ...current.state, approval } }, version);
    const displayed = posts.get('posted')!;
    expect(displayed.text).toContain(current.state.pending.summary.objective);
    expect(proposalButtons(displayed.blocks)).toHaveLength(2);
    for (const button of proposalButtons(displayed.blocks)) expect(JSON.parse(button.value!)).toEqual({ conversationId: id, revision: 6 });
  } finally { await port.close(); }
});

it('posts a TUI-originated director proposal with both buttons without a Slack speech target', async () => {
  const { port, input, client } = fixture();
  try {
    expect(await port.delivery.deliver(id, proposal(), { revision: 4, stateSequence: 1, operationId: null })).toEqual({ kind: 'delivered' });
    expect(client.postMessage).toHaveBeenCalledOnce();
    const [channel, text, blocks] = client.postMessage.mock.calls[0]!;
    expect(channel).toBe('C0DIR');
    for (const part of ['記事一覧', '記事編集', '公開記事を一覧できる', '/blog', conversationId({ kind: 'repository', repositoryDirectory: '/blog' })]) {
      expect(text + JSON.stringify(blocks)).toContain(part);
    }
    const buttons = proposalButtons(blocks);
    expect(buttons.map((button) => button.action_id)).toEqual([SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS]);
    expect(buttons.map((button) => button.text.text)).toEqual([
      getLabel('manager.slackGoalApprove', 'en'), getLabel('manager.slackGoalDismiss', 'en'),
    ]);
    for (const button of buttons) expect(JSON.parse(button.value!)).toEqual({ conversationId: id, revision: 4 });
    expect(input.submit).not.toHaveBeenCalled();
  } finally { await port.close(); }
});

it.each([SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS])('submits a director %s button as an explicit command with its displayed revision', async (actionId) => {
  const { port, input } = fixture();
  try {
    await port.receiveAction(endpoint, actionId, JSON.stringify({ conversationId: id, revision: 4 }), 'button-request');
    expect(input.open).toHaveBeenCalledWith(expect.objectContaining({ conversationId: id, assignment: { kind: 'daemon' } }), expect.any(Object));
    expect(input.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: 'button-request', command:
      actionId === SLACK_GOAL_APPROVE ? { kind: 'approve_summary', revision: 4, requirePending: true } : { kind: 'dismiss_summary', revision: 4 } }));
  } finally { await port.close(); }
});

it('updates the already posted director proposal when its scope changes in the same Slack port', async () => {
  const { port, client } = fixture();
  try {
    await port.delivery.deliver(id, proposal(), { revision: 4, stateSequence: 1, operationId: null });
    expect(client.postMessage).toHaveBeenCalledOnce();
    await port.delivery.deliver(id, proposal(5), { revision: 5, stateSequence: 2, operationId: null });
    expect(client.updateMessage).toHaveBeenCalled();
    const [thread, text, blocks] = client.updateMessage.mock.calls.at(-1)!;
    expect(thread).toEqual({ channelId: 'C0DIR', parentTs: 'posted' });
    expect(text + JSON.stringify(blocks)).toContain('検索付き記事一覧');
    const buttons = proposalButtons(blocks);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(JSON.parse(button.value!)).toEqual({ conversationId: id, revision: 5 });
  } finally { await port.close(); }
});

it.each(['dismissed', 'registered'] as const)('removes the proposal buttons from the original Slack post after it is %s', async (terminal) => {
  const { port, client } = fixture();
  try {
    await port.delivery.deliver(id, proposal(), { revision: 4, stateSequence: 1, operationId: null });
    expect(client.postMessage).toHaveBeenCalledOnce();
    const cleared = { ...proposal().state, revision: 5, pending: null,
      approval: terminal === 'registered' ? registeredProposal().state.approval : null };
    await port.delivery.deliver(id, { kind: 'pending', state: cleared }, { revision: 5, stateSequence: 2, operationId: null });
    if (terminal === 'registered') await port.delivery.deliver(id, { kind: 'result', operationId: 'operation',
      result: { kind: 'goal_registered', goal: goalRecord() } }, { revision: 5, stateSequence: 3, operationId: 'operation' });
    expect(client.updateMessage).toHaveBeenCalled();
    const [thread, text, blocks] = client.updateMessage.mock.calls.at(-1)!;
    expect(thread).toEqual({ channelId: 'C0DIR', parentTs: 'posted' });
    expect(proposalButtons(blocks)).toEqual([]);
    if (terminal === 'registered') expect(text + JSON.stringify(blocks)).toContain(goalRecord().id);
    else expect(text).toBe(getLabel('manager.slackGoalDismiss', 'en'));
  } finally { await port.close(); }
});

it('reports a failed proposal post as unavailable without submitting an approval', async () => {
  const { port, client, input } = fixture();
  client.postMessage.mockResolvedValueOnce({ kind: 'unavailable', reason: 'offline' });
  try {
    expect(await port.delivery.deliver(id, proposal(), { revision: 4, stateSequence: 1, operationId: null })).toMatchObject({ kind: 'unavailable' });
    expect(input.submit).not.toHaveBeenCalled();
  } finally { await port.close(); }
});

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

it('releases only the matching registration attachment and leaves proposal updates to the shared delivery', async () => {
  const { port, input, client } = fixture();
  await port.delivery.deliver(id, proposal(), { revision: 4, stateSequence: 1, operationId: null });
  await port.receiveAction(endpoint, SLACK_GOAL_APPROVE, JSON.stringify({ conversationId: id, revision: 4 }));
  const delivery = input.open.mock.calls[0]![1];
  const registered = { kind: 'result' as const, operationId: 'operation',
    result: { kind: 'goal_registered' as const, goal: goalRecord() } };
  await delivery.deliver('other', registered, version);
  await delivery.deliver(id, registered, { ...version, operationId: 'other' });
  await delivery.deliver(id, { ...registered, operationId: 'other' }, { ...version, operationId: 'other' });
  expect(input.detach).not.toHaveBeenCalled();
  await delivery.deliver(id, registered, version);
  expect(input.detach).toHaveBeenCalledExactlyOnceWith('attachment');
  await port.delivery.deliver(id, registered, version);
  expect(client.updateMessage).toHaveBeenCalledExactlyOnceWith({ channelId: 'C0DIR', parentTs: 'posted' },
    getLabel('manager.goalRegistered', 'en', { name: goalRecord().objective, id: goalRecord().id, branch: goalRecord().branch }), []);
  expect(client.postThreadMessage).toHaveBeenCalledOnce();
  await port.close();
  expect(input.detach).toHaveBeenCalledOnce();
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
