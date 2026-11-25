import { execFileSync } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { KnownBlock } from '@slack/types';
import type { TurnRunner } from '../core/daemon/ports.js';
import type { TurnOutcome } from '../core/daemon/messages.js';
import { startDaemon } from '../features/daemon/runDaemon.js';
import { createConversationTurnService } from '../features/manager/conversationService.js';
import type { PreparedConversationRuntime } from '../features/manager/conversationRuntime.js';
import type { ConversationCommand, PortOutput } from '../features/manager/conversationPort.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS } from '../features/manager/slackGoalProposal.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { installDaemonErrorLog } from '../infra/daemon/diagnostics.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { GoalStore } from '../infra/goals/store.js';
import { readManagerEvents } from '../infra/goals/events.js';
import * as slackClient from '../infra/slack/client.js';
import type { SlackClient, SlackDeliveryResult, SlackEvent } from '../infra/slack/client.js';
import { directorConversationRecord } from './helpers/conversation-fixtures.js';
import { getLabel } from '../shared/i18n/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});
const id = conversationId({ kind: 'daemon' });
const summary = { objective: '記事一覧', outOfScope: ['記事編集'], acceptanceCriteria: ['公開記事を一覧できる'], constraints: [],
  startBranch: 'main', integrationBranch: 'main' };
function buttons(blocks: readonly KnownBlock[]) {
  return blocks.flatMap((block) => block.type === 'actions' ? block.elements.filter((element) => element.type === 'button') : []);
}

