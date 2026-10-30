import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConversationService } from '../features/manager/conversationService.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { createDaemonSlackPorts } from '../features/daemon/slackPorts.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import type { ManagerTurnInput } from '../features/manager/turnExecutor.js';
import type { validateManagerSummary } from '../features/manager/turnResponse.js';
import { createSlackClient, type SlackEvent } from '../infra/slack/client.js';
import { DebugLogger, initDebugLogger } from '../shared/utils/debug.js';
import type { ChatPostMessageArguments, ChatUpdateArguments, ViewsOpenArguments } from '@slack/web-api';
import type { ActionsBlock, Button, InputBlock, PlainTextInput } from '@slack/types';
import { GoalStore } from '../infra/goals/store.js';
import { readManagerEvents } from '../infra/goals/events.js';
import * as goalService from '../infra/goals/service.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import { createInquiry } from '../infra/goals/inquiry.js';
import type { GoalQuestionInput } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { readScopedPermissions } from '../features/manager/scopedPermissionStorage.js';
import { saveManagerToolPermissionInquiry } from '../features/manager/toolPermissionInquiry.js';
import { getLabel } from '../shared/i18n/index.js';
import * as managerAssignments from '../features/manager/assignment.js';
import { createSlackConversationPort } from '../features/manager/slackConversationPort.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { SlackInquiryBindings } from '../infra/slack/inquiryBindings.js';
import type { ConversationsHistoryArguments, ConversationsHistoryResponse } from '@slack/web-api';

const sdk = vi.hoisted(() => ({ on: vi.fn(), start: vi.fn(),
  history: vi.fn<(request: ConversationsHistoryArguments) => Promise<ConversationsHistoryResponse>>(),
  update: vi.fn<(request: ChatUpdateArguments) => Promise<{ ok: boolean }>>(),
  post: vi.fn<(post: ChatPostMessageArguments & { text?: string }) => Promise<{ ok: boolean; ts: string }>>(),
  open: vi.fn<(request: ViewsOpenArguments) => Promise<{ ok: boolean; view: { id: string } }>>(),
  disconnect: vi.fn(), socket: vi.fn() }));
vi.mock('@slack/socket-mode', () => ({ LogLevel: { ERROR: 'error' }, SocketModeClient: class {
  constructor(options: unknown) { sdk.socket(options); }
  on = sdk.on; start = sdk.start; disconnect = sdk.disconnect;
} }));
vi.mock('@slack/web-api', () => ({ WebClient: class { chat = { postMessage: sdk.post, update: sdk.update }; views = { open: sdk.open }; conversations = { history: sdk.history }; } }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: async (value: string) => value }));
vi.mock('../features/manager/assignment.js', () => ({
  resolveCurrentManagerAssignment: async (value: { kind: 'repository'; repositoryDirectory: string }) => ({ ...value, repositoryDirectories: [value.repositoryDirectory] }),
  resolveAssignedProjectRoot: async (value: string) => value,
}));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: () => ({ ctx: { providerType: 'mock' } }) }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn() }));

const execute = vi.fn<(input: ManagerTurnInput) => Promise<{ message: string; summary: ReturnType<typeof validateManagerSummary> | null; sessionId: string; assignment: ManagerTurnInput['assignment'] }>>(async (input) => ({ message: `reply:${input.instruction}`, summary: null, sessionId: 'session', assignment: input.assignment }));
let directory: string;
let repository: string;
let service: ReturnType<typeof createConversationService>;
let slack: Awaited<ReturnType<typeof createDaemonSlackPorts>>;
let tui: Awaited<ReturnType<typeof service.open>>;
let selected: Awaited<ReturnType<ReturnType<typeof createTuiConversationPort>['resolve']>>;
let release: (() => void) | undefined;

async function emit(overrides: Record<string, unknown> = {}) {
  const receive = sdk.on.mock.calls.find(([type]) => type === 'slack_event')![1] as (event: SlackEvent & { ack(): Promise<void> }) => Promise<void>;
  const ack = vi.fn(async () => {});
  const pending = receive({ type: 'events_api', body: { team_id: 'T1', event: {
    type: 'message', channel: 'C0123', user: 'U0AAA', text: '状況は？', ts: '1700000000.000001', ...overrides,
  } }, ack });
  return { ack, pending };
}
async function finished(posts: number) {
  await vi.waitFor(() => {
    expect(service.activeOperationCount).toBe(0);
    expect(sdk.post).toHaveBeenCalledTimes(posts);
    expect(service.attachmentCount).toBe(1);
  });
}
async function submitTui(text: string) {
  return service.submit({ attachmentId: tui.attachmentId, requestId: 'tui', speaker: selected.speaker, command: { kind: 'message', text } });
}

async function pollInquiries() {
  await slack.pollInquiries();
}

async function reopenSlack() {
  await slack.close();
  sdk.on.mockClear();
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
}

async function reopenSharedSlack(allowedUserIds: string[]) {
  await slack.close();
  sdk.on.mockClear();
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' },
    director: { slack: { channelId: 'C0123', allowedUserIds }, language: 'ja' } });
}

async function createGoalInquiry(input: GoalQuestionInput) {
  const question = createInquiry(input);
  await new GoalStore(repository).create({ ...goalRecord(), questions: [question] });
  return question;
}

async function savedInquiry() {
  return (await new GoalStore(repository).get(goalRecord().id)).questions![0]!;
}

async function postedInquiry() {
  await pollInquiries();
  const parents = sdk.post.mock.calls.filter(([post]) => post.thread_ts === undefined);
  expect(parents).toHaveLength(1);
  const post = parents[0]![0];
  if (!('text' in post) || !('blocks' in post) || !Array.isArray(post.blocks)) throw new Error('Inquiry text and blocks are required');
  expect(post.blocks.length).toBeGreaterThan(0);
  const index = sdk.post.mock.calls.findIndex(([value]) => value === post);
  const result = await sdk.post.mock.results[index]!.value as { ts: string };
  expect(sdk.update).not.toHaveBeenCalled();
  return { post, parentTs: result.ts };
}

function buttons(post: ChatPostMessageArguments): Button[] {
  if (!('blocks' in post) || !Array.isArray(post.blocks)) throw new Error('Inquiry must contain Slack blocks');
  return (post.blocks.filter((block) => block.type === 'actions') as ActionsBlock[])
    .flatMap((block) => block.elements.filter((element) => element.type === 'button') as Button[]);
}

function button(post: ChatPostMessageArguments, name: RegExp): Button {
  const matches = buttons(post).filter((element) => name.test(element.text.text));
  expect(matches, `button ${name}`).toHaveLength(1);
  return matches[0]!;
}

async function interactive(body: Record<string, unknown>) {
  const receive = sdk.on.mock.calls.find(([type]) => type === 'slack_event')![1] as (event: SlackEvent & { ack(): Promise<void> }) => Promise<void>;
  const ack = vi.fn(async () => {});
  await receive({ type: 'interactive', body: { team: { id: 'T1' }, user: { id: 'U0AAA' }, ...body }, ack });
  expect(ack).toHaveBeenCalledOnce();
}

async function pressButton(posted: Awaited<ReturnType<typeof postedInquiry>>, name: RegExp, overrides: Record<string, unknown> = {}) {
  const chosen = button(posted.post, name);
  await interactive({ type: 'block_actions', channel: { id: 'C0123' }, container: { type: 'message', channel_id: 'C0123', message_ts: posted.parentTs },
    message: { ts: posted.parentTs }, trigger_id: 'trigger-1',
    actions: [{ type: 'button', action_id: chosen.action_id, value: chosen.value }], ...overrides });
}

function openedModal() {
  expect(sdk.open).toHaveBeenCalledOnce();
  const request = sdk.open.mock.calls[0]![0] as ViewsOpenArguments;
  expect(request).toMatchObject({ trigger_id: 'trigger-1', view: { type: 'modal' } });
  if (request.view.type !== 'modal') throw new Error('Permission confirmation must use a modal');
  const inputs = request.view.blocks.filter((block) => block.type === 'input') as InputBlock[];
  expect(inputs).toHaveLength(1);
  const input = inputs[0]!;
  expect(input.element.type).toBe('plain_text_input');
  return { view: request.view, input, element: input.element as PlainTextInput };
}

async function submitModal(sentence: string, overrides: Record<string, unknown> = {}) {
  const { view, input, element } = openedModal();
  if (input.block_id === undefined || element.action_id === undefined) throw new Error('Modal input IDs are required');
  await interactive({ type: 'view_submission', view: { ...view, id: 'V1',
    state: { values: { [input.block_id]: { [element.action_id]: { type: 'plain_text_input', value: sentence } } } } }, ...overrides });
}

