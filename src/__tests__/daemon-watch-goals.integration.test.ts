import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WatchGoalReader } from '../features/daemon/watchers/goalReader.js';
import { readWatchGoals } from '../features/daemon/watchers/state.js';
import { FileDaemonWatchSource } from '../features/daemon/watchSource.js';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting, projectKey } from '../features/daemon/routing.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { DaemonPersistedFiles } from '../infra/daemon/persistedFiles.js';
import { GoalSchema, type Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { RemoteAssignmentSchema } from '../core/worker-pool/remoteProtocol.js';
import { GoalStore } from '../infra/goals/store.js';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { EpicStore } from '../infra/epics/store.js';
import { abortEpic, completeEpic, getEpic, recordEpicVerificationResult, startEpicVerification } from '../infra/epics/index.js';
import { completedEpicGoal, epicRecord, verificationResultFor } from './helpers/epic-fixtures.js';
import { WatchObservations, type WatchRecord } from '../features/daemon/watchers/observations.js';
import type { AcceptedEvent, EventInput } from '../core/daemon/events.js';
import { changeDirectorGoalQuestionRoute } from '../features/director/goalQuestions.js';
import { conversationId } from '../infra/conversations/identity.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { createConversationTurnService } from '../features/manager/conversationService.js';
import { turnStart } from './helpers/daemon-turn.js';
import { readManagerEvents } from '../infra/goals/events.js';
import type { InquiryNotice } from '../core/daemon/messages.js';
import type { SnapshotItem } from '../features/manager/conversationPort.js';
import { startDaemon } from '../features/daemon/runDaemon.js';
import * as slackClient from '../infra/slack/client.js';
import * as watchDirectories from '../features/daemon/watchers/directories.js';
import * as watchLoops from '../features/daemon/watchers/loop.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { readProcessOwner } from '../infra/daemon/process.js';
import { writeDaemonOwner } from '../infra/daemon/owner.js';
import { packageVersion } from '../shared/package-info.js';
import { daemonEntryPath } from '../features/daemon/lifecycle.js';
import { ConversationIpcClient } from '../features/manager/conversationIpcClient.js';
import { createTuiConversationPort } from '../features/manager/tuiConversationPort.js';
import { ControlledTurnRunner } from './helpers/controlledDaemon.js';
import { SlackInquiryBindings } from '../infra/slack/inquiryBindings.js';
import { StandaloneInquiryStore } from '../infra/goals/standalone-inquiries.js';
import type { KnownBlock } from '@slack/types';
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: vi.fn(async () => {}) }));

let directory: string;
let reader: WatchGoalReader;
let source: FileDaemonWatchSource | undefined;
let conversations: DaemonConversations | undefined;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'takt-watch-goals-')));
  reader = new WatchGoalReader();
});
afterEach(async () => {
  await reader.close();
  await source?.close(); source = undefined;
  await conversations?.close(); conversations = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function watchSource(onError: (error: unknown) => void, stateChanges?: WatchObservations,
  publish: (notice: InquiryNotice) => Promise<void> = async () => {}) {
  const globalDirectory = join(directory, 'global');
  await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: directory, command: 'manager', managerUsed: true });
  conversations = new DaemonConversations(new ConversationStateStore(globalDirectory), new DaemonRouting(globalDirectory),
    new DaemonNotifications(globalDirectory), async () => {}, onError, { readTurns: async () => [] });
  source = new FileDaemonWatchSource(conversations, publish, onError, stateChanges);
  return { source, files: new DaemonPersistedFiles(globalDirectory) };
}