async function fixture(notifyOnApproval = false) {
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'blog');
  await mkdir(join(repository, '.takt'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false',
    'commit', '--allow-empty', '-m', 'fixture'], { cwd: repository, stdio: 'pipe' });
  await writeFile(join(directory, 'config.yaml'), 'provider: mock\nlanguage: ja\nmanager:\n  auto_run: false\ndirector:\n  slack:\n    channel_id: C0DIR\n    allowed_user_ids: [U_ALLOWED]\n');
  await writeFile(join(repository, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const root = await realpath(repository);
  const managerId = conversationId({ kind: 'repository', repositoryDirectory: root });
  const store = new ConversationStateStore(directory);
  await store.create({ ...directorConversationRecord(), revision: 3 });
  const client = {
    start: vi.fn<SlackClient['start']>().mockResolvedValue(undefined),
    postMessage: vi.fn<SlackClient['postMessage']>(),
    updateMessage: vi.fn<SlackClient['updateMessage']>(),
    postThreadMessage: vi.fn<SlackClient['postThreadMessage']>().mockResolvedValue({ kind: 'delivered' }),
    stopAccepting: vi.fn<SlackClient['stopAccepting']>(), close: vi.fn<SlackClient['close']>().mockResolvedValue(undefined),
  };
  const posts = new Map<string, { text: string; blocks: KnownBlock[] }>();
  const updateResults: SlackDeliveryResult[] = [];
  client.postMessage.mockImplementation(async (_channel, text, blocks) => {
    const parentTs = posts.size === 0 ? 'posted' : `posted-${posts.size + 1}`;
    posts.set(parentTs, { text, blocks });
    return { kind: 'delivered', parentTs };
  });
  client.updateMessage.mockImplementation(async (thread, text, blocks) => {
    const result = updateResults.shift() ?? { kind: 'delivered' as const };
    if (result.kind === 'delivered') posts.set(thread.parentTs, { text, blocks });
    return result;
  });
  vi.spyOn(slackClient, 'createSlackClient').mockReturnValue(client);
  const errors: string[] = [];
  const restore = installDaemonErrorLog(async (message) => { errors.push(message); });
  cleanups.push(async () => { restore(); });
  const execute = vi.fn<PreparedConversationRuntime['executor']['execute']>().mockImplementation(async () => ({
    message: '登録案を確認してください', summary: { ...summary, managerId, repositoryDirectory: root }, sessionId: undefined, assignment: undefined,
  }));
  const business = createConversationTurnService(directory, {
    async resolve(assignment) { return { provider: 'mock', model: null, language: 'ja', contextKey: 'test',
      executor: assignment.kind === 'daemon' ? { execute } : { async execute() {
        return { message: '作業を開始します', summary: null, sessionId: undefined, assignment: undefined };
      } } }; },
    async close() {},
  });
  const operations = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const daemon = await startDaemon({ configDirectory: directory,
    owner: { pid: process.pid, identity: { startTime: 'fixture' }, version: 'test', cliPath: '/daemon.js' },
    tokens: { appToken: 'xapp-test', botToken: 'xoxb-test' }, signal: new AbortController().signal,
    runnerFactory(bus): TurnRunner {
      return {
        start(value, signal) {
          const operation = (async () => {
            if (notifyOnApproval && value.event.event.kind === 'human_command' && value.event.event.command.kind === 'approve_summary') {
              await new DaemonNotifications(directory).save({ id: randomUUID(), message: '保存済みの通知',
                turnOperationId: value.turn.operationId }, signal);
            }
            return business.execute(value, { signal,
              request: (request) => bus.request(value.turn, request, signal),
              progress: (message) => bus.post({ kind: 'turn_progress', turn: value.turn, message }),
            });
          })().catch((error: unknown): TurnOutcome => {
            failures.push(error);
            return { kind: 'failed', message: String(error) };
          }).then((outcome) => bus.post({ kind: 'turn_finished', turn: value.turn, outcome }));
          operations.add(operation);
          void operation.then(() => { operations.delete(operation); }, (error: unknown) => { operations.delete(operation); failures.push(error); });
        },
        interrupt() {}, resultCommitted() {}, async close() { await Promise.all([...operations]); },
      };
    },
  });
  cleanups.push(daemon.close);
  // 登録イベントの配送待ち件数を観測する間は、受け箱の消費を止める。
  await daemon.watchers.drain();
  await daemon.watchers.close();
  const outputs: PortOutput[] = [];
  const delivery = { async deliver(_id: string, output: PortOutput) { outputs.push(output); return { kind: 'delivered' as const }; } };
  const selected = await createTuiConversationPort(directory, delivery).resolve({ kind: 'daemon' });
  const opened = await daemon.input.open(selected, delivery);
  opened.read.cancel();
  async function settled() {
    do {
      await daemon.dispatcher.drain();
      await Promise.all([...operations]);
    } while (daemon.dispatcher.activeTurnCount > 0);
    await daemon.conversations.close();
    expect(failures).toEqual([]);
  }
  return { ...daemon, directory, repository: root, managerId, client, posts, updateResults, execute, store, outputs, errors, settled,
    submit: (command: ConversationCommand) => daemon.input.submit({ attachmentId: opened.attachmentId,
      requestId: randomUUID(), speaker: selected.speaker, command }),
    state: async () => (await store.read(id))!.state,
    goals: () => new GoalStore(root).list(),
    events: () => readManagerEvents(root).filter(({ event }) => event.kind === 'registered'),
    async receive(event: SlackEvent) { await client.start.mock.calls[0]![0](event); await settled(); },
  };
}

it('delivers a saved TUI proposal through the daemon to director Slack with both revision four buttons', async () => {
  const f = await fixture();
  expect(await f.submit({ kind: 'message', text: 'ブログに記事一覧を追加して' })).toMatchObject({ kind: 'accepted' });
  await f.settled();
  expect(f.input.connectedPorts(id)).toEqual(['tui']);
  expect((await f.state()).pending).toMatchObject({ revision: 4, managerId: f.managerId, repositoryDirectory: f.repository });
  expect(await f.goals()).toEqual({ goals: [], errors: [] });
  expect(f.client.postMessage).toHaveBeenCalledOnce();
  const [channel, text, blocks] = f.client.postMessage.mock.calls[0]!;
  expect(channel).toBe('C0DIR');
  for (const part of [summary.objective, ...summary.outOfScope, ...summary.acceptanceCriteria, f.managerId, f.repository]) {
    expect(text + JSON.stringify(blocks)).toContain(part);
  }
  expect(buttons(blocks).map((button) => button.action_id)).toEqual([SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS]);
  for (const button of buttons(blocks)) expect(JSON.parse(button.value!)).toEqual({ conversationId: id, revision: 4 });
  expect(f.events()).toEqual([]);
});

function actionEvent(actionId: string | undefined, value: string | undefined, userId: string, parentTs = 'posted'): SlackEvent {
  if (actionId === undefined || value === undefined) throw new Error('Expected an emitted proposal button');
  return { type: 'interactive', body: { type: 'block_actions', team: { id: 'T1' }, channel: { id: 'C0DIR' }, user: { id: userId },
    container: { type: 'message', channel_id: 'C0DIR', message_ts: parentTs }, message: { ts: parentTs },
    actions: [{ type: 'button', action_id: actionId, value }] } };
}
function messageEvent(): SlackEvent {
  return { type: 'events_api', body: { team_id: 'T1', event: {
    type: 'message', channel: 'C0DIR', user: 'U_ALLOWED', ts: '1700000000.000001', text: 'ブログに記事一覧を追加して',
  } } };
}
async function propose(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.submit({ kind: 'message', text: 'ブログに記事一覧を追加して' })).toMatchObject({ kind: 'accepted' });
  await f.settled();
  expect((await f.state()).pending?.revision).toBe(4);
}
async function registeredGoal(f: Awaited<ReturnType<typeof fixture>>, revision: number, expectedSummary = summary, expectedTurns = 1) {
  const state = await f.state();
  expect(state).toMatchObject({ pending: null, approval: { state: 'registered', revision } });
  if (state.approval === null) throw new Error('Expected a saved approval');
  const goal = await new GoalStore(f.repository).get(state.approval.goalId);
  expect(goal).toMatchObject({ ...expectedSummary, creationOrigin: 'director', questionRoute: 'director',
    directorProposal: { conversationId: id, revision } });
  expect((await f.goals()).goals).toHaveLength(1);
  expect(f.events()).toHaveLength(1);
  expect(f.execute).toHaveBeenCalledTimes(expectedTurns);
  return goal;
}
async function expectRegistered(f: Awaited<ReturnType<typeof fixture>>, revision: number) {
  const goal = await registeredGoal(f, revision);
  const [thread, text, blocks] = f.client.updateMessage.mock.calls.at(-1)!;
  expect(thread).toEqual({ channelId: 'C0DIR', parentTs: 'posted' });
  expect(text).toBe(getLabel('manager.goalRegistered', 'ja', { name: goal.objective, id: goal.id, branch: goal.branch }));
  expect(buttons(blocks)).toEqual([]);
  expect(f.posts.get('posted')).toEqual({ text, blocks });
  return goal;
}