async function answersFinished() {
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
}

function approvalInput(): GoalQuestionInput {
  return { kind: 'approval', body: 'テスト実行を許可しますか',
    operation: { toolName: 'Bash', args: '{"command":"npm test"}', cwd: repository } };
}
beforeEach(async () => {
  vi.clearAllMocks();
  sdk.start.mockReset().mockResolvedValue({ ok: true });
  sdk.post.mockReset().mockImplementation(async () => ({ ok: true,
    ts: `1700000000.${String(sdk.post.mock.calls.length).padStart(6, '0')}` }));
  sdk.open.mockReset().mockResolvedValue({ ok: true, view: { id: 'V1' } });
  sdk.update.mockReset().mockImplementation(async ({ channel, ts }) => {
    expect(new SlackInquiryBindings(directory, repository).find(channel, ts)).toBeDefined();
    return { ok: true };
  });
  sdk.history.mockReset().mockRejectedValue(new Error('history unavailable'));
  sdk.disconnect.mockResolvedValue(undefined);
  execute.mockReset().mockImplementation(async (input) => ({ message: `reply:${input.instruction}`, summary: null, sessionId: 'session', assignment: input.assignment }));
  release = undefined;
  directory = process.env.TAKT_CONFIG_DIR!;
  repository = join(directory, 'repository');
  mkdirSync(join(repository, '.takt'), { recursive: true });
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'language: ja\nmanager:\n  slack:\n    channel_id: C0123\n    allowed_user_ids: [U0AAA]\n');
  DebugLogger.getInstance().reset();
  initDebugLogger({ enabled: true, logFile: join(directory, 'logs', 'daemon.log') });
  new ConversationStore(directory).write(conversationRecord(repository));
  service = createConversationService({ configDirectory: directory, owner: { pid: process.pid, identity: { startTime: 'slack-test' }, version: 'test', cliPath: '/test/cli.js' },
    onDomainChange() {}, runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'ja', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  const delivery = { deliver: async () => ({ kind: 'delivered' as const }) };
  selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'repository', repositoryDirectory: repository });
  tui = await service.open(selected, delivery);
  const iterator = tui.read.items[Symbol.asyncIterator]();
  await iterator.next(); await iterator.return?.();
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
});
afterEach(async () => { release?.(); slack?.stopAccepting(); await service?.close(); await slack?.close(); DebugLogger.getInstance().reset(); vi.restoreAllMocks(); });

it('keeps manager conversations and inquiry buttons working with director on the shared Slack connection', async () => {
  await slack.close();
  sdk.on.mockClear();
  sdk.start.mockClear();
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' },
    director: { slack: { channelId: 'C0DIR', allowedUserIds: ['U0DIR'] }, language: 'ja' } });
  await (await emit()).pending;
  await finished(1);
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: '状況は？' }));
  const question = await createGoalInquiry({ body: '形式を選んでください', options: ['A', 'B'] });
  const posted = await postedInquiry();
  await pressButton(posted, /^1\. A$/u);
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ id: question.id, status: 'answered', answer: { text: 'A', source: 'slack' } });
  await slack.notifications.deliver([{ id: 'director-notice', message: '人の判断が必要です' }]);
  const directorPosts = sdk.post.mock.calls.map(([post]) => post).filter((post) => post.channel === 'C0DIR');
  expect(directorPosts).toHaveLength(1);
  expect(directorPosts[0]).toMatchObject({ text: expect.stringContaining('人の判断が必要です') });
  expect(directorPosts[0]!.thread_ts).toBeUndefined();
  expect(sdk.start).toHaveBeenCalledOnce();
});

it('acknowledges shutdown-time messages without starting a turn before or after delayed startup completes', async () => {
  await slack.close();
  sdk.on.mockClear();
  const controller = new AbortController();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  sdk.start.mockImplementationOnce(() => gate);
  const options = { projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' }, signal: controller.signal };
  const initializing = createDaemonSlackPorts(options);
  try {
    await vi.waitFor(() => expect(sdk.start).toHaveBeenCalledTimes(2));
    service.stopAccepting();
    controller.abort();
    const { ack, pending } = await emit();
    await pending;
    expect(ack).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(sdk.post).not.toHaveBeenCalled();
    expect(await submitTui('after stop')).toMatchObject({ kind: 'error', code: 'shutting_down' });
  } finally {
    release!();
    slack = await initializing;
  }
  expect(slack.listening).toBe(false);
  const { ack, pending } = await emit();
  await pending;
  expect(ack).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  expect(sdk.post).not.toHaveBeenCalled();
  expect(service.activeOperationCount).toBe(0);
  expect(service.attachmentCount).toBe(1);
});

it('routes a channel post through the shared conversation and replies in its new thread', async () => {
  const { pending, ack } = await emit(); await pending; await finished(1);
  expect(ack).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toMatchObject({ instruction: '状況は？', assignment: selected.assignment });
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: 'C0123', thread_ts: '1700000000.000001', text: 'reply:状況は？' }));
});

async function makeGoalProposal() {
  const summary = { objective: '新しい目的', outOfScope: ['対象外'], acceptanceCriteria: ['受入条件'], constraints: ['作業制約'] };
  const start = sdk.post.mock.calls.length;
  execute.mockImplementationOnce(async (input) => ({ message: '案を作りました', summary: { ...summary, repositoryDirectory: repository }, sessionId: 'session', assignment: input.assignment }));
  await (await emit({ text: '  /make-goal  ', thread_ts: '1700000000.000001', ts: '1700000000.000010' })).pending;
  await vi.waitFor(() => {
    expect(service.activeOperationCount).toBe(0);
    expect(sdk.post.mock.calls.some(([post]) => 'blocks' in post && Array.isArray(post.blocks) && post.blocks.some((block) => block.type === 'actions'))).toBe(true);
  });
  const post = sdk.post.mock.calls.map(([value]) => value).find((value) => 'blocks' in value && Array.isArray(value.blocks) && value.blocks.some((block) => block.type === 'actions'))!;
  const index = sdk.post.mock.calls.findIndex(([value]) => value === post);
  const result = await sdk.post.mock.results[index]!.value;
  return { post, start, parentTs: result.ts, summary };
}

async function pressProposal(posted: Awaited<ReturnType<typeof makeGoalProposal>>, name: RegExp, overrides: Record<string, unknown> = {}) {
  const chosen = button(posted.post, name);
  await interactive({ type: 'block_actions', channel: { id: 'C0123' },
    container: { type: 'message', channel_id: 'C0123', message_ts: posted.parentTs },
    message: { ts: posted.parentTs, thread_ts: '1700000000.000001' },
    actions: [{ type: 'button', action_id: chosen.action_id, value: chosen.value }], ...overrides });
}

it('posts a Slack proposal in the source thread and registers it when approved', async () => {
  const git = (args: string[], input?: string) => execFileSync('git', args, {
    cwd: repository, input, encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Goal Test', GIT_AUTHOR_EMAIL: 'goal@example.test',
      GIT_COMMITTER_NAME: 'Goal Test', GIT_COMMITTER_EMAIL: 'goal@example.test' },
  }).trim();
  git(['init', '--initial-branch=main']);
  const tree = git(['hash-object', '-w', '-t', 'tree', '--stdin'], '');
  const initial = git(['commit-tree', tree, '-m', 'fixture']);
  git(['update-ref', 'refs/heads/main', initial]);
  await (await emit()).pending; await finished(1);
  const proposal = await makeGoalProposal();
  expect(execute.mock.calls[1]![0].instruction).toBe(getLabel('manager.goSummaryRequest', 'ja'));
  expect(proposal.post.thread_ts).toBe('1700000000.000001');
  for (const text of [proposal.summary.objective, ...proposal.summary.outOfScope, ...proposal.summary.acceptanceCriteria, ...proposal.summary.constraints]) {
    await vi.waitFor(() => expect(sdk.post.mock.calls.slice(proposal.start).some(([post]) => post.channel === 'C0123' && post.thread_ts === '1700000000.000001' && JSON.stringify(post).includes(text))).toBe(true));
  }
  expect(buttons(proposal.post)).toHaveLength(2);
  button(proposal.post, /登録を承認/u); button(proposal.post, /会話を続ける/u);
  const count = sdk.post.mock.calls.length;
  await pressProposal(proposal, /登録を承認/u);
  await vi.waitFor(async () => expect((await new GoalStore(repository).list()).goals, JSON.stringify(sdk.post.mock.calls.slice(count))).toHaveLength(1), { timeout: 15000 });
  const goals = (await new GoalStore(repository).list()).goals;
  expect(goals[0]).toMatchObject(proposal.summary);
  expect(git(['rev-parse', '--verify', `refs/heads/${goals[0]!.branch}^{commit}`])).toBe(initial);
  await vi.waitFor(() => expect(readManagerEvents(repository).filter(({ event }) => event.kind === 'registered' && event.goalId === goals[0]!.id)).toHaveLength(1));
  await vi.waitFor(() => expect(sdk.post.mock.calls.slice(count).some(([post]) => post.thread_ts === '1700000000.000001' && JSON.stringify(post).includes(proposal.summary.objective))).toBe(true));
}, 30000);