async function inquiryDaemon(options: { slack: boolean; failPost?: string }) {
  const globalDirectory = getGlobalConfigDir();
  await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: directory, command: 'manager', managerUsed: true });
  if (options.slack) {
    await mkdir(join(directory, '.takt'), { recursive: true });
    await writeFile(join(directory, '.takt', 'config.yaml'), JSON.stringify({ manager: { slack: { channel_id: 'manager', allowed_user_ids: ['user'] } } }));
    await writeFile(join(globalDirectory, 'config.yaml'), JSON.stringify({ director: { slack: { channel_id: 'director', allowed_user_ids: ['user'] } } }));
  }
  const posts: Array<{ channelId: string; parentTs: string; text: string; blocks: KnownBlock[] }> = [];
  const messages = new Map<string, { parentTs: string; text: string; blocks: KnownBlock[] }>();
  let failPost = options.failPost;
  let failUpdate: string | undefined;
  const client: slackClient.SlackClient = {
    start: vi.fn(async () => {}), stopAccepting: vi.fn(), close: vi.fn(async () => {}),
    postThreadMessage: vi.fn(async () => ({ kind: 'delivered' as const })),
    postMessage: vi.fn(async (channelId, text, blocks) => {
      if (failPost === channelId) { failPost = undefined; return { kind: 'unavailable' as const, reason: 'Post unavailable' }; }
      const parentTs = `${posts.length + 1}.000`;
      posts.push({ channelId, parentTs, text, blocks });
      messages.set(channelId, { parentTs, text, blocks });
      return { kind: 'delivered' as const, parentTs };
    }),
    updateMessage: vi.fn(async (thread, text, blocks) => {
      if (failUpdate === thread.channelId) { failUpdate = undefined; return { kind: 'unavailable' as const, reason: 'Update unavailable' }; }
      expect(messages.get(thread.channelId)?.parentTs).toBe(thread.parentTs);
      messages.set(thread.channelId, { parentTs: thread.parentTs, text, blocks });
      return { kind: 'delivered' as const };
    }),
  };
  vi.spyOn(slackClient, 'createSlackClient').mockReturnValue(client);
  // ファイル監視の自動通知と idle 終了を止め、同じ watcher の実行を changed/drain で進める。
  vi.spyOn(watchDirectories, 'startDirectoryWatcher').mockReturnValue({ wake() {}, async drain() {}, async close() {} });
  const startLoop = watchLoops.startWatchLoop;
  vi.spyOn(watchLoops, 'startWatchLoop').mockImplementation((interval, observe, onError) => interval === 500
    ? { wake() {}, async drain() {}, async close() {} } : startLoop(interval, observe, onError));
  const signal = new AbortController().signal;
  const identity = await readProcessOwner(process.pid, { signal, timeoutMs: 5000 });
  if (identity === undefined) throw new Error('Missing test process identity');
  const owner = { pid: process.pid, identity: { startTime: identity.startTime }, version: packageVersion, cliPath: daemonEntryPath() };
  await writeDaemonOwner(globalDirectory, owner);
  const runner = new ControlledTurnRunner();
  const daemon = await startDaemon({ configDirectory: globalDirectory, owner,
    tokens: options.slack ? { appToken: 'test-app', botToken: 'test-bot' } : undefined, signal,
    runnerFactory(bus) { runner.bus = bus; return runner; } });
  const tui = new ConversationIpcClient({ kind: 'daemon' }, undefined, {
    port: createTuiConversationPort(globalDirectory, { async deliver() { return { kind: 'delivered' }; } }), reconnect: false,
  });
  try {
    await daemon.watchers.drain();
    await tui.connect();
    await vi.waitFor(() => expect(tui.getSnapshot().readStatus, JSON.stringify(tui.getSnapshot().items)).toBe('complete'));
  } catch (error) { tui.close(); await daemon.close(); throw error; }
  return { daemon, tui, client, posts, messages, globalDirectory,
    failNextUpdate(channelId: string) { failUpdate = channelId; },
    async tick() { daemon.watchers.changed(); await daemon.watchers.drain(); },
    async questionCount(id: string) {
      await tui.refresh();
      await vi.waitFor(() => expect(tui.getSnapshot().readStatus, JSON.stringify(tui.getSnapshot().items)).toBe('complete'));
      expect(tui.getSnapshot().connection).toBe('connected');
      return tui.getSnapshot().items.filter(item => item.kind === 'inquiry' && item.inquiry.question.id === id).length;
    },
    async close() { tui.close(); await daemon.close(); },
  };
}

function pendingDeliveryQuestion(questionType: 'permission' | 'routine') {
  return { id: randomUUID(), body: 'Which implementation?', options: ['A', 'B'], kind: 'question' as const,
    questionType, recipient: 'human' as const, status: 'pending' as const };
}