it.each(['approve_summary', 'dismiss_summary'] as const)('reflects TUI %s on the original Slack post and rejects revision three', async (kind) => {
  const f = await fixture();
  await propose(f);
  expect(await f.submit({ kind, revision: 3, conversationId: id })).toMatchObject({ kind: 'error', code: 'stale_summary' });
  await f.settled();
  expect((await f.state()).pending?.revision).toBe(4);
  expect(f.client.updateMessage).not.toHaveBeenCalled();
  expect(f.events()).toEqual([]);

  expect(await f.submit({ kind, revision: 4, conversationId: id })).toMatchObject({ kind: 'accepted' });
  await f.settled();
  if (kind === 'approve_summary') await expectRegistered(f, 4);
  else {
    expect(await f.state()).toMatchObject({ pending: null, approval: null });
    expect(await f.goals()).toEqual({ goals: [], errors: [] });
    expect(f.events()).toEqual([]);
    expect(f.client.updateMessage).toHaveBeenCalledExactlyOnceWith({ channelId: 'C0DIR', parentTs: 'posted' },
      getLabel('manager.slackGoalDismiss', 'ja'), []);
    expect(f.posts.get('posted')).toEqual({ text: getLabel('manager.slackGoalDismiss', 'ja'), blocks: [] });
  }
  expect(f.outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: expect.objectContaining({
    kind: kind === 'approve_summary' ? 'goal_registered' : 'notice',
  }) }));
});