it('passes other slash-prefixed messages through as ordinary conversation', async () => {
  await (await emit({ text: '/make-goal extra' })).pending; await finished(1);
  expect(execute.mock.calls[0]![0].instruction).toBe('/make-goal extra');
});

it.each([false, true])('rejects a registered proposal button after conversation advances: %s', async (advance) => {
  vi.spyOn(goalService, 'registerReservedGoal').mockImplementation(async (input) => new GoalStore(input.cwd).create({
    ...goalRecord(), id: input.id, objective: input.objective, outOfScope: input.outOfScope,
    acceptanceCriteria: input.acceptanceCriteria, constraints: input.constraints,
  }));
  const proposal = await makeGoalProposal();
  await pressProposal(proposal, /登録を承認/u);
  await vi.waitFor(async () => {
    expect((await new GoalStore(repository).list()).goals).toHaveLength(1);
    expect(service.activeOperationCount).toBe(0);
    expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)!.approval?.state).toBe('registered');
    expect(sdk.post.mock.calls.some(([post]) => String(post.text).includes('ゴール登録完了'))).toBe(true);
  });
  if (advance) {
    expect((await submitTui('変更')).kind).toBe('accepted');
    await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  }
  const before = new ConversationStore(directory).read(selected.conversationId, selected.assignment)!;
  const goals = (await new GoalStore(repository).list()).goals;
  const count = sdk.post.mock.calls.length;
  await pressProposal(proposal, /登録を承認/u);
  await vi.waitFor(() => expect(sdk.post.mock.calls.length).toBeGreaterThan(count));
  const posts = sdk.post.mock.calls.slice(count).map(([post]) => post);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ thread_ts: '1700000000.000001', text: getLabel('manager.conversation.stale_summary', 'ja') });
  expect((await new GoalStore(repository).list()).goals).toEqual(goals);
  expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)).toEqual(before);
});

it('rejects a make-goal request while the conversation is busy without running it later', async () => {
  const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async (input) => { await gate; return { message: 'later', summary: null, sessionId: 'session', assignment: input.assignment }; });
  expect((await submitTui('local')).kind).toBe('accepted');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  await (await emit({ text: '/make-goal' })).pending;
  expect(sdk.post).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '1700000000.000001', text: getLabel('manager.conversation.busy', 'ja') }));
  release!(); await finished(1);
  expect(execute).toHaveBeenCalledOnce();
});

it('does not post a proposal produced by a TUI turn', async () => {
  execute.mockImplementationOnce(async (input) => ({ message: '案', summary: { ...conversationRecord(repository).pending!.summary, repositoryDirectory: repository }, sessionId: 'session', assignment: input.assignment }));
  expect((await submitTui('要約')).kind).toBe('accepted');
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  expect(sdk.post).not.toHaveBeenCalled();
});

it('dismisses a Slack proposal without registering a goal', async () => {
  const proposal = await makeGoalProposal();
  await pressProposal(proposal, /会話を続ける/u);
  await vi.waitFor(() => expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)!.pending).toBeNull());
  await vi.waitFor(() => expect(sdk.post.mock.calls.some(([post]) => post.thread_ts === '1700000000.000001' && String(post.text).includes(getLabel('manager.conversation.dismissed', 'ja')))).toBe(true));
  const before = new ConversationStore(directory).read(selected.conversationId, selected.assignment)!;
  const count = sdk.post.mock.calls.length;
  await pressProposal(proposal, /登録を承認/u);
  await vi.waitFor(() => expect(sdk.post.mock.calls.length).toBeGreaterThan(count));
  expect(sdk.post.mock.calls.slice(count)).toHaveLength(1);
  expect(sdk.post.mock.calls[count]![0]).toMatchObject({ thread_ts: '1700000000.000001', text: getLabel('manager.conversation.stale_summary', 'ja') });
  expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)).toEqual(before);
  expect((await new GoalStore(repository).list()).goals).toHaveLength(0);
});

it('rejects an old Slack approval after a TUI turn without changing the new revision', async () => {
  await slack.close();
  await service.close();
  const record = conversationRecord(repository);
  record.revision = 3;
  record.pending!.revision = 3;
  new ConversationStore(directory).write(record);
  service = createConversationService({ configDirectory: directory, owner: { pid: process.pid, identity: { startTime: 'slack-test' }, version: 'test', cliPath: '/test/cli.js' },
    onDomainChange() {}, runtime: { resolve: async () => ({ provider: 'mock', model: null, language: 'ja', contextKey: 'test', executor: { execute } }), close: async () => {} } });
  const delivery = { deliver: async () => ({ kind: 'delivered' as const }) };
  tui = await service.open(selected, delivery);
  const iterator = tui.read.items[Symbol.asyncIterator]();
  await iterator.next(); await iterator.return?.();
  sdk.on.mockClear();
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
  const proposal = await makeGoalProposal();
  expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)!.pending?.revision).toBe(4);
  expect((await submitTui('変更')).kind).toBe('accepted');
  await vi.waitFor(() => expect(service.activeOperationCount).toBe(0));
  const before = new ConversationStore(directory).read(selected.conversationId, selected.assignment)!;
  expect(before.revision).toBe(5);
  const count = sdk.post.mock.calls.length;
  await pressProposal(proposal, /登録を承認/u);
  await vi.waitFor(() => expect(sdk.post.mock.calls.length).toBeGreaterThan(count));
  expect(sdk.post.mock.calls.slice(count).some(([post]) => post.thread_ts === '1700000000.000001' && String(post.text).includes(getLabel('manager.conversation.stale_summary', 'ja')))).toBe(true);
  expect((await new GoalStore(repository).list()).goals).toHaveLength(0);
  expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)).toMatchObject({ revision: before.revision, pending: before.pending, approval: before.approval });
});

it('ignores a proposal approval by a user outside the allowlist', async () => {
  const proposal = await makeGoalProposal();
  const before = new ConversationStore(directory).read(selected.conversationId, selected.assignment)!;
  const count = sdk.post.mock.calls.length;
  await pressProposal(proposal, /登録を承認/u, { user: { id: 'U0BBB' } });
  expect((await new GoalStore(repository).list()).goals).toHaveLength(0);
  expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)).toEqual(before);
  expect(sdk.post).toHaveBeenCalledTimes(count);
});

it('ignores a proposal approval from another channel', async () => {
  const proposal = await makeGoalProposal();
  const before = new ConversationStore(directory).read(selected.conversationId, selected.assignment)!;
  const count = sdk.post.mock.calls.length;
  await pressProposal(proposal, /登録を承認/u, { channel: { id: 'C0999' },
    container: { type: 'message', channel_id: 'C0999', message_ts: proposal.parentTs } });
  expect((await new GoalStore(repository).list()).goals).toHaveLength(0);
  expect(new ConversationStore(directory).read(selected.conversationId, selected.assignment)).toEqual(before);
  expect(sdk.post).toHaveBeenCalledTimes(count);
});