it('retries an initial director Slack post on the next watcher run and saves exactly one binding', async () => {
  const question = pendingDeliveryQuestion('permission');
  const goal = { ...goalRecord(), questions: [question] };
  await new GoalStore(directory).create(goal);
  const f = await inquiryDaemon({ slack: true, failPost: 'director' });
  try {
    expect(f.posts).toEqual([]);
    expect(await f.questionCount(question.id)).toBe(1);
    await f.tick();
    expect(f.posts).toMatchObject([{ channelId: 'director', text: expect.stringContaining(question.body) }]);
    expect(await new SlackInquiryBindings(f.globalDirectory, conversationId({ kind: 'daemon' })).question('director',
      { repositoryDirectory: directory, goalId: goal.id }, question.id)).toMatchObject({ parentTs: f.posts[0]!.parentTs });
    expect(await f.questionCount(question.id)).toBe(1);
    await f.tick();
    expect(f.client.postMessage).toHaveBeenCalledTimes(2);
    expect(f.client.updateMessage).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it.each(['manager', 'director'])('retries a new question after %s Slack fails without duplicating the other destination', async (failedChannel) => {
  const f = await inquiryDaemon({ slack: true, failPost: failedChannel });
  const question = pendingDeliveryQuestion('permission');
  try {
    await new GoalStore(directory).create({ ...goalRecord(), questions: [question] });
    await f.tick();
    expect(f.posts.some(post => post.channelId === failedChannel)).toBe(false);
    await f.tick();
    expect(f.posts.map(post => post.channelId).sort()).toEqual(['director', 'manager']);
    for (const channelId of ['manager', 'director']) {
      expect(f.messages.get(channelId)).toMatchObject({ text: expect.stringContaining(question.body) });
    }
    expect(await f.questionCount(question.id)).toBe(1);
    await f.tick();
    await vi.waitFor(() => expect(f.posts).toHaveLength(2));
  } finally { await f.close(); }
});

it.each(['manager', 'director'])('retries %s Slack updates across human director human changes on the same posts and TUI connection', async (failedChannel) => {
  execFileSync('git', ['init', '-q', directory]);
  const f = await inquiryDaemon({ slack: true });
  const question = pendingDeliveryQuestion('routine');
  const goal = { ...goalRecord(), questions: [question] };
  try {
    await new GoalStore(directory).create(goal);
    await f.tick();
    expect(f.posts).toHaveLength(2);
    const originalPosts = new Map(f.posts.map(post => [post.channelId, post.parentTs]));
    expect(await f.questionCount(question.id)).toBe(1);
    const human: AcceptedEvent = { eventId: randomUUID(), requestId: randomUUID(), conversationId: conversationId({ kind: 'daemon' }),
      source: 'tui', occurredAt: new Date().toISOString(), operationId: randomUUID(), acceptedSequence: 1, lane: 'human',
      event: { kind: 'human_command', command: { kind: 'message', text: 'Change who answers this goal' }, speaker: { namespace: 'human', id: 'user' } } };
    for (const route of ['director', 'human'] as const) {
      await changeDirectorGoalQuestionRoute(f.globalDirectory, {
        managerId: conversationId({ kind: 'repository', repositoryDirectory: directory }), cwd: directory, goalId: goal.id,
      }, route, 'human', human, new AbortController().signal);
      const previous = f.messages.get(failedChannel);
      f.failNextUpdate(failedChannel);
      await f.tick();
      expect(f.messages.get(failedChannel)).toEqual(previous);
      if (route === 'director' && failedChannel === 'director') {
        // 同じ会話の Slack 更新が失敗しても snapshot は配送される。
        await vi.waitFor(() => expect(f.tui.getSnapshot().items.filter(item => item.kind === 'inquiry' && item.inquiry.question.id === question.id))
          .toHaveLength(0));
      }
      await f.tick();
      // 昇格は配送された snapshot、戻しは画面と同じ refresh で観測する。
      if (route === 'director') {
        await vi.waitFor(() => expect(f.tui.getSnapshot().items.filter(item => item.kind === 'inquiry' && item.inquiry.question.id === question.id))
          .toHaveLength(0));
      } else expect(await f.questionCount(question.id)).toBe(1);
      for (const channelId of ['manager', 'director']) {
        const message = f.messages.get(channelId)!;
        expect(message.parentTs).toBe(originalPosts.get(channelId));
        expect(message.text).toContain(route === 'human' ? question.body : 'director');
        expect(message.blocks.some(block => block.type === 'actions')).toBe(route === 'human');
      }
      expect(await f.questionCount(question.id)).toBe(route === 'human' ? 1 : 0);
      expect(f.posts).toHaveLength(2);
      const updates = vi.mocked(f.client.updateMessage).mock.calls.length;
      await f.tick();
      expect(f.client.updateMessage).toHaveBeenCalledTimes(updates);
    }
  } finally { await f.close(); }
});

it('finishes inquiry delivery without Slack configuration and keeps one item on the connected TUI', async () => {
  const f = await inquiryDaemon({ slack: false });
  const question = pendingDeliveryQuestion('permission');
  try {
    await new GoalStore(directory).create({ ...goalRecord(), questions: [question] });
    const delivered = vi.spyOn(f.daemon.input, 'deliver');
    await f.tick();
    expect(await f.questionCount(question.id)).toBe(1);
    const inquiryCount = () => delivered.mock.calls.filter(([, output]) => output.kind === 'inquiry').length;
    expect(inquiryCount()).toBe(2);
    await f.tick();
    expect(inquiryCount()).toBe(2);
    expect(f.client.postMessage).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('keeps standalone questions on manager Slack when director Slack is configured', async () => {
  const f = await inquiryDaemon({ slack: true });
  try {
    const question = await new StandaloneInquiryStore(f.globalDirectory, { kind: 'repository', repositoryDirectory: directory })
      .create({ body: 'Which repository?', recipient: 'human', options: ['A', 'B'] });
    await f.tick();
    expect(f.posts).toMatchObject([{ channelId: 'manager', text: expect.stringContaining(question.body) }]);
    expect(await f.questionCount(question.id)).toBe(0);
    await f.tick();
    expect(f.posts).toHaveLength(1);
  } finally { await f.close(); }
});

it('connects a manager MCP question to director delivery, a human answer and the durable manager inbox', async () => {
  execFileSync('git', ['init', '-q', directory]);
  const goal = { ...goalRecord(), creationOrigin: 'director' as const, questionRoute: 'director' as const };
  await new GoalStore(directory).create(goal);
  const notices: InquiryNotice[] = [];
  const errors = vi.fn();
  const { source } = await watchSource(errors, undefined, async notice => { notices.push(notice); await conversations!.inquiry(notice); });
  const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: directory,
    managerAssignment: { kind: 'repository', repositoryDirectory: directory } });
  const client = new Client({ name: 'question-routing', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const result = await client.callTool({ name: 'takt_ask_goal_question', arguments: {
      cwd: directory, goalId: goal.id, body: 'May I use the paid service?', questionType: 'permission',
    } });
    expect(result.isError).toBeUndefined();
    const saved = (await new GoalStore(directory).get(goal.id)).questions![0]!;
    expect(saved).toMatchObject({ questionType: 'permission', recipient: 'human', status: 'pending' });
    await source.inquiries();
    expect(notices).toContainEqual(expect.objectContaining({ conversationId: conversationId({ kind: 'daemon' }), question: expect.objectContaining({ id: saved.id }) }));
    const snapshot = await conversations!.snapshot(conversationId({ kind: 'daemon' }), { toolHistory: false });
    const displayed = [];
    try { for await (const item of snapshot.items) if (item.kind === 'inquiry') displayed.push(item.inquiry); snapshot.complete(); }
    finally { snapshot.cancel(); }
    expect(displayed).toContainEqual(expect.objectContaining({ question: expect.objectContaining({ id: saved.id, recipient: 'human' }) }));
    const resolve = vi.fn();
    const service = createConversationTurnService(join(directory, 'global'), { resolve, close: vi.fn() });
    const turn = turnStart();
    turn.state.assignment = { kind: 'daemon' };
    turn.turn.conversationId = conversationId(turn.state.assignment);
    turn.event.conversationId = turn.turn.conversationId;
    turn.event.event = { kind: 'inquiry_answer', command: { kind: 'answer_question', target: { repositoryDirectory: directory, goalId: goal.id },
      questionId: saved.id, answer: { text: 'Use the approved service' }, source: 'tui' } };
    const answer = await service.execute(turn, { signal: new AbortController().signal, request: vi.fn(), progress: vi.fn() });
    expect(answer).toMatchObject({ kind: 'completed', result: { kind: 'answer_saved', answerSaved: true } });
    expect(resolve).not.toHaveBeenCalled();
    expect(readManagerEvents(directory)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ kind: 'answer', questionId: saved.id,
      answer: expect.objectContaining({ text: 'Use the approved service', answeredBy: 'human', source: 'tui' }) }) }));
    expect(errors).not.toHaveBeenCalled();
  } finally { await client.close(); await server.close(); }
});

it('observes the same pending question across human director human route changes without recreating the watcher', async () => {
  execFileSync('git', ['init', '-q', directory]);
  const questionId = randomUUID();
  const permissionId = randomUUID();
  const goal = { ...goalRecord(), creationOrigin: 'manager', questionRoute: 'human', questions: [
    { id: questionId, body: 'Which implementation?', kind: 'question', questionType: 'routine', recipient: 'human', status: 'pending' },
    { id: permissionId, body: 'May I access this resource?', kind: 'question', questionType: 'permission', recipient: 'human', status: 'pending' },
  ] };
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  const records = new Map<string, WatchRecord>();
  const accepted: EventInput[] = [];
  const stateChanges = new WatchObservations({
    read: async (key) => records.get(key), write: async (key, record) => { records.set(key, record); },
  }, { accept: async (event) => {
    accepted.push(event);
    return { kind: 'accepted', eventId: event.eventId, operationId: event.eventId, acceptedSequence: accepted.length };
  } }, () => Date.parse('2026-11-18T00:00:00.000Z'));
  const errors = vi.fn();
  const { source } = await watchSource(errors, stateChanges);
  const human: AcceptedEvent = { eventId: randomUUID(), requestId: randomUUID(), conversationId: conversationId({ kind: 'daemon' }),
    source: 'tui', occurredAt: '2026-11-18T00:00:00.000Z', operationId: randomUUID(), acceptedSequence: 1, lane: 'human',
    event: { kind: 'human_command', command: { kind: 'message', text: 'Change who answers this goal' }, speaker: { namespace: 'human', id: 'user' } } };
  await conversations!.ensure({ kind: 'daemon' });

  for (const questionRoute of ['human', 'director', 'human'] as const) {
    await changeDirectorGoalQuestionRoute(join(directory, 'global'), {
      managerId: conversationId({ kind: 'repository', repositoryDirectory: directory }), cwd: directory, goalId: goal.id,
    }, questionRoute, 'human', human, new AbortController().signal);
    await source.inquiries();
    expect(errors).not.toHaveBeenCalled();
    const event = accepted.at(-1)!.event;
    expect(event.kind).toBe('watch_observation');
    if (event.kind !== 'watch_observation' || event.observation.kind !== 'director_state_changed') throw new Error('Expected a director state change');
    expect(event.observation).toMatchObject({ goalId: goal.id, repositoryDirectory: directory });
    expect(JSON.parse(event.observation.state)).toMatchObject({ questionRoute });
    const snapshot = await conversations!.snapshot(human.conversationId, { toolHistory: false });
    const humanQuestionIds: string[] = [];
    try {
      for await (const item of snapshot.items) if (item.kind === 'inquiry') humanQuestionIds.push(item.inquiry.question.id);
      snapshot.complete();
    } finally { snapshot.cancel(); }
    expect(humanQuestionIds.sort()).toEqual((questionRoute === 'human' ? [questionId, permissionId] : [permissionId]).sort());
    expect((await new GoalStore(directory).get(goal.id)).creationOrigin).toBe('manager');
  }
  expect(accepted).toHaveLength(3);
  expect(new Set(accepted.map((event) => event.eventId)).size).toBe(3);
});

it('includes saved human goal inquiries in the initial director snapshot without an AI turn', async () => {
  const question = { id: randomUUID(), kind: 'question' as const, recipient: 'human' as const,
    status: 'pending' as const, body: 'Which account should I use?' };
  const goal = { ...goalRecord(), questions: [question] };
  await new GoalStore(directory).create(goal);
  const errors = vi.fn();
  await watchSource(errors);
  await conversations!.ensure({ kind: 'daemon' });

  const snapshot = await conversations!.snapshot(conversationId({ kind: 'daemon' }), { toolHistory: false });
  const inquiries = [];
  try {
    for await (const item of snapshot.items) if (item.kind === 'inquiry') inquiries.push(item);
    snapshot.complete();
  } finally { snapshot.cancel(); }

  expect(inquiries).toEqual([expect.objectContaining({ kind: 'inquiry', inquiry: expect.objectContaining({
    target: { repositoryDirectory: directory, goalId: goal.id },
    question: expect.objectContaining({ id: question.id, recipient: 'human', status: 'pending', body: question.body }),
  }) })]);
  expect(errors).not.toHaveBeenCalled();
});

it('reports unsupported standalone recipients before emitting a human inquiry or a display record', async () => {
  const notices: InquiryNotice[] = [];
  const errors = vi.fn();
  const { source } = await watchSource(errors, undefined, async notice => { notices.push(notice); });
  const path = join(directory, 'global', 'projects', projectKey(directory), 'inquiries');
  await mkdir(path, { recursive: true });
  const question = { id: randomUUID(), body: 'Unsupported standalone question', kind: 'question', questionType: 'routine',
    recipient: 'director', status: 'pending' };
  await writeFile(join(path, `${question.id}.json`), JSON.stringify(question));
  await source.inquiries();
  expect(errors).toHaveBeenCalledOnce();
  expect(notices).toEqual([]);
  const snapshot = await conversations!.snapshot(conversationId({ kind: 'repository', repositoryDirectory: directory }), { toolHistory: false });
  const items: SnapshotItem[] = [];
  try {
    await expect((async () => { for await (const item of snapshot.items) items.push(item); })()).rejects.toThrow();
  } finally { snapshot.cancel(); }
  expect(items.some(item => item.kind === 'inquiry')).toBe(false);
  expect(items.some(item => item.kind === 'display_event')).toBe(true);
});

it('retains readable director inquiries and reports an incomplete snapshot when another repository has corrupt goal data', async () => {
  const badGoal = join(directory, '.takt', 'goals', goalRecord().id);
  await mkdir(badGoal, { recursive: true });
  await writeFile(join(badGoal, 'goal.json'), '{');
  const good = join(directory, 'healthy');
  await mkdir(good);
  const question = { id: randomUUID(), body: 'Healthy question', recipient: 'human' as const, status: 'pending' as const };
  await new GoalStore(good).create({ ...goalRecord(), questions: [question] });
  const errors = vi.fn();
  await watchSource(errors);
  await registerProject({ globalConfigDirectory: join(directory, 'global'), projectDirectory: good, command: 'manager', managerUsed: true });
  await conversations!.ensure({ kind: 'daemon' });
  const snapshot = await conversations!.snapshot(conversationId({ kind: 'daemon' }), { toolHistory: false });
  const items: SnapshotItem[] = [];
  try {
    await expect((async () => { for await (const item of snapshot.items) items.push(item); })()).rejects.toThrow();
  } finally { snapshot.cancel(); }
  expect(items).toContainEqual(expect.objectContaining({ kind: 'inquiry', inquiry: expect.objectContaining({
    question: expect.objectContaining({ id: question.id }), target: { repositoryDirectory: good, goalId: goalRecord().id },
  }) }));
  expect(items).toContainEqual(expect.objectContaining({ kind: 'display_event', event: expect.objectContaining({ message: expect.stringContaining(directory) }) }));
});

it('keeps remote work alive while observing process identity only for local tasks', async () => {
  const errors = vi.fn(); const { source, files } = await watchSource(errors);
  const assignment = RemoteAssignmentSchema.parse({ projectId: directory, taskName: 'remote', workerId: 'w1', workerName: 'w1',
    registrationGeneration: randomUUID(), executionId: randomUUID(), assignmentGeneration: 1, requestId: 'r1',
    originalSha: 'a'.repeat(40), origin: 'https://example.test/repo.git', branch: 'result', leaseExpiresAt: 60_000,
    lastAcknowledgedLogSequence: 0, controlSequence: 0, workLocation: null, retryReservation: false });
  const running = { name: 'local', status: 'running', goal_id: goalRecord().id, owner_pid: 123, owner_start_time: 'local-start',
    created_at: '2026-11-13T00:00:00Z', started_at: '2026-11-13T00:00:00Z', completed_at: null };
  await mkdir(join(directory, '.takt'), { recursive: true });
  const remote = { ...running, name: 'remote', owner_pid: null, owner_start_time: null, remote_assignment: assignment };
  const path = join(directory, '.takt/tasks.yaml');
  await writeFile(path, JSON.stringify({ tasks: [running, remote] }));
  expect(await source.runs()).toEqual([expect.objectContaining({ task: expect.objectContaining({ taskName: 'local' }),
    owner: { pid: 123, startTime: 'local-start' } })]);
  await writeFile(path, JSON.stringify({ tasks: [remote] }));
  expect(await source.runs()).toEqual([]);
  expect(await source.hasWork(files)).toBe(true);
  expect(errors).not.toHaveBeenCalled();
});

it('parses goal histories in a reusable worker and returns only observation data', async () => {
  const goal = { ...goalRecord(), createdAt: '2026-11-01T00:00:00Z', workLog: [...Array.from({ length: 200 }, () => ({
    id: randomUUID(), summary: 'history-content'.repeat(400), recordedAt: '2026-11-02T00:00:00Z',
  })), { id: randomUUID(), summary: 'patrol', kind: 'patrol', recordedAt: '2026-11-03T00:00:00Z' }] };
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  const text = JSON.stringify(goal);
  await writeFile(join(path, 'goal.json'), text);
  const parse = vi.spyOn(JSON, 'parse');
  const errors = vi.fn();
  for (const _attempt of [1, 2]) {
    const goals = [];
    for await (const value of readWatchGoals(directory, errors, reader)) goals.push(value);
    expect(goals).toMatchObject([{ id: goal.id, status: 'created', executionStatus: 'active' }]);
    expect(goals[0]).not.toHaveProperty('workLog');
  }
  expect(parse.mock.calls.some(([value]) => typeof value === 'string' && value.includes('history-content'))).toBe(false);
  expect(errors).not.toHaveBeenCalled();
});

it('keeps goals larger than 4 MiB eligible for patrol and daemon work', async () => {
  const goal = GoalSchema.parse({ ...goalRecord(), createdAt: '2026-11-01T00:00:00Z', workLog: Array.from({ length: 42 }, () => ({
    id: randomUUID(), summary: 'x'.repeat(100 * 1024), recordedAt: '2026-11-02T00:00:00Z',
  })) });
  const text = JSON.stringify(goal);
  expect(Buffer.byteLength(text)).toBeGreaterThan(4 * 1024 * 1024);
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'goal.json'), text);
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  expect(await source.patrolGoalIds(directory)).toEqual([goal.id]);
  expect(await source.hasWork(files)).toBe(true);
  const observed = await reader.read(directory, goal.id);
  expect(observed).not.toHaveProperty('workLog');
  expect(observed).not.toHaveProperty('objective');
  expect(errors).not.toHaveBeenCalled();
});