async function proposeObjective(f: Awaited<ReturnType<typeof fixture>>, objective: string) {
  const next = { ...summary, objective };
  f.execute.mockImplementationOnce(async () => ({ message: '登録案を更新しました',
    summary: { ...next, managerId: f.managerId, repositoryDirectory: f.repository }, sessionId: undefined, assignment: undefined }));
  expect(await f.submit({ kind: 'message', text: 'この内容で登録案を作成して' })).toMatchObject({ kind: 'accepted' });
  await f.settled();
  expect((await f.state()).pending?.summary).toEqual(next);
  return next;
}

it.each(['delivered', 'unavailable'] as const)('keeps both revised posts registered after TUI approval when the detailed update is %s', async (detail) => {
  const f = await fixture(true);
  await proposeObjective(f, 'A'.repeat(30000));
  expect([...f.posts.keys()]).toEqual(['posted', 'posted-2']);
  const before = structuredClone(f.posts);
  f.updateResults.push({ kind: 'delivered' }, { kind: 'unavailable', reason: 'revision-offline' });
  const revised = await proposeObjective(f, 'B'.repeat(30000));
  expect((await f.state()).pending?.revision).toBe(5);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
  expect(f.client.updateMessage.mock.calls.map(([thread]) => thread.parentTs)).toEqual(['posted', 'posted-2']);
  expect(f.posts.get('posted')).not.toEqual(before.get('posted'));
  expect(f.posts.get('posted')!.text).toContain('B'.repeat(100));
  expect(f.posts.get('posted-2')).toEqual(before.get('posted-2'));
  expect(f.errors).toContain('revision-offline');
  f.updateResults.push({ kind: 'delivered' }, { kind: 'delivered' },
    ...(detail === 'delivered' ? [{ kind: 'delivered' as const }, { kind: 'delivered' as const }]
      : [{ kind: 'unavailable' as const, reason: 'detail-offline' }]));
  expect(await f.submit({ kind: 'approve_summary', revision: 5, conversationId: id })).toMatchObject({ kind: 'accepted' });
  await f.settled();
  const goal = await registeredGoal(f, 5, revised, 2);
  expect(f.outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'goal_registered', goal } }));
  expect(f.updateResults).toEqual([]);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(detail === 'delivered' ? 6 : 5);
  const terminalCalls = f.client.updateMessage.mock.calls.slice(2);
  expect(terminalCalls.slice(0, 2).map(([thread]) => thread.parentTs)).toEqual(['posted', 'posted-2']);
  expect(terminalCalls[2]![1]).toContain(goal.branch);
  for (const parentTs of ['posted', 'posted-2']) {
    const displayed = f.posts.get(parentTs)!;
    expect(displayed.text).toBe(detail === 'delivered'
      ? getLabel('manager.goalRegistered', 'ja', { name: goal.objective, id: goal.id, branch: goal.branch })
      : getLabel('director.slackGoalRegistered', 'ja', { id: goal.id }));
    expect(displayed.text).toContain(goal.id);
    expect(displayed.text).not.toContain(getLabel('manager.slackGoalDismiss', 'ja'));
    expect(buttons(displayed.blocks)).toEqual([]);
  }
  if (detail === 'unavailable') expect(f.errors).toContain('detail-offline');
  expect(f.client.postMessage).toHaveBeenLastCalledWith('C0DIR', expect.stringContaining('保存済みの通知'), []);
  expect(f.input.attachmentCount).toBe(1);
});