it('acknowledges proposal approval while goal registration is blocked', async () => {
  const proposal = await makeGoalProposal();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const registration = vi.spyOn(goalService, 'registerReservedGoal').mockImplementation(async (input) => {
    await gate;
    return new GoalStore(input.cwd).create({ ...goalRecord(), id: input.id, objective: input.objective,
      outOfScope: input.outOfScope, acceptanceCriteria: input.acceptanceCriteria, constraints: input.constraints });
  });
  const chosen = button(proposal.post, /登録を承認/u);
  const receive = sdk.on.mock.calls.find(([type]) => type === 'slack_event')![1] as (event: SlackEvent & { ack(): Promise<void> }) => Promise<void>;
  const ack = vi.fn(async () => {});
  const startedAt = Date.now();
  const pending = receive({ type: 'interactive', body: { type: 'block_actions', team: { id: 'T1' }, user: { id: 'U0AAA' },
    channel: { id: 'C0123' }, container: { type: 'message', channel_id: 'C0123', message_ts: proposal.parentTs },
    message: { ts: proposal.parentTs, thread_ts: '1700000000.000001' },
    actions: [{ type: 'button', action_id: chosen.action_id, value: chosen.value }] }, ack });
  try {
    await vi.waitFor(() => expect(registration).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(ack).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect((await new GoalStore(repository).list()).goals).toHaveLength(0);
  } finally {
    release!();
    await pending;
  }
  await vi.waitFor(async () => expect((await new GoalStore(repository).list()).goals).toHaveLength(1));
});

it('routes a broadcast reply once to the TUI conversation and replies in the parent thread', async () => {
  const open = vi.spyOn(service, 'open');
  const { pending, ack } = await emit({ subtype: 'thread_broadcast', text: '返信本文',
    ts: '1700000000.000003', thread_ts: '1700000000.000001',
    root: { text: '親投稿', ts: '1700000000.000001' },
  });
  await pending;
  await finished(1);
  expect(ack).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationId: selected.conversationId }), expect.any(Object));
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].instruction).toBe('返信本文');
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    channel: 'C0123', thread_ts: '1700000000.000001', text: 'reply:返信本文',
  }));
});

it('shares the TUI record across parent posts, replies and adjacent timestamp threads', async () => {
  const open = vi.spyOn(service, 'open');
  await (await emit()).pending; await finished(1);
  await (await emit({ ts: '1700000000.000003', thread_ts: '1700000000.000001' })).pending; await finished(2);
  await (await emit({ ts: '1700000000.000004', thread_ts: '1700000000.000002' })).pending; await finished(3);
  expect(open.mock.calls.map(([value]) => value.conversationId)).toEqual(Array(3).fill(selected.conversationId));
  const record = new ConversationStore(directory).read(selected.conversationId, selected.assignment)!;
  expect(readdirSync(join(directory, 'conversations'))).toEqual([`${selected.conversationId}.json`]);
  expect(record.bindings.filter(({ port }) => port === 'slack')).toEqual(['1700000000.000001', '1700000000.000002'].map((ts) => {
    const key = JSON.stringify(['T1', 'C0123', ts]);
    return { port: 'slack', key, counterpart: { namespace: 'slack-thread', id: key } };
  }));
  expect(record.lastSpeaker).toEqual({ namespace: 'slack-user', id: '["T1","U0AAA"]' });
  expect(sdk.post.mock.calls.map(([value]) => value.thread_ts)).toEqual(['1700000000.000001', '1700000000.000001', '1700000000.000002']);
});

it('posts only Slack-originated replies to their source threads across a TUI turn', async () => {
  await (await emit({ text: 'first' })).pending; await finished(1);
  expect((await submitTui('local')).kind).toBe('accepted'); await finished(1);
  await (await emit({ text: 'second', thread_ts: '1700000000.000002', ts: '1700000000.000005' })).pending; await finished(2);
  expect(sdk.post.mock.calls.map(([value]) => ({ thread: value.thread_ts, text: value.text }))).toEqual([
    { thread: '1700000000.000001', text: 'reply:first' }, { thread: '1700000000.000002', text: 'reply:second' },
  ]);
});

it.each(['new binding', 'saved binding'])('rejects Slack input during a TUI turn with %s and never executes it later', async (binding) => {
  if (binding === 'saved binding') { await (await emit()).pending; await finished(1); }
  sdk.post.mockClear(); execute.mockClear();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async (input) => { await gate; return { message: 'local reply', summary: null, sessionId: 'session', assignment: input.assignment }; });
  await submitTui('local');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  await (await emit({ text: 'こちらも' })).pending;
  expect(sdk.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ thread_ts: '1700000000.000001', text: expect.stringContaining('処理中') }));
  release!(); await finished(1);
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0].instruction).toBe('local');
});

it('acknowledges the Socket Mode event while the provider is blocked and delivers after release', async () => {
  const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async (input) => { await gate; return { message: 'later', summary: null, sessionId: 'session', assignment: input.assignment }; });
  const startedAt = Date.now();
  const { pending, ack } = await emit();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce(), { timeout: 2000 });
  expect(ack).toHaveBeenCalledOnce(); expect(Date.now() - startedAt).toBeLessThan(3000);
  expect(service.activeOperationCount).toBe(1); expect(sdk.post).not.toHaveBeenCalled();
  release!(); await pending; await finished(1);
  expect(sdk.post).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '1700000000.000001', text: 'later' }));
});

it('posts one new inquiry outside both conversation threads and never posts the completion notice', async () => {
  await (await emit()).pending; await finished(1);
  await (await emit({ ts: '1700000000.000002' })).pending; await finished(2);
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledTimes(2);
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  await new GoalStore(repository).update(goalRecord().id, (goal) => ({ ...goal, notifications: [{
    id: '550e8400-e29b-41d4-a716-446655440001', kind: 'completed', body: '完成しました', recordedAt: new Date().toISOString(),
  }] }));
  await pollInquiries();
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledTimes(3);
  const post = sdk.post.mock.calls[2]![0] as ChatPostMessageArguments;
  expect(post.channel).toBe('C0123');
  expect(post.thread_ts).toBeUndefined();
  if (!('text' in post) || !('blocks' in post)) throw new Error('Inquiry text and blocks are required');
  expect(post.text).toContain(question.body);
  expect(post.blocks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'section' })]));
  expect(sdk.update).not.toHaveBeenCalled();
  expect((await savedInquiry()).status).toBe('pending');
});

it('skips inquiries present at startup and posts a later inquiry only once across overlapping polls', async () => {
  const existing = await createGoalInquiry({ body: '起動前の問い合わせ' });
  await reopenSlack();
  await pollInquiries();
  expect(sdk.post).not.toHaveBeenCalled();

  const later = createInquiry({ body: '起動後の問い合わせ' });
  await new GoalStore(repository).update(goalRecord().id, (goal) => ({ ...goal, questions: [existing, later] }));
  await Promise.all([pollInquiries(), pollInquiries()]);
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  expect(sdk.post.mock.calls[0]![0]).toMatchObject({ channel: 'C0123', text: expect.stringContaining(later.body) });
  expect(sdk.post.mock.calls[0]![0].thread_ts).toBeUndefined();
  expect(sdk.update).not.toHaveBeenCalled();
});

it('treats an inquiry saved while Slack is connecting as present at startup', async () => {
  await slack.close();
  sdk.on.mockClear();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  sdk.start.mockImplementationOnce(async () => { await gate; return { ok: true }; });
  const connecting = createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
  await vi.waitFor(() => expect(sdk.start).toHaveBeenCalledTimes(2));
  const existing = await createGoalInquiry({ body: '接続中の問い合わせ' });
  release!();
  slack = await connecting;
  await pollInquiries();
  expect(sdk.post).not.toHaveBeenCalled();
  const later = createInquiry({ body: '接続後の問い合わせ' });
  await new GoalStore(repository).update(goalRecord().id, (goal) => ({ ...goal, questions: [existing, later] }));
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  expect(sdk.post.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining(later.body) });
});

it('delivers an inquiry as a channel parent through the common delivery interface without opening a conversation', async () => {
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  const client = createSlackClient({ appToken: 'xapp-test-1', botToken: 'xoxb-test-2' });
  const options = { repositoryDirectory: repository, configDirectory: directory, channelId: 'C0123',
    input: service, client, language: 'ja' as const };
  const port = createSlackConversationPort(options);
  const open = vi.spyOn(service, 'open');
  try {
    const output = { kind: 'inquiry' as const, target: { goalId: goalRecord().id, repositoryDirectory: repository }, question };
    const version = { revision: 0, stateSequence: 0, operationId: null };
    expect(await port.delivery.deliver(selected.conversationId, output, version)).toEqual({ kind: 'delivered' });
    expect(sdk.post).toHaveBeenCalledOnce();
    expect(sdk.post.mock.calls[0]![0].channel).toBe('C0123');
    expect(sdk.post.mock.calls[0]![0].thread_ts).toBeUndefined();
    expect(sdk.post.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining(question.body), blocks: expect.any(Array) });
    expect(sdk.update).not.toHaveBeenCalled();
    await port.delivery.deliver(selected.conversationId, output, version);
    await port.delivery.deliver(selected.conversationId, { kind: 'notice', id: 'notice', message: '完成しました' }, version);
    expect(sdk.post).toHaveBeenCalledOnce();
    expect(sdk.update).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  } finally { port.close(); await client.close(); }
});