it('reports invalid goals and continues observing valid goals', async () => {
  const valid = goalRecord();
  const invalidId = randomUUID();
  for (const [id, text] of [[valid.id, JSON.stringify(valid)], [invalidId, '{invalid']]) {
    const path = join(directory, '.takt', 'goals', id!);
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'goal.json'), text!);
  }
  const errors = vi.fn();
  const ids = [];
  for await (const goal of readWatchGoals(directory, errors, reader)) ids.push(goal.id);
  expect(ids).toEqual([valid.id]);
  expect(errors).toHaveBeenCalledOnce();
  expect(await reader.read(directory, valid.id)).toMatchObject({ id: valid.id });
});

it.each(['the goal directory', 'goal.json'] as const)('skips a goal whose %s disappears after listing without reporting an error', async (target) => {
  const kept = goalRecord();
  const deleted = { ...goalRecord(), id: randomUUID() };
  for (const goal of [kept, deleted]) {
    const path = join(directory, '.takt', 'goals', goal.id);
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  }
  const read = reader.read.bind(reader);
  vi.spyOn(reader, 'read').mockImplementation(async (cwd, id) => {
    const path = join(directory, '.takt', 'goals', id);
    if (id === deleted.id) await rm(target === 'goal.json' ? join(path, 'goal.json') : path, { recursive: true });
    return read(cwd, id);
  });
  const errors = vi.fn();
  const ids = [];
  for await (const goal of readWatchGoals(directory, errors, reader)) ids.push(goal.id);
  expect(ids).toEqual([kept.id]);
  expect(errors).not.toHaveBeenCalled();
});