it('registers the revised Slack button after an unused post fails to clear and rejects the old button', async () => {
  const f = await fixture(true);
  await proposeObjective(f, 'A'.repeat(30000));
  expect([...f.posts.keys()]).toEqual(['posted', 'posted-2']);
  const oldPost = structuredClone(f.posts.get('posted-2'))!;
  const oldApprove = buttons(oldPost.blocks).find((button) => button.action_id === SLACK_GOAL_APPROVE)!;
  f.updateResults.push({ kind: 'delivered' }, { kind: 'unavailable', reason: 'unused-post-offline' });
  const revised = await proposeObjective(f, '新版の短い目的');
  expect((await f.state()).pending?.revision).toBe(5);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
  expect(f.posts.get('posted-2')).toEqual(oldPost);
  expect(f.posts.get('posted')!.text).toContain(revised.objective);
  expect(f.errors).toContain('unused-post-offline');
  const approve = buttons(f.posts.get('posted')!.blocks).find((button) => button.action_id === SLACK_GOAL_APPROVE)!;
  expect(JSON.parse(approve.value!)).toEqual({ conversationId: id, revision: 5 });
  await f.receive(actionEvent(oldApprove.action_id, oldApprove.value, 'U_ALLOWED', 'posted-2'));
  expect((await f.state()).pending?.revision).toBe(5);
  expect(await f.goals()).toEqual({ goals: [], errors: [] });
  expect(f.events()).toEqual([]);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);

  f.updateResults.push({ kind: 'delivered' }, { kind: 'delivered' }, { kind: 'unavailable', reason: 'detail-offline' });
  await f.receive(actionEvent(approve.action_id, approve.value, 'U_ALLOWED'));
  const goal = await registeredGoal(f, 5, revised, 2);
  expect(f.updateResults).toEqual([]);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(5);
  expect(f.client.updateMessage.mock.calls.slice(2, 4).map(([thread]) => thread.parentTs)).toEqual(['posted', 'posted-2']);
  expect(f.client.updateMessage.mock.calls[4]![1]).toContain(goal.branch);
  for (const parentTs of ['posted', 'posted-2']) expect(f.posts.get(parentTs)).toEqual({
    text: getLabel('director.slackGoalRegistered', 'ja', { id: goal.id }), blocks: [],
  });
  expect(f.errors).toContain('detail-offline');
  expect(f.outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'goal_registered', goal } }));
  expect(f.input.attachmentCount).toBe(1);
  expect(f.client.postMessage).toHaveBeenCalledTimes(3);
  expect(f.client.postMessage).toHaveBeenLastCalledWith('C0DIR', expect.stringContaining('保存済みの通知'), []);
  await f.receive(actionEvent(approve.action_id, approve.value, 'U_ALLOWED'));
  expect((await f.goals()).goals.map(({ id }) => id)).toEqual([goal.id]);
  expect(f.events()).toHaveLength(1);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(5);
});

it('updates the same Slack post to revision five, rejects both old buttons and dismisses the displayed revision', async () => {
  const f = await fixture();
  await propose(f);
  const oldButtons = buttons(f.client.postMessage.mock.calls[0]![2]);
  f.execute.mockImplementationOnce(async () => ({ message: '登録案を更新しました', summary: { ...summary, objective: '検索付き記事一覧',
    managerId: f.managerId, repositoryDirectory: f.repository }, sessionId: undefined, assignment: undefined }));
  expect(await f.submit({ kind: 'message', text: '検索も追加して' })).toMatchObject({ kind: 'accepted' });
  await f.settled();
  expect((await f.state()).pending).toMatchObject({ revision: 5, summary: { objective: '検索付き記事一覧' } });
  expect(f.client.postMessage).toHaveBeenCalledOnce();
  expect(f.client.updateMessage).toHaveBeenCalledOnce();
  const [thread, text, blocks] = f.client.updateMessage.mock.calls[0]!;
  expect(thread).toEqual({ channelId: 'C0DIR', parentTs: 'posted' });
  expect(text + JSON.stringify(blocks)).toContain('検索付き記事一覧');
  const updated = buttons(blocks);
  expect(updated.map((button) => button.action_id)).toEqual([SLACK_GOAL_APPROVE, SLACK_GOAL_DISMISS]);
  for (const button of updated) expect(JSON.parse(button.value!)).toEqual({ conversationId: id, revision: 5 });
  for (const button of oldButtons) await f.receive(actionEvent(button.action_id, button.value!, 'U_ALLOWED'));
  expect((await f.state()).pending?.revision).toBe(5);
  expect(f.client.updateMessage).toHaveBeenCalledOnce();
  expect(await f.goals()).toEqual({ goals: [], errors: [] });
  expect(f.events()).toEqual([]);
  const dismiss = updated.find((button) => button.action_id === SLACK_GOAL_DISMISS)!;
  await f.receive(actionEvent(dismiss.action_id, dismiss.value!, 'U_ALLOWED'));
  expect(await f.state()).toMatchObject({ pending: null, approval: null });
  expect(f.client.updateMessage).toHaveBeenLastCalledWith(thread, getLabel('manager.slackGoalDismiss', 'ja'), []);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
  expect(f.events()).toEqual([]);
  expect(f.input.attachmentCount).toBe(1);
});