it.each(['once', 'goal', 'deny'] as const)('answers the %s approval button without a modal or permission append', async (choice) => {
  await createGoalInquiry(approvalInput());
  const before = await readScopedPermissions({ projectDirectory: repository });
  const posted = await postedInquiry();
  await pressButton(posted, choice === 'once' ? /今回だけ/u : choice === 'goal' ? /このゴール/u : /拒否/u);
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: choice === 'deny'
    ? { decision: 'deny', source: 'slack' } : { decision: 'allow', scope: choice, source: 'slack' } });
  expect((await savedInquiry()).answer?.scope).toBe(choice === 'deny' ? undefined : choice);
  expect(sdk.open).not.toHaveBeenCalled();
  expect(await readScopedPermissions({ projectDirectory: repository })).toEqual(before);
  expect(execute).not.toHaveBeenCalled();
});

it.each(['project', 'global'] as const)('appends only the edited modal sentence to the selected %s permission file', async (scope) => {
  await createGoalInquiry(approvalInput());
  const posted = await postedInquiry();
  if (scope === 'project') {
    const names = buttons(posted.post).map((item) => item.text.text);
    expect(names.filter((name) => /プロジェクト/u.test(name))).toHaveLength(1);
    expect(names.some((name) => /プロジェクト\s*\/\s*manager/u.test(name))).toBe(true);
    expect(names.filter((name) => /workspace/u.test(name))).toHaveLength(0);
  }
  await pressButton(posted, scope === 'project' ? /プロジェクト/u : /全体/u);
  expect((await savedInquiry()).status).toBe('pending');
  expect(await readScopedPermissions({ projectDirectory: repository })).toEqual({ ok: true, files: [] });
  expect(openedModal().element.initial_value).toEqual(expect.stringContaining('npm test'));
  await submitModal('npm test を流してよい');
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: { decision: 'allow', scope, source: 'slack' } });
  const permissions = await readScopedPermissions({ projectDirectory: repository });
  expect(permissions).toMatchObject({ ok: true, files: [{ scope, content: '## 許可\n- npm test を流してよい\n' }] });
});

it('offers workspace approval only for a multi-repository manager and saves the confirmed sentence there', async () => {
  const second = join(directory, 'second');
  mkdirSync(second);
  const workspaceId = '750e8400-e29b-41d4-a716-446655440001';
  const workspace = { id: workspaceId, name: 'Workspace', repositoryDirectories: [repository, second] };
  mkdirSync(join(directory, 'workspaces', workspaceId), { recursive: true });
  writeFileSync(join(directory, 'workspaces', workspaceId, 'workspace.json'), JSON.stringify(workspace));
  vi.spyOn(managerAssignments, 'resolveCurrentManagerAssignment').mockResolvedValue({
    kind: 'workspace', workspaceId, name: workspace.name, repositoryDirectories: workspace.repositoryDirectories,
  });
  await createGoalInquiry(approvalInput());
  const posted = await postedInquiry();
  await pressButton(posted, /workspace/u);
  expect((await savedInquiry()).status).toBe('pending');
  await submitModal('npm test を流してよい');
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: { decision: 'allow', scope: 'workspace', source: 'slack' } });
  expect(await readScopedPermissions({ projectDirectory: repository, workspaceId })).toMatchObject({
    ok: true, files: [{ scope: 'workspace', content: '## 許可\n- npm test を流してよい\n' }],
  });
});

it.each(['ja', 'en'] as const)('renders localized approval buttons and an editable modal in %s', async (language) => {
  await slack.close();
  sdk.on.mockClear();
  writeFileSync(join(repository, '.takt', 'config.yaml'), `language: ${language}\nmanager:\n  slack:\n    channel_id: C0123\n    allowed_user_ids: [U0AAA]\n`);
  invalidateResolvedConfigCache(repository);
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
  await createGoalInquiry(approvalInput());
  const posted = await postedInquiry();
  const names = buttons(posted.post).map((item) => item.text.text);
  for (const choice of ['once', 'goal', 'projectManager', 'global', 'deny']) {
    const label = getLabel(`manager.answerChoices.${choice}`, language);
    expect(label).not.toBe(`manager.answerChoices.${choice}`);
    expect(names.some((name) => name.includes(label))).toBe(true);
  }
  await pressButton(posted, language === 'ja' ? /プロジェクト/u : /Project/u);
  const modal = openedModal();
  expect(modal.view.title.text.trim().length).toBeGreaterThan(0);
  expect(modal.input.label.text.trim().length).toBeGreaterThan(0);
  expect(modal.element.initial_value).toEqual(expect.stringContaining('npm test'));
  for (const text of [modal.view.title.text, modal.input.label.text, modal.view.submit?.text, modal.view.close?.text]) {
    expect(text).toBeDefined();
    expect(text).not.toMatch(/^manager\./u);
    if (language === 'en') expect(text).not.toMatch(/[ぁ-んァ-ヶ一-龠]/u);
  }
});

it.each(['closed', '', '   '] as const)('leaves the inquiry and permissions unchanged when the modal is %j', async (response) => {
  const question = await createGoalInquiry(approvalInput());
  const before = await readScopedPermissions({ projectDirectory: repository });
  await pressButton(await postedInquiry(), /プロジェクト/u);
  if (response === 'closed') await interactive({ type: 'view_closed', view: { ...openedModal().view, id: 'V1' } });
  else await submitModal(response);
  await answersFinished();
  expect(await savedInquiry()).toEqual(question);
  expect(await readScopedPermissions({ projectDirectory: repository })).toEqual(before);
});

it('rejects a modal submission after the same inquiry is withdrawn without appending permission', async () => {
  const question = await createGoalInquiry(approvalInput());
  await pressButton(await postedInquiry(), /プロジェクト/u);
  await new GoalStore(repository).update(goalRecord().id, (goal) => ({ ...goal,
    questions: [{ ...question, status: 'withdrawn', withdrawnAt: new Date().toISOString() }] }));
  await submitModal('npm test を流してよい');
  await answersFinished();
  expect((await savedInquiry()).status).toBe('withdrawn');
  expect(await readScopedPermissions({ projectDirectory: repository })).toEqual({ ok: true, files: [] });
});

it('saves the selected B button as a Slack answer', async () => {
  await createGoalInquiry({ body: '形式を選択してください', options: ['A', 'B'] });
  const posted = await postedInquiry();
  expect(posted.post.text).toContain('形式を選択してください');
  expect(buttons(posted.post).map(({ value }) => value)).toEqual(['option_0', 'option_1']);
  await pressButton(posted, /^2\. B$/u);
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: { text: 'B', source: 'slack' } });
  expect(sdk.update).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  { options: [`${'A'.repeat(75)}東`, `${'A'.repeat(75)}西`], selectedIndex: 1 },
  { options: ['2', `${'A'.repeat(75)}西`], selectedIndex: 0 },
])('saves the full selected option without interpreting its displayed number ($selectedIndex)', async ({ options, selectedIndex }) => {
  await createGoalInquiry({ body: '選択してください', options });
  await pressButton(await postedInquiry(), new RegExp(`^${selectedIndex + 1}\\. `, 'u'));
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: { text: options[selectedIndex], source: 'slack' } });
  expect(execute).not.toHaveBeenCalled();
});