it.each(['invalid JSON', 'invalid schema'] as const)('keeps the daemon alive and reports a goal with %s', async (failure) => {
  const goal = GoalSchema.parse({ ...goalRecord(), executionStatus: 'aborted' });
  const inactivePath = join(directory, '.takt', 'goals', goal.id);
  const unreadablePath = join(directory, '.takt', 'goals', randomUUID());
  await mkdir(inactivePath, { recursive: true });
  await writeFile(join(inactivePath, 'goal.json'), JSON.stringify(goal));
  await mkdir(unreadablePath);
  await writeFile(join(unreadablePath, 'goal.json'), failure === 'invalid JSON' ? '{invalid' : '{}');
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  expect(await source.hasWork(files)).toBe(true);
  expect(errors).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledWith(expect.any(Error));
  await rm(unreadablePath, { recursive: true });
  expect(await source.hasWork(files)).toBe(false);
  expect(errors).toHaveBeenCalledOnce();
});

it('bounds pending worker requests and rejects reads after closing', async () => {
  const reads = Array.from({ length: 32 }, () => reader.read(directory, randomUUID()));
  await expect(reader.read(directory, randomUUID())).rejects.toThrow();
  const settled = Promise.allSettled(reads);
  await reader.close();
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
  await expect(reader.read(directory, randomUUID())).rejects.toThrow();
});