it('registers a TUI proposal once through its emitted Slack button only for an allowed user', async () => {
  const f = await fixture();
  await propose(f);
  const approve = buttons(f.client.postMessage.mock.calls[0]![2]).find((button) => button.action_id === SLACK_GOAL_APPROVE)!;
  const before = await f.state();
  const accept = vi.spyOn(f.dispatcher, 'accept');
  await f.receive(actionEvent(approve.action_id, approve.value!, 'U_STRANGER'));
  expect(accept).not.toHaveBeenCalled();
  expect(await f.state()).toEqual(before);
  expect(await f.goals()).toEqual({ goals: [], errors: [] });
  expect(f.events()).toEqual([]);
  expect(f.client.updateMessage).not.toHaveBeenCalled();
  await f.receive(actionEvent(approve.action_id, approve.value!, 'U_ALLOWED'));
  const goal = await expectRegistered(f, 4);
  expect(accept).toHaveBeenCalledOnce();
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
  expect(f.client.postMessage).toHaveBeenCalledOnce();
  expect(f.input.attachmentCount).toBe(1);
  await f.receive(actionEvent(approve.action_id, approve.value!, 'U_ALLOWED'));
  expect(f.events()).toHaveLength(1);
  expect((await f.goals()).goals.map(({ id }) => id)).toEqual([goal.id]);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
});

it('posts a Slack-originated proposal and its terminal update once while replying and releasing its own attachments', async () => {
  const f = await fixture();
  await f.receive(messageEvent());
  expect(f.client.postMessage).toHaveBeenCalledOnce();
  expect(f.client.updateMessage).not.toHaveBeenCalled();
  expect(f.client.postThreadMessage).toHaveBeenCalledTimes(2);
  for (const [thread] of f.client.postThreadMessage.mock.calls) expect(thread).toEqual({ channelId: 'C0DIR', parentTs: '1700000000.000001' });
  expect(f.client.postThreadMessage.mock.calls[1]![1]).toBe('登録案を確認してください');
  expect(f.input.attachmentCount).toBe(1);
  const approve = buttons(f.client.postMessage.mock.calls[0]![2]).find((button) => button.action_id === SLACK_GOAL_APPROVE)!;
  await f.receive(actionEvent(approve.action_id, approve.value!, 'U_ALLOWED'));
  await expectRegistered(f, 4);
  expect(f.client.postMessage).toHaveBeenCalledOnce();
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
  expect(f.client.postThreadMessage).toHaveBeenCalledTimes(3);
  expect(f.input.attachmentCount).toBe(1);
});

it.each(['tui', 'slack'] as const)('does not post a proposal for a %s request whose runtime summary is null', async (origin) => {
  const f = await fixture();
  f.execute.mockResolvedValueOnce({ message: 'どちらのブログですか', summary: null, sessionId: undefined, assignment: undefined });
  if (origin === 'slack') await f.receive(messageEvent());
  else { await f.submit({ kind: 'message', text: 'ブログに記事一覧を追加して' }); await f.settled(); }
  expect(await f.state()).toMatchObject({ pending: null, approval: null });
  expect(f.client.postMessage).not.toHaveBeenCalled();
  expect(f.client.updateMessage).not.toHaveBeenCalled();
  expect(await f.goals()).toEqual({ goals: [], errors: [] });
  expect(f.events()).toEqual([]);
  if (origin === 'slack') {
    expect(f.client.postThreadMessage).toHaveBeenCalledTimes(2);
    expect(f.client.postThreadMessage).toHaveBeenLastCalledWith({ channelId: 'C0DIR', parentTs: '1700000000.000001' }, 'どちらのブログですか');
  }
  expect(f.input.attachmentCount).toBe(1);
});