it('saves page_1 as free text without treating it as a page operation', async () => {
  await createGoalInquiry({ body: 'Q'.repeat(10000) });
  const posted = await postedInquiry();
  await (await emit({ thread_ts: posted.parentTs, text: 'page_1' })).pending;
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ answer: { text: 'page_1', source: 'slack' } });
  expect(sdk.update).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it.each(['operation_request', 'approval'] as const)('posts %s actions initially and saves the answer', async (kind) => {
  await createGoalInquiry(kind === 'approval' ? approvalInput() : { kind, body: '作業を実施してください' });
  const posted = await postedInquiry();
  expect(sdk.post).toHaveBeenCalledOnce();
  if (kind === 'operation_request') {
    await pressButton(posted, /実施した/u);
    await answersFinished();
    expect(await savedInquiry()).toMatchObject({ answer: { report: 'completed', source: 'slack' } });
  } else {
    expect(buttons(posted.post).some(({ value }) => value === 'allow_once')).toBe(true);
    expect(buttons(posted.post).some(({ value }) => value === 'allow_goal')).toBe(true);
    await pressButton(posted, /プロジェクト/u);
    await submitModal('npm test を流してよい');
    await answersFinished();
    expect(await savedInquiry()).toMatchObject({ answer: { decision: 'allow', scope: 'project', source: 'slack' } });
    expect(await readScopedPermissions({ projectDirectory: repository })).toMatchObject({ ok: true, files: [{ scope: 'project', content: '## 許可\n- npm test を流してよい\n' }] });
  }
  expect(sdk.update).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it.each([undefined, 'thread_broadcast'])('saves an inquiry thread reply with subtype %s without passing it to the provider', async (subtype) => {
  await reopenSharedSlack(['U0AAA']);
  await createGoalInquiry({ body: '幅を確認してください' });
  const posted = await postedInquiry();
  await (await emit({ subtype, thread_ts: posted.parentTs, ts: '1700000000.000100', text: '幅 80 で問題なし' })).pending;
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: { text: '幅 80 で問題なし', source: 'slack' } });
  expect(execute).not.toHaveBeenCalled();
});

it.each(['U0AAA', 'U0DIR'])('uses manager authorization for a shared-channel inquiry reply from %s', async (user) => {
  await reopenSharedSlack(['U0DIR']);
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  const posted = await postedInquiry();
  const open = vi.spyOn(service, 'open');
  const submit = vi.spyOn(service, 'submit');
  await (await emit({ user, thread_ts: posted.parentTs, ts: '1700000000.000100', text: '幅 80 で問題なし' })).pending;
  await answersFinished();
  if (user === 'U0AAA') {
    expect(await savedInquiry()).toMatchObject({ id: question.id, status: 'answered', answer: { text: '幅 80 で問題なし', source: 'slack' } });
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ assignment: { kind: 'repository', repositoryDirectory: repository } }), expect.any(Object));
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: expect.objectContaining({ kind: 'answer_question' }) }));
  } else {
    expect(await savedInquiry()).toEqual(question);
    expect(open).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(sdk.post).toHaveBeenCalledOnce();
  }
  expect(execute).not.toHaveBeenCalled();
});

it('routes an unbound shared-channel thread to director and replies there without answering the inquiry', async () => {
  await reopenSharedSlack(['U0AAA']);
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  const posted = await postedInquiry();
  const parentTs = '1700000000.000002';
  expect(parentTs).not.toBe(posted.parentTs);
  const open = vi.spyOn(service, 'open');
  await (await emit({ thread_ts: parentTs, ts: '1700000000.000100', text: '幅 80 で問題なし' })).pending;
  await finished(2);
  expect(await savedInquiry()).toEqual(question);
  expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ assignment: { kind: 'daemon' } }), expect.any(Object));
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: '幅 80 で問題なし', assignment: undefined }));
  expect(sdk.post.mock.calls[1]![0]).toMatchObject({ channel: 'C0123', thread_ts: parentTs, text: 'reply:幅 80 で問題なし' });
});

it('passes the same reply in an ordinary thread to the conversation while leaving the inquiry pending', async () => {
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  await postedInquiry();
  await (await emit({ thread_ts: '1700000000.000002', ts: '1700000000.000100', text: '幅 80 で問題なし' })).pending;
  await finished(2);
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: '幅 80 で問題なし' }));
  expect(await savedInquiry()).toEqual(question);
});

it.each([{ subtype: 'message_changed' }, { subtype: 'message_deleted' }, { bot_id: 'B1' }])(
  'ignores inquiry thread edits, deletions and bot posts %j', async (overrides) => {
    await reopenSharedSlack(['U0AAA']);
    const question = await createGoalInquiry({ body: '幅を確認してください' });
    const posted = await postedInquiry();
    await (await emit({ thread_ts: posted.parentTs, text: '幅 80 で問題なし', ...overrides })).pending;
    expect(await savedInquiry()).toEqual(question);
    expect(execute).not.toHaveBeenCalled();
    expect(sdk.post).toHaveBeenCalledOnce();
  },
);

it.each(['answered', 'withdrawn'] as const)('keeps an %s inquiry thread separate from the conversation on later replies', async (status) => {
  await reopenSharedSlack(['U0AAA']);
  await createGoalInquiry({ body: '幅を確認してください' });
  const posted = await postedInquiry();
  if (status === 'answered') {
    await (await emit({ thread_ts: posted.parentTs, text: '幅 80 で問題なし' })).pending;
    await answersFinished();
  } else {
    await new GoalStore(repository).update(goalRecord().id, (goal) => ({ ...goal,
      questions: goal.questions!.map((question) => ({ ...question, status, withdrawnAt: new Date().toISOString() })) }));
  }
  const saved = await savedInquiry();
  expect(saved.status).toBe(status);
  await (await emit({ thread_ts: posted.parentTs, text: '後から追記' })).pending;
  await answersFinished();
  expect(await savedInquiry()).toEqual(saved);
  expect(execute).not.toHaveBeenCalled();
});

it('restores the inquiry parent binding after reopening the Slack port and answers without a provider turn', async () => {
  await reopenSharedSlack(['U0AAA']);
  await createGoalInquiry({ body: '幅を確認してください' });
  const posted = await postedInquiry();
  await reopenSharedSlack(['U0AAA']);
  await (await emit({ thread_ts: posted.parentTs, text: '幅 80 で問題なし' })).pending;
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: { text: '幅 80 で問題なし', source: 'slack' } });
  expect(execute).not.toHaveBeenCalled();
});

it('accepts an inquiry button after reopening the Slack port', async () => {
  await createGoalInquiry(approvalInput());
  const posted = await postedInquiry();
  await reopenSlack();
  await pressButton(posted, /今回だけ/u);
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: { decision: 'allow', scope: 'once', source: 'slack' } });
  expect(execute).not.toHaveBeenCalled();
});

it.each(['completed', 'unable'] as const)('saves an operation request button as report %s', async (report) => {
  await createGoalInquiry({ kind: 'operation_request', body: '認証を更新してください' });
  await pressButton(await postedInquiry(), report === 'completed' ? /実施した/u : /対応できない/u);
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ status: 'answered', answer: { report, source: 'slack' } });
  expect(execute).not.toHaveBeenCalled();
});

it.each(['approval', 'operation_request'] as const)('does not infer a structured %s answer from free text', async (kind) => {
  await reopenSharedSlack(['U0AAA']);
  const question = await createGoalInquiry(kind === 'approval' ? approvalInput() : { kind, body: '認証を更新してください' });
  const posted = await postedInquiry();
  await (await emit({ thread_ts: posted.parentTs, text: 'できました' })).pending;
  await answersFinished();
  expect(await savedInquiry()).toEqual(question);
  expect(execute).not.toHaveBeenCalled();
});

it('posts and answers an ordinary goal-less tool permission inquiry for its saved owner', async () => {
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const inquiry = await saveManagerToolPermissionInquiry({
    request: { toolName: 'Bash', toolInput: { command: 'npm test' }, cwd: repository },
    reason: 'テスト実行の確認', configDirectory: directory, owner,
  });
  expect(inquiry.options).toBeUndefined();
  const posted = await postedInquiry();
  await pressButton(posted, /今回だけ/u);
  await answersFinished();
  expect(await new StandaloneInquiryStore(directory, owner).get(inquiry.id)).toMatchObject({
    status: 'answered', answer: { decision: 'allow', scope: 'once', source: 'slack' },
  });
  expect(await readScopedPermissions({ projectDirectory: repository })).toEqual({ ok: true, files: [] });
  expect(execute).not.toHaveBeenCalled();
});

it.each([{ user: { id: 'U0BBB' } }, { channel: { id: 'C0999' } }])(
  'ignores unauthorized approval buttons before opening a modal or saving an answer %j', async (overrides) => {
    const question = await createGoalInquiry(approvalInput());
    const posted = await postedInquiry();
    await (await emit({ user: 'U0BBB' })).pending;
    await pressButton(posted, /今回だけ/u, overrides);
    await pressButton(posted, /プロジェクト/u, overrides);
    expect(await savedInquiry()).toEqual(question);
    expect(sdk.open).not.toHaveBeenCalled();
    expect(sdk.post).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  },
);

it('ignores a modal submission by a user outside the configured allowlist', async () => {
  const question = await createGoalInquiry(approvalInput());
  await pressButton(await postedInquiry(), /プロジェクト/u);
  await submitModal('npm test を流してよい', { user: { id: 'U0BBB' } });
  await answersFinished();
  expect(await savedInquiry()).toEqual(question);
  expect(await readScopedPermissions({ projectDirectory: repository })).toEqual({ ok: true, files: [] });
});