it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking later goal reads or shutdown', async () => {
  const goal = goalRecord(); const fifoId = randomUUID();
  for (const id of [goal.id, fifoId]) await mkdir(join(directory, '.takt', 'goals', id), { recursive: true });
  execFileSync('mkfifo', [join(directory, '.takt', 'goals', fifoId, 'goal.json')]);
  await writeFile(join(directory, '.takt', 'goals', goal.id, 'goal.json'), JSON.stringify(goal));
  await expect(reader.read(directory, fifoId)).rejects.toThrow();
  expect(await reader.read(directory, goal.id)).toMatchObject({ id: goal.id });
  await reader.close();
}, 10_000);

it.each(['.takt', 'goals', 'goal', 'goal.json'] as const)('rejects a symlink at %s for both goal listing and direct reading', async (part) => {
  const goal = goalRecord();
  const foreign = join(directory, 'foreign');
  const repository = join(directory, 'registered');
  await mkdir(join(foreign, '.takt', 'goals', goal.id), { recursive: true });
  await writeFile(join(foreign, '.takt', 'goals', goal.id, 'goal.json'), JSON.stringify(goal));
  const segments = ['.takt', 'goals', goal.id, 'goal.json'];
  const index = part === '.takt' ? 0 : part === 'goals' ? 1 : part === 'goal' ? 2 : 3;
  await mkdir(join(repository, ...segments.slice(0, index)), { recursive: true });
  await symlink(join(foreign, ...segments.slice(0, index + 1)), join(repository, ...segments.slice(0, index + 1)),
    part === 'goal.json' ? 'file' : 'junction');
  await expect(reader.read(repository, goal.id)).rejects.toThrow();
  const errors = vi.fn();
  const listed = async () => {
    const goals = [];
    for await (const observed of readWatchGoals(repository, errors, reader)) goals.push(observed);
    return goals;
  };
  if (index < 2) await expect(listed()).rejects.toThrow();
  else {
    expect(await listed()).toEqual([]);
    if (index === 3) expect(errors).toHaveBeenCalledOnce();
  }
});

it.each([true, false])('observes runnable awaiting-merge work only for merge_task=%s', async (mergeTask) => {
  const goal = GoalSchema.parse({ ...goalRecord(), status: 'awaiting_merge',
    completion: { goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified', instructions: [],
      changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false } } });
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true }); await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  await writeFile(join(directory, '.takt', 'tasks.yaml'), `tasks:\n  - name: merge-pr-123\n    status: pending\n    goal_id: ${goal.id}\n    merge_task: ${mergeTask}\n    created_at: 2026-11-06T00:00:00.000Z\n    started_at: null\n    completed_at: null\n`);
  const errors = vi.fn();
  const { source } = await watchSource(errors);
  const launches = await source.launches();
  expect(launches).toHaveLength(mergeTask ? 1 : 0);
  if (mergeTask) expect(launches[0]).toMatchObject({ repositoryDirectory: directory, runnablePending: true, autoRun: true });
  expect(errors).not.toHaveBeenCalled();
});