it('reports an unavailable proposal post while preserving the saved pending state and TUI reply', async () => {
  const f = await fixture();
  f.client.postMessage.mockResolvedValueOnce({ kind: 'unavailable', reason: 'proposal-offline' });
  await propose(f);
  expect(f.errors).toContain('proposal-offline');
  expect((await f.state()).approval).toBeNull();
  expect(await f.goals()).toEqual({ goals: [], errors: [] });
  expect(f.events()).toEqual([]);
  expect(f.outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'reply', message: '登録案を確認してください' } }));
});

it('reports failed registration updates without rolling back or repeating registration and still delivers saved notifications', async () => {
  const f = await fixture(true);
  await propose(f);
  const original = structuredClone(f.posts.get('posted'));
  f.client.updateMessage.mockResolvedValue({ kind: 'unavailable', reason: 'update-offline' });
  await f.submit({ kind: 'approve_summary', revision: 4, conversationId: id });
  await f.settled();
  const state = await f.state();
  expect(state).toMatchObject({ pending: null, approval: { state: 'registered', revision: 4 } });
  if (state.approval === null) throw new Error('Expected a saved approval');
  const goal = await new GoalStore(f.repository).get(state.approval.goalId);
  expect(goal.directorProposal).toEqual({ conversationId: id, revision: 4 });
  expect((await f.goals()).goals).toHaveLength(1);
  expect(f.events()).toHaveLength(1);
  expect(f.outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'goal_registered', goal } }));
  expect(f.errors).toContain('update-offline');
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
  expect(f.posts.get('posted')).toEqual(original);
  for (const [, text] of f.client.updateMessage.mock.calls) expect(text).not.toContain(getLabel('manager.slackGoalDismiss', 'ja'));
  expect(f.client.postMessage).toHaveBeenCalledTimes(2);
  expect(f.client.postMessage).toHaveBeenLastCalledWith('C0DIR', expect.stringContaining('保存済みの通知'), []);
  expect(f.execute).toHaveBeenCalledOnce();
});

it.each(['tui', 'slack'] as const)('retains a registered receipt after a %s approval when only the detailed Slack update fails', async (origin) => {
  const f = await fixture(true);
  await propose(f);
  const approve = buttons(f.posts.get('posted')!.blocks).find((button) => button.action_id === SLACK_GOAL_APPROVE)!;
  f.updateResults.push({ kind: 'delivered' }, { kind: 'unavailable', reason: 'detail-offline' });
  if (origin === 'slack') await f.receive(actionEvent(approve.action_id, approve.value, 'U_ALLOWED'));
  else { await f.submit({ kind: 'approve_summary', revision: 4, conversationId: id }); await f.settled(); }
  const goal = await registeredGoal(f, 4);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
  expect(f.updateResults).toEqual([]);
  expect(f.client.updateMessage.mock.calls[1]![1]).toContain(goal.branch);
  expect(f.errors).toContain('detail-offline');
  const displayed = f.posts.get('posted')!;
  expect(displayed.text).toBe(getLabel('director.slackGoalRegistered', 'ja', { id: goal.id }));
  expect(displayed.text).not.toContain(getLabel('manager.slackGoalDismiss', 'ja'));
  expect(buttons(displayed.blocks)).toEqual([]);
  expect(f.outputs).toContainEqual(expect.objectContaining({ kind: 'result', result: { kind: 'goal_registered', goal } }));
  expect(f.input.attachmentCount).toBe(1);
  expect(f.client.postMessage).toHaveBeenCalledTimes(2);
  expect(f.client.postMessage).toHaveBeenLastCalledWith('C0DIR', expect.stringContaining('保存済みの通知'), []);
  await f.receive(actionEvent(approve.action_id, approve.value, 'U_ALLOWED'));
  expect((await f.goals()).goals.map(({ id }) => id)).toEqual([goal.id]);
  expect(f.events()).toHaveLength(1);
  expect(f.posts.get('posted')).toEqual(displayed);
  expect(f.client.updateMessage).toHaveBeenCalledTimes(2);
});