it('rejects a generated button replayed on a different parent post', async () => {
  const question = await createGoalInquiry({ body: '選択してください', options: ['A', 'B'] });
  const posted = await postedInquiry();
  await pressButton({ ...posted, parentTs: '1700000000.999999' }, /^2\. B$/u);
  await answersFinished();
  expect(await savedInquiry()).toEqual(question);
  expect(execute).not.toHaveBeenCalled();
});

it('rejects an inquiry button while the TUI provider is busy and never saves it after that turn finishes', async () => {
  const question = await createGoalInquiry(approvalInput());
  const posted = await postedInquiry();
  const gate = new Promise<void>((resolve) => { release = resolve; });
  execute.mockImplementationOnce(async (input) => {
    await gate;
    return { message: 'later', summary: null, sessionId: 'session', assignment: input.assignment };
  });
  expect((await submitTui('local')).kind).toBe('accepted');
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  await pressButton(posted, /今回だけ/u);
  expect(await savedInquiry()).toEqual(question);
  release!();
  await answersFinished();
  expect(await savedInquiry()).toEqual(question);
  expect(execute).toHaveBeenCalledOnce();
  expect(sdk.open).not.toHaveBeenCalled();
});

it('does not retry a failed inquiry post on subsequent polling rounds', async () => {
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  sdk.post.mockRejectedValueOnce(new Error('Slack unavailable'));
  await pollInquiries();
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  expect(await savedInquiry()).toEqual(question);
  expect(execute).not.toHaveBeenCalled();
});

it('does not resend an inquiry after a failed post and daemon port recreation', async () => {
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  sdk.post.mockRejectedValueOnce(new Error('Slack unavailable'));
  await pollInquiries();
  await reopenSlack();
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  expect(await savedInquiry()).toEqual(question);
});

it('treats replies as conversation when the post response is lost', async () => {
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  sdk.post.mockRejectedValueOnce(new Error('response lost'));
  await pollInquiries();
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  expect(sdk.post.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining(question.body) });
  await (await emit({ thread_ts: '1700000000.000001', text: '幅80' })).pending;
  await finished(2);
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: '幅80' }));
  expect(await savedInquiry()).toEqual(question);
});

it('does not resend an attempted ordinary goal-less approval after recreation', async () => {
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const question = await saveManagerToolPermissionInquiry({ request: { toolName: 'Bash', toolInput: { command: 'npm test' }, cwd: repository },
    reason: '確認', configDirectory: directory, owner });
  sdk.post.mockRejectedValueOnce(new Error('Slack unavailable'));
  await pollInquiries();
  await reopenSlack();
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  expect(await new StandaloneInquiryStore(directory, owner).get(question.id)).toMatchObject({ status: 'pending' });
});

it('posts a new inquiry when its bindings cannot be read before posting', async () => {
  const question = await createGoalInquiry({ body: '幅を確認してください', options: ['A', 'B'] });
  const bindingDirectory = join(directory, 'slack-inquiries');
  writeFileSync(bindingDirectory, 'unavailable');
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  expect(sdk.post.mock.calls[0]![0]).toMatchObject({ channel: 'C0123', text: expect.stringContaining(question.body), blocks: expect.arrayContaining([expect.objectContaining({ type: 'actions' })]) });
  expect(sdk.post.mock.calls[0]![0].thread_ts).toBeUndefined();
  expect(buttons(sdk.post.mock.calls[0]![0]).map((value) => value.text.text)).toEqual(expect.arrayContaining(['1. A', '2. B']));
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  await (await emit({ thread_ts: '1700000000.000001', text: '幅 80 で問題なし' })).pending;
  await finished(2);
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: '幅 80 で問題なし' }));
  expect(await savedInquiry()).toEqual(question);
});

it.each(['recovered', 'unavailable'] as const)('routes a reply to conversation when the posted inquiry binding cannot be saved and storage is %s', async (storage) => {
  const question = await createGoalInquiry({ body: '幅を確認してください', options: ['A', 'B'] });
  const bindingDirectory = join(directory, 'slack-inquiries');
  const savedDirectory = join(directory, 'slack-inquiries-saved');
  let directoryExisted = false;
  sdk.post.mockImplementationOnce(async () => {
    directoryExisted = existsSync(bindingDirectory);
    if (directoryExisted) renameSync(bindingDirectory, savedDirectory);
    writeFileSync(bindingDirectory, 'unavailable');
    return { ok: true, ts: '1700000000.000001' };
  });
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  expect(sdk.post.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining(question.body), blocks: expect.any(Array) });
  if (storage === 'recovered') {
    unlinkSync(bindingDirectory);
    if (directoryExisted) renameSync(savedDirectory, bindingDirectory);
  }
  await pollInquiries();
  expect(sdk.post).toHaveBeenCalledOnce();
  await (await emit({ thread_ts: '1700000000.000001', text: '幅 80 で問題なし' })).pending;
  await finished(2);
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: '幅 80 で問題なし' }));
  expect(await savedInquiry()).toEqual(question);
  expect(sdk.history).not.toHaveBeenCalled();
});

it('routes a reply to conversation when a saved inquiry binding cannot be read', async () => {
  await reopenSharedSlack(['U0AAA']);
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  const posted = await postedInquiry();
  const bindingDirectory = join(directory, 'slack-inquiries');
  const savedDirectory = join(directory, 'slack-inquiries-saved');
  renameSync(bindingDirectory, savedDirectory);
  writeFileSync(bindingDirectory, 'unavailable');
  const open = vi.spyOn(service, 'open');
  try {
    await (await emit({ thread_ts: posted.parentTs, text: '幅 80 で問題なし' })).pending;
    await finished(2);
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ assignment: { kind: 'daemon' } }), expect.any(Object));
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: '幅 80 で問題なし' }));
    expect(sdk.post.mock.calls[1]![0]).toMatchObject({ channel: 'C0123', thread_ts: posted.parentTs, text: 'reply:幅 80 で問題なし' });
    expect(await savedInquiry()).toEqual(question);
    expect(sdk.history).not.toHaveBeenCalled();
  } finally {
    unlinkSync(bindingDirectory);
    renameSync(savedDirectory, bindingDirectory);
  }
});

it('does not post or answer new inquiries after Slack admission closes', async () => {
  slack.stopAccepting();
  const question = await createGoalInquiry({ body: '幅を確認してください' });
  await pollInquiries();
  await (await emit({ text: '回答です' })).pending;
  expect(sdk.post).not.toHaveBeenCalled();
  expect(await savedInquiry()).toEqual(question);
  expect(execute).not.toHaveBeenCalled();
});

it.each([{ user: 'U0BBB' }, { channel: 'C0999' }, { channel_type: 'im' },
  ...[{ user: 'U0BBB' }, { channel: 'C0999' }, { channel_type: 'im' }, { bot_id: 'B1' }].map((overrides) => ({
    subtype: 'thread_broadcast', thread_ts: '1700000000.000001', ...overrides,
  })), {
  subtype: 'message_changed', message: { user: 'U0AAA', text: 'edited', ts: '1700000000.000001' },
}])('ignores filtered Slack input without opening a conversation or posting %j', async (event) => {
  const open = vi.spyOn(service, 'open');
  const before = readFileSync(join(directory, 'conversations', `${selected.conversationId}.json`), 'utf-8');
  await (await emit(event)).pending;
  expect(open).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(sdk.post).not.toHaveBeenCalled();
  expect(readFileSync(join(directory, 'conversations', `${selected.conversationId}.json`), 'utf-8')).toBe(before);
});

it('keeps credentials out of configuration, logs, conversations, inquiries and replies after a turn, answer and connection failure', async () => {
  await (await emit()).pending; await finished(1);
  const question = await createGoalInquiry({ body: '形式を選択してください', options: ['A', 'B'] });
  await pressButton(await postedInquiry(), /^2\. B$/u);
  await answersFinished();
  expect(await savedInquiry()).toMatchObject({ id: question.id, status: 'answered', answer: { text: 'B', source: 'slack' } });
  await slack.close();
  sdk.start.mockRejectedValueOnce(new Error('xapp-test-1 xoxb-test-2'));
  slack = await createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
  expect(slack.listening).toBe(false);
  const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  expect(files.some(({ name }) => name === 'daemon.log')).toBe(true);
  expect(files.some(({ name }) => name === `${selected.conversationId}.json`)).toBe(true);
  expect(files.some(({ name }) => name === 'goal.json')).toBe(true);
  for (const entry of files) {
    const content = readFileSync(join(entry.parentPath, entry.name), 'utf-8');
    for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(content, entry.name).not.toContain(token);
  }
  for (const [post] of sdk.post.mock.calls) for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(JSON.stringify(post)).not.toContain(token);
  for (const [update] of sdk.update.mock.calls) for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(JSON.stringify(update)).not.toContain(token);
  for (const [modal] of sdk.open.mock.calls) for (const token of ['xapp-test-1', 'xoxb-test-2']) expect(JSON.stringify(modal)).not.toContain(token);
});