it.each([
  { concurrency: 0, waitingReason: undefined, runnable: false },
  { concurrency: 1, waitingReason: 'Waiting for an available builtin worker slot', runnable: false },
  { concurrency: 1, waitingReason: undefined, runnable: true },
])('does not classify capacity waiting as a stalled launch: %j', async ({ concurrency, waitingReason, runnable }) => {
  const goal = GoalSchema.parse(goalRecord());
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  await writeFile(join(directory, '.takt', 'tasks.yaml'), `tasks:\n  - name: queued\n    status: pending\n    goal_id: ${goal.id}\n    created_at: 2026-11-06T00:00:00.000Z\n    started_at: null\n    completed_at: null\n${waitingReason === undefined ? '' : `    waiting_reason: ${waitingReason}\n`}`);
  const errors = vi.fn();
  const { source } = await watchSource(errors);
  await writeFile(join(directory, 'global', 'config.yaml'), `daemon:\n  builtin_worker:\n    concurrency: ${concurrency}\n`);
  expect(await source.launches()).toMatchObject([{ runnablePending: runnable, autoRun: true }]);
  expect(errors).not.toHaveBeenCalled();
});

it('patrols linked active and failed merge work until only human merge waits remain', async () => {
  const base = goalRecord();
  const completion = { goalBranch: base.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified', instructions: [],
    changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [], truncated: false, totalsTruncated: false } };
  const statuses = ['pending', 'running', 'completed', 'pending', 'pending', 'pending', 'pending', 'failed', 'exceeded', 'pr_failed'] as const;
  const goals: Goal[] = statuses.map(() => ({ ...base, id: randomUUID(), status: 'awaiting_merge', completion }));
  goals[5]!.executionStatus = 'paused';
  goals[6]!.executionStatus = 'aborted';
  for (const goal of goals) {
    const path = join(directory, '.takt', 'goals', goal.id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  }
  const tasks = goals.map((goal, index) => ({ name: `task-${index}`, goal_id: goal.id, merge_task: index !== 3,
    status: statuses[index],
    created_at: '2026-11-06T00:00:00.000Z', started_at: null, completed_at: null }));
  tasks[4]!.goal_id = randomUUID();
  const tasksPath = join(directory, '.takt', 'tasks.yaml');
  await writeFile(tasksPath, JSON.stringify({ tasks }));
  const errors = vi.fn();
  const { source } = await watchSource(errors);
  expect([...(await source.patrolGoalIds(directory))].sort()).toEqual([0, 1, 7, 8, 9].map((index) => goals[index]!.id).sort());
  await writeFile(tasksPath, JSON.stringify({ tasks: tasks.map((task) => ({ ...task, status: 'completed' })) }));
  expect(await source.patrolGoalIds(directory)).toEqual([]);
  expect(errors).not.toHaveBeenCalled();
});