it.each(['standalone', 'goal'] as const)('serializes a real %s inquiry save with the initial scan after Slack connects', async (kind) => {
  await slack.close();
  sdk.on.mockClear();
  await new GoalStore(repository).create(goalRecord());
  let beginScan!: () => void;
  let resumeScan!: () => void;
  const scanning = new Promise<void>((resolve) => { beginScan = resolve; });
  const gate = new Promise<void>((resolve) => { resumeScan = resolve; });
  const original = GoalStore.prototype.iterate;
  vi.spyOn(GoalStore.prototype, 'iterate').mockImplementation(async function* (this: GoalStore) {
    beginScan();
    await gate;
    yield* original.call(this);
  });
  const connecting = createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
  await scanning;
  const owner = { kind: 'repository' as const, repositoryDirectory: repository };
  const saving = kind === 'standalone'
    ? new StandaloneInquiryStore(directory, owner).create({ body: '接続後の問い合わせ' })
    : saveManagerToolPermissionInquiry({ request: { toolName: 'Bash', toolInput: {}, cwd: repository },
      reason: '接続後の問い合わせ', configDirectory: directory, owner,
      goal: { id: goalRecord().id, repositoryDirectory: repository, constraints: [] } });
  try {
    resumeScan();
    slack = await connecting;
    await saving;
    await Promise.all([pollInquiries(), pollInquiries()]);
    expect(sdk.post).toHaveBeenCalledOnce();
    expect(sdk.post.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining('接続後の問い合わせ') });
  } finally { resumeScan(); }
});

it('keeps saving through a long initial scan and posts only the new inquiry', async () => {
  await slack.close();
  sdk.on.mockClear();
  const store = new StandaloneInquiryStore(directory, { kind: 'repository', repositoryDirectory: repository });
  await store.create({ body: '接続前の問い合わせ' });
  let beginScan!: () => void;
  let resumeScan!: () => void;
  const scanning = new Promise<void>((resolve) => { beginScan = resolve; });
  const gate = new Promise<void>((resolve) => { resumeScan = resolve; });
  const original = GoalStore.prototype.iterate;
  vi.spyOn(GoalStore.prototype, 'iterate').mockImplementation(async function* (this: GoalStore) {
    beginScan();
    await gate;
    yield* original.call(this);
  });
  const connecting = createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
  await scanning;
  let settled = false;
  const saving = store.create({ body: '接続後の問い合わせ' });
  const result = saving.then((value) => { settled = true; return { value }; }, (error: unknown) => { settled = true; return { error }; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    expect(settled).toBe(false);
    resumeScan();
    slack = await connecting;
    const saved = await result;
    if ('error' in saved) throw saved.error;
    expect((await store.get(saved.value.id)).status).toBe('pending');
    await Promise.all([pollInquiries(), pollInquiries()]);
    expect(sdk.post).toHaveBeenCalledOnce();
    expect(sdk.post.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining('接続後の問い合わせ') });
  } finally { resumeScan(); }
}, 20_000);

it('posts a new inquiry saved in another process after the initial scan', async () => {
  await slack.close();
  sdk.on.mockClear();
  const store = new StandaloneInquiryStore(directory, { kind: 'repository', repositoryDirectory: repository });
  await store.create({ body: '別プロセスの接続前' });
  let beginScan!: () => void;
  let resumeScan!: () => void;
  const scanning = new Promise<void>((resolve) => { beginScan = resolve; });
  const gate = new Promise<void>((resolve) => { resumeScan = resolve; });
  const original = GoalStore.prototype.iterate;
  vi.spyOn(GoalStore.prototype, 'iterate').mockImplementation(async function* (this: GoalStore) {
    beginScan();
    await gate;
    yield* original.call(this);
  });
  const connecting = createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' } });
  await scanning;
  const script = `import { StandaloneInquiryStore } from './src/infra/goals/standalone-inquiries.ts';
    process.send('starting');
    const store = new StandaloneInquiryStore(process.argv[1], { kind: 'repository', repositoryDirectory: process.argv[2] });
    const saved = await store.create({ body: '別プロセスの接続後' });
    process.send(saved.id);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory, repository],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    expect((await once(child, 'message'))[0]).toBe('starting');
    let completed = false;
    const savedId = once(child, 'message').then((message) => { completed = true; return message; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(completed).toBe(false);
    resumeScan();
    slack = await connecting;
    const [id] = await savedId;
    const [status] = await exited;
    expect(status).toBe(0);
    expect((await store.get(id as string)).status).toBe('pending');
    await Promise.all([pollInquiries(), pollInquiries()]);
    expect(sdk.post).toHaveBeenCalledOnce();
    expect(sdk.post.mock.calls[0]![0]).toMatchObject({ text: expect.stringContaining('別プロセスの接続後') });
  } finally {
    resumeScan();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}, 20_000);

it('routes a reply to conversation when a saved binding has an old publication state', async () => {
  const question = await createGoalInquiry({ kind: 'question', body: '保存済みの質問' });
  const posted = await postedInquiry();
  const bindingDirectory = join(directory, 'slack-inquiries');
  const file = join(bindingDirectory, readdirSync(bindingDirectory).find((entry) => entry.endsWith('.json'))!);
  const [saved] = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  writeFileSync(file, JSON.stringify([{ ...saved, state: 'published' }]));
  await (await emit({ text: '幅 80 で問題なし', thread_ts: posted.parentTs })).pending;
  await finished(2);
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ instruction: '幅 80 で問題なし' }));
  expect(await savedInquiry()).toEqual(question);
});

it.each(['failure', 'abort'] as const)('releases the inquiry lock after connection %s', async (outcome) => {
  await slack.close();
  sdk.on.mockClear();
  const controller = new AbortController();
  let finishStart!: () => void;
  const gate = new Promise<void>((resolve) => { finishStart = resolve; });
  sdk.start.mockImplementationOnce(async () => {
    if (outcome === 'failure') throw new Error('connection failed');
    await gate;
    return { ok: true };
  });
  const initializing = createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' }, signal: controller.signal });
  try {
    if (outcome === 'abort') {
      await vi.waitFor(() => expect(sdk.start).toHaveBeenCalledTimes(2));
      controller.abort();
      finishStart();
    }
    slack = await initializing;
    expect(slack.listening).toBe(false);
    const store = new StandaloneInquiryStore(directory, { kind: 'repository', repositoryDirectory: repository });
    const saved = await store.create({ body: '接続終了後の問い合わせ' });
    expect(await store.get(saved.id)).toMatchObject({ id: saved.id, status: 'pending' });
  } finally { finishStart(); }
});

it('releases the inquiry lock on abort without waiting for the Slack connection', async () => {
  await slack.close();
  sdk.on.mockClear();
  const controller = new AbortController();
  let finishStart!: () => void;
  const gate = new Promise<void>((resolve) => { finishStart = resolve; });
  sdk.start.mockImplementationOnce(async () => { await gate; return { ok: true }; });
  const initializing = createDaemonSlackPorts({ projects: [repository], configDirectory: directory, input: service,
    tokens: { appToken: 'xapp-test-1', botToken: 'xoxb-test-2' }, signal: controller.signal });
  try {
    await vi.waitFor(() => expect(sdk.start).toHaveBeenCalledTimes(2));
    controller.abort();
    let initialized = false;
    const result = initializing.then((port) => { initialized = true; return port; });
    await vi.waitFor(() => expect(initialized).toBe(true));
    slack = await result;
    expect(slack.listening).toBe(false);
    const store = new StandaloneInquiryStore(directory, { kind: 'repository', repositoryDirectory: repository });
    const saved = await store.create({ body: '接続中断後の問い合わせ' });
    expect(await store.get(saved.id)).toMatchObject({ id: saved.id, status: 'pending' });
  } finally { finishStart(); }
});