it('reports corrupt tasks and patrols ordinary active goals while excluding awaiting-merge goals', async () => {
  const active = goalRecord();
  const waiting: Goal = { ...active, id: randomUUID(), status: 'awaiting_merge', completion: {
    goalBranch: active.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'verified', instructions: [],
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
  } };
  for (const goal of [active, waiting]) {
    const path = join(directory, '.takt', 'goals', goal.id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  }
  await writeFile(join(directory, '.takt', 'tasks.yaml'), 'tasks: [');
  const errors = vi.fn();
  const { source } = await watchSource(errors);

  expect(await source.patrolGoalIds(directory)).toEqual([active.id]);
  expect(errors).toHaveBeenCalledOnce();
  expect(errors).toHaveBeenCalledWith(expect.any(Error));
});

async function savePendingEpic() {
  const globalConfigDirectory = join(directory, 'global');
  const workspace = await createWorkspace({ globalConfigDirectory, name: '結合確認待ち', repositoryDirectories: [] });
  await writeFile(join(globalConfigDirectory, 'workspaces', workspace.id, 'workspace.json'), JSON.stringify({
    ...workspace, repositoryDirectories: [directory],
  }));
  const goal = completedEpicGoal('b'.repeat(40), 'a'.repeat(40));
  const path = join(directory, '.takt', 'goals', goal.id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  const member = { repositoryDirectory: directory, goalId: goal.id };
  const epic = { ...epicRecord(), workspaceId: workspace.id, members: [member], targets: [{ ...member, targetSha: goal.completion!.targetSha! }] };
  await new EpicStore(globalConfigDirectory, workspace.id).create(epic);
  return { globalConfigDirectory, workspaceId: workspace.id, epicId: epic.id,
    path: join(globalConfigDirectory, 'workspaces', workspace.id, 'epics', epic.id, 'epic.json') };
}

it('keeps a pending Epic active after all goals complete and becomes idle only after the Epic is aborted', async () => {
  const context = await savePendingEpic();
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  expect(await source.patrolGoalIds(directory)).toEqual([]);
  expect(await source.hasWork(files)).toBe(true);
  expect((await source.patrols()).filter((target) => target.workspaceId === context.workspaceId))
    .toMatchObject([{ epicIds: [context.epicId] }]);
  await abortEpic({ globalConfigDirectory: context.globalConfigDirectory, workspaceId: context.workspaceId,
    epicId: context.epicId, reason: '確認を中止する' });
  expect(await source.hasWork(files)).toBe(false);
  expect((await source.patrols()).filter((target) => target.workspaceId === context.workspaceId)).toEqual([]);
  expect(await getEpic({ globalConfigDirectory: context.globalConfigDirectory, workspaceId: context.workspaceId, epicId: context.epicId }))
    .toMatchObject({ status: 'aborted', members: [{ repositoryDirectory: directory, goalId: goalRecord().id }] });
  expect(errors).not.toHaveBeenCalled();
});

it('keeps the same pending Epic in daemon work and patrols until explicit completion and retains its evidence afterwards', async () => {
  execFileSync('git', ['init', '--quiet', directory]);
  const saved = await savePendingEpic();
  const context = { globalConfigDirectory: saved.globalConfigDirectory, workspaceId: saved.workspaceId, epicId: saved.epicId };
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  const patrols = async () => (await source.patrols()).filter((target) => target.workspaceId === context.workspaceId);
  expect(await source.patrolGoalIds(directory)).toEqual([]);
  expect(await source.hasWork(files)).toBe(true);
  expect(await patrols()).toMatchObject([{ epicIds: [context.epicId] }]);

  const run = await startEpicVerification(context);
  await recordEpicVerificationResult({ ...context, result: verificationResultFor(run) });
  expect(await source.hasWork(files)).toBe(true);
  expect(await patrols()).toMatchObject([{ epicIds: [context.epicId] }]);

  await completeEpic(context);
  expect(await source.hasWork(files)).toBe(false);
  expect(await patrols()).toEqual([]);
  expect(await getEpic(context)).toMatchObject({ status: 'completed', currentEvidence: { id: run.id },
    members: [{ repositoryDirectory: directory, goalId: goalRecord().id }], verificationRuns: [{ id: run.id, status: 'succeeded' }] });
  expect(errors).not.toHaveBeenCalled();
});

it('keeps all active Epic IDs and reports later failures without returning a partial workspace patrol', async () => {
  const context = await savePendingEpic();
  const later = { ...epicRecord(), id: '950e8400-e29b-41d4-a716-446655440000', workspaceId: context.workspaceId };
  await new EpicStore(context.globalConfigDirectory, context.workspaceId).create(later);
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  const workspacePatrols = async () => (await source.patrols()).filter((target) => target.workspaceId === context.workspaceId);
  expect(await workspacePatrols()).toMatchObject([{ epicIds: [context.epicId, later.id] }]);
  await abortEpic({ globalConfigDirectory: context.globalConfigDirectory, workspaceId: context.workspaceId, epicId: later.id, reason: 'Stop later Epic' });
  expect(await workspacePatrols()).toMatchObject([{ epicIds: [context.epicId] }]);
  expect(await source.hasWork(files)).toBe(true);
  errors.mockClear();
  await writeFile(join(context.globalConfigDirectory, 'workspaces', context.workspaceId, 'epics', later.id, 'epic.json'), '{');
  expect(await source.hasWork(files)).toBe(true);
  expect(errors).toHaveBeenCalledWith(expect.any(Error));
  expect(await workspacePatrols()).toEqual([]);
  expect(errors).toHaveBeenCalledTimes(2);
});

it.each(['missing', 'invalid JSON', 'wrong workspace'] as const)('keeps the daemon active and reports an Epic with %s', async (failure) => {
  const context = await savePendingEpic();
  if (failure === 'missing') await rm(context.path);
  else if (failure === 'invalid JSON') await writeFile(context.path, '{broken');
  else await writeFile(context.path, JSON.stringify({ ...epicRecord(), workspaceId: randomUUID() }));
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);
  expect(await source.patrolGoalIds(directory)).toEqual([]);
  expect(await source.hasWork(files)).toBe(true);
  expect(errors).toHaveBeenCalledWith(expect.any(Error));
});

it('republishes only goal answers left pending for publication and preserves the respondent while clearing their marks', async () => {
  const savedAnswer = { text: 'CSV', source: 'mcp' as const, answeredBy: 'human' as const, answeredAt: '2026-11-01T00:00:00.000Z' };
  const pendingId = randomUUID();
  const target = GoalSchema.parse({ ...goalRecord(), questions: [
    { id: pendingId, body: 'Which format?', recipient: 'human', status: 'answered', answer: savedAnswer, answerPublicationPending: true },
    { id: randomUUID(), body: 'Which branch?', recipient: 'human', status: 'answered', answer: savedAnswer },
  ] });
  const other = GoalSchema.parse({ ...goalRecord(), id: randomUUID(), questions: [
    { id: randomUUID(), body: 'Which owner?', recipient: 'human', status: 'answered', answer: savedAnswer },
  ] });
  for (const goal of [target, other]) {
    const path = join(directory, '.takt', 'goals', goal.id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'goal.json'), JSON.stringify(goal));
  }
  const otherPath = join(directory, '.takt', 'goals', other.id, 'goal.json');
  const otherBefore = await readFile(otherPath, 'utf8');
  const errors = vi.fn();
  const { source, files } = await watchSource(errors);

  await source.inquiries();
  await source.inquiries();

  expect(errors).not.toHaveBeenCalled();
  const inboxNames = await readdir(await files.inboxDirectory(directory));
  expect(await Promise.all(inboxNames.map((name) => files.readInboxEvent(directory, name)))).toEqual([
    expect.objectContaining({ kind: 'answer', goalId: target.id, questionId: pendingId, answer: savedAnswer }),
  ]);
  const stored = await new GoalStore(directory).get(target.id);
  expect(stored.questions!.map((question) => question.answerPublicationPending)).toEqual([undefined, undefined]);
  expect(stored.questions!.map((question) => question.answer)).toEqual([savedAnswer, savedAnswer]);
  expect(await readFile(otherPath, 'utf8')).toBe(otherBefore);
});
