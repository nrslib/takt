import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runDaemon } from '../features/daemon/runDaemon.js';
import type { createConversationIpcServer } from '../features/daemon/conversationIpcServer.js';
import type { ManagerConversationPlan } from '../features/manager/conversationPlan.js';
import type { PortOutput } from '../features/manager/conversationPort.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { conversationId } from '../infra/conversations/identity.js';
import { ConversationStore } from '../infra/conversations/store.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { goalInput, goalRecord } from './helpers/goal-fixtures.js';
import { makeProvider } from './test-helpers.js';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../infra/config/global/workspaceRegistry.js';
import type { ConversationAssignment } from '../infra/conversations/schema.js';
import type { ConversationInput } from '../features/manager/conversationPort.js';
import { conversationRecord } from './helpers/conversation-fixtures.js';
import { enqueueDueGoalPatrols } from '../features/manager/patrol.js';
import { DirectorMessageResultStore } from '../infra/conversations/directorMessageResults.js';

const doubles = vi.hoisted(() => ({
  ipc: vi.fn<typeof createConversationIpcServer>(),
  plan: vi.fn<() => ManagerConversationPlan>(),
  registerOwner: vi.fn(), removeOwner: vi.fn(),
}));
vi.mock('../features/daemon/conversationIpcServer.js', () => ({ createConversationIpcServer: doubles.ipc }));
vi.mock('../features/manager/conversationPlan.js', () => ({ createManagerConversationPlan: doubles.plan }));
vi.mock('../features/manager/managerMcp.js', async (original) => ({
  ...await original<typeof import('../features/manager/managerMcp.js')>(),
  connectManagerMcp: async () => ({ servers: {}, dispose: async () => {} }),
}));
vi.mock('../infra/daemon/owner.js', () => ({
  registerDaemonOwner: doubles.registerOwner, removeDaemonOwner: doubles.removeOwner,
}));
vi.mock('../infra/task/process.js', () => ({ getSelfProcessIdentity: () => ({ startTime: 'conversation-events-test' }) }));
vi.mock('../shared/utils/cli-invocation.js', () => ({ resolveCliInvocation: () => ({ cliPath: '/test/cli.js' }) }));
vi.mock('../shared/utils/debug.js', () => ({
  initDebugLogger: vi.fn(), createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({
  ...await original<typeof import('../infra/task/repositoryDirectory.js')>(),
  resolveGitRepositoryDirectory: async (path: string) => path,
}));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { listTaskStateItems() { return []; } } }));
vi.mock('../features/tasks/execute/claimTasks.js', () => ({ failInterruptedTasksWithGoalEvents: () => 0 }));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('[SCN-CONTEXT-P1] preserves the human proposal, revision and session while the daemon records a goal event turn', async () => {
  vi.clearAllMocks();
  // Date だけを固定し、登録イベントの検証中に巡回が期日を迎えないようにする。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-25T00:00:00Z');
  const directory = getGlobalConfigDir();
  const repository = join(directory, 'repository');
  mkdirSync(join(repository, '.takt'), { recursive: true });
  writeFileSync(join(repository, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
  await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
  const goals = new GoalStore(repository);
  const goal = await goals.create({ ...goalRecord(), createdAt: new Date().toISOString() });
  const summary = { ...goalInput(), objective: '人との会話で検討中の要約' };
  const humanSessionId = 'human-conversation-session';
  const eventMessage = '登録イベントを処理し、既存ゴールの作業を確認しました';
  const call = vi.fn<ProviderAgent['call']>();
  call.mockResolvedValueOnce({ persona: 'manager', status: 'done', content: '', timestamp: new Date(),
    structuredOutput: { message: '要約を確認してください', summary }, sessionId: humanSessionId });
  call.mockResolvedValueOnce({ persona: 'manager', status: 'done', content: '', timestamp: new Date(),
    structuredOutput: { message: eventMessage, summary: null }, sessionId: 'event-only-session' });
  doubles.plan.mockReturnValue({
    ctx: { providerType: 'mock', provider: makeProvider({ setup: () => ({ call }) }), model: 'test-model', lang: 'ja' },
    strategy: { systemPrompt: 'conversation and event fixture' },
  });
  doubles.registerOwner.mockReturnValue(true);
  doubles.ipc.mockResolvedValue({ endpoint: '/test/conversation.sock', initializingCount: 0,
    stopAccepting: vi.fn(), close: vi.fn(async () => {}) });

  const assignment = { kind: 'repository' as const, repositoryDirectory: repository };
  const id = conversationId(assignment);
  const actor = { namespace: 'local', id: 'operator' };
  const store = new ConversationStore(directory);
  const outputs: PortOutput[] = [];
  const beforeListeners = process.rawListeners('SIGTERM');
  const daemon = runDaemon();
  try {
    await vi.waitFor(() => expect(doubles.ipc).toHaveBeenCalledOnce(), { timeout: 5000 });
    const service = doubles.ipc.mock.calls[0]![2];
    const opened = await service.open({ conversationId: id, assignment, speaker: actor,
      binding: { port: 'tui', key: id, counterpart: actor } }, {
      deliver: async (_id, output) => { outputs.push(output); return { kind: 'delivered' }; },
    });
    await opened.read.items[Symbol.asyncIterator]().return?.();
    const submission = await service.submit({ attachmentId: opened.attachmentId, requestId: 'human-message',
      speaker: actor, command: { kind: 'message', text: '新しいゴールの要約を作成してください' } });
    expect(submission.kind).toBe('accepted');
    if (submission.kind !== 'accepted') throw new Error('Human turn was not accepted');
    await vi.waitFor(() => {
      expect(outputs).toContainEqual({ kind: 'result', operationId: submission.operationId,
        result: { kind: 'reply', message: '要約を確認してください' } });
      expect(store.read(id, assignment)?.running).toBeNull();
    }, { timeout: 5000 });
    const before = store.read(id, assignment)!;
    expect(before.pending).toEqual({ summary, revision: before.revision, repositoryDirectory: repository });
    expect(before.revision).toBeGreaterThan(0);
    expect(before.sessionId).toBe(humanSessionId);
    expect(call).toHaveBeenCalledOnce();
    const workLogBefore = (await goals.get(goal.id)).workLog;

    saveManagerEvent(repository, { kind: 'registered', goalId: goal.id });

    await vi.waitFor(async () => {
      expect((await goals.get(goal.id)).workLog).toHaveLength(workLogBefore.length + 1);
      expect(readManagerEvents(repository)).toEqual([]);
    }, { timeout: 5000 });
    const workLogAfter = (await goals.get(goal.id)).workLog;
    expect(workLogAfter.slice(0, workLogBefore.length)).toEqual(workLogBefore);
    expect(workLogAfter.at(-1)).toMatchObject({ summary: eventMessage });
    const after = store.read(id, assignment)!;
    expect(after.pending?.summary).toEqual(before.pending!.summary);
    expect(after.pending?.revision).toBe(before.pending!.revision);
    expect(after.revision).toBe(before.revision);
    expect(after.sessionId).toBe(before.sessionId);
    expect(call).toHaveBeenCalledTimes(2);
    const [eventPrompt, eventOptions] = call.mock.calls[1]!;
    expect(JSON.parse(eventPrompt)).toMatchObject({ repositoryDirectory: repository,
      event: { kind: 'registered', goalId: goal.id }, goal: { id: goal.id } });
    expect(eventOptions.cwd).toBe(repository);
    expect(eventOptions.sessionId).toBeUndefined();
    expect(doubles.removeOwner).not.toHaveBeenCalled();
  } finally {
    const stop = process.rawListeners('SIGTERM').find((listener) => !beforeListeners.includes(listener));
    stop?.call(process, 'SIGTERM');
    await daemon;
  }
  expect(doubles.removeOwner).toHaveBeenCalledOnce();
  expect(process.rawListeners('SIGTERM')).toEqual(beforeListeners);
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function queueFixture(repositoryCount = 1) {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-30T00:00:00Z');
  const directory = getGlobalConfigDir();
  const repositories: string[] = [];
  for (let index = 0; index < repositoryCount; index++) {
    const repository = join(directory, `queue-repository-${index}`);
    mkdirSync(join(repository, '.takt'), { recursive: true });
    writeFileSync(join(repository, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n  patrol_interval: 900\n');
    await registerProject({ globalConfigDirectory: directory, projectDirectory: repository, command: 'manager', managerUsed: true });
    repositories.push(repository);
  }
  let assignment: ConversationAssignment = { kind: 'repository', repositoryDirectory: repositories[0]! };
  if (repositories.length > 1) {
    const workspace = await createWorkspace({ globalConfigDirectory: directory, name: 'shared manager', repositoryDirectories: repositories });
    assignment = { kind: 'workspace', workspaceId: workspace.id };
  }
  const id = conversationId(assignment);
  const record = { ...conversationRecord(repositories[0]!), id, assignment, model: 'test-model' };
  const store = new ConversationStore(directory); store.write(record);
  const turns: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const hook = vi.fn(async (_label: string, _signal: AbortSignal) => {});
  const call = vi.fn<ProviderAgent['call']>(async (prompt, options) => {
    const context = prompt.startsWith('{') ? JSON.parse(prompt) as { event: { kind: string; goalId: string } } : undefined;
    const label = context === undefined ? prompt.match(/\b(?:D1|D2|human-input)\b/)?.[0] : `${context.event.kind}:${context.event.goalId}`;
    if (label === undefined) throw new Error(`Unexpected manager fixture prompt: ${prompt}`);
    turns.push(label); active++; maximumActive = Math.max(maximumActive, active);
    try {
      await hook(label, options.abortSignal!);
      return { persona: 'manager', status: 'done', content: '', timestamp: new Date(),
        structuredOutput: { message: `reply:${label}`, summary: null }, sessionId: 'queue-session' };
    } finally { active--; }
  });
  doubles.plan.mockReturnValue({ ctx: { providerType: 'mock', provider: makeProvider({ setup: () => ({ call }) }), model: 'test-model', lang: 'en' },
    strategy: { systemPrompt: 'manager queue fixture' } });
  doubles.registerOwner.mockReturnValue(true);
  doubles.ipc.mockResolvedValue({ endpoint: '/test/conversation.sock', initializingCount: 0,
    stopAccepting: vi.fn(), close: vi.fn(async () => {}) });
  const outputs: PortOutput[] = [];
  const delivery = { deliver: async (_id: string, output: PortOutput) => { outputs.push(output); return { kind: 'delivered' as const }; } };
  const start = async () => {
    doubles.ipc.mockClear();
    const listeners = process.rawListeners('SIGTERM');
    const completion = runDaemon();
    await vi.waitFor(() => expect(doubles.ipc).toHaveBeenCalledOnce(), { timeout: 5000 });
    const service = doubles.ipc.mock.calls[0]![2];
    return { service, async stop() {
      const stop = process.rawListeners('SIGTERM').find((listener) => !listeners.includes(listener));
      stop?.call(process, 'SIGTERM');
      await completion;
    } };
  };
  const open = async (service: ConversationInput, director: boolean) => {
    const speaker = director ? { namespace: 'agent', id: 'director' } : record.counterpart;
    const opened = await service.open({ conversationId: id, assignment, speaker,
      binding: { port: director ? 'director' : 'tui', key: id, counterpart: record.counterpart } }, delivery);
    opened.read.cancel();
    return (text: string) => service.submit({ attachmentId: opened.attachmentId, requestId: randomUUID(), speaker,
      command: { kind: 'message', text } });
  };
  const createGoal = (index: number, repository = repositories[0]!) => new GoalStore(repository).create({ ...goalRecord(),
    id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, createdAt: new Date().toISOString() });
  return { directory, repositories, assignment, id, store, turns, hook, call, start, open, createGoal, outputs,
    get maximumActive() { return maximumActive; } };
}

it('runs saved director messages before task completion and patrol events after the current human turn', async () => {
  const fixture = await queueFixture();
  const repository = fixture.repositories[0]!;
  const goal = await fixture.createGoal(1);
  const held = deferred();
  fixture.hook.mockImplementation(async (label) => { if (label === 'human-input') await held.promise; });
  const daemon = await fixture.start();
  try {
    const tell = await fixture.open(daemon.service, true);
    const human = await fixture.open(daemon.service, false);
    await human('human-input');
    await vi.waitFor(() => expect(fixture.turns).toEqual(['human-input']), { timeout: 5000 });
    expect((await tell('D1')).kind).toBe('accepted');
    saveManagerEvent(repository, { kind: 'completion', goalId: goal.id, taskName: 'finished-task', runSlug: 'finished-run',
      result: { success: true, interrupted: false } });
    vi.setSystemTime('2026-10-30T00:15:00Z');
    await enqueueDueGoalPatrols(repository, 900);
    held.release();
    await vi.waitFor(() => expect(fixture.turns).toEqual(['human-input', 'D1', `completion:${goal.id}`, `patrol:${goal.id}`]), { timeout: 5000 });
    await vi.waitFor(() => expect(readManagerEvents(repository)).toEqual([]), { timeout: 5000 });
    expect(fixture.maximumActive).toBe(1);
    expect((await new GoalStore(repository).get(goal.id)).workLog.map((entry) => entry.summary))
      .toEqual([`reply:completion:${goal.id}`, `reply:patrol:${goal.id}`]);
  } finally { held.release(); await daemon.stop(); }
});

it('yields between events in one batch and resumes each remaining event exactly once', async () => {
  const fixture = await queueFixture();
  const repository = fixture.repositories[0]!;
  const goals = await Promise.all([1, 2, 3, 4, 5].map((index) => fixture.createGoal(index)));
  const second = deferred();
  fixture.hook.mockImplementation(async (label) => { if (label === `registered:${goals[1]!.id}`) await second.promise; });
  for (const goal of goals) saveManagerEvent(repository, { kind: 'registered', goalId: goal.id });
  const daemon = await fixture.start();
  try {
    const tell = await fixture.open(daemon.service, true);
    await vi.waitFor(() => expect(fixture.turns).toHaveLength(2), { timeout: 5000 });
    const accepted = await tell('D1'); expect(accepted.kind).toBe('accepted');
    expect(fixture.turns).toEqual(goals.slice(0, 2).map((goal) => `registered:${goal.id}`));
    expect(readManagerEvents(repository).map(({ event }) => event.goalId)).toEqual(goals.slice(1).map((goal) => goal.id));
    second.release();
    await vi.waitFor(() => expect(readManagerEvents(repository)).toEqual([]), { timeout: 30000 });
    expect(fixture.turns).toEqual([`registered:${goals[0]!.id}`, `registered:${goals[1]!.id}`, 'D1',
      ...goals.slice(2).map((goal) => `registered:${goal.id}`)]);
    for (const goal of goals) expect((await new GoalStore(repository).get(goal.id)).workLog).toHaveLength(1);
    expect(fixture.maximumActive).toBe(1);
  } finally { second.release(); await daemon.stop(); }
});

it('shares one workspace execution slot across both repositories and conversation turns', async () => {
  const fixture = await queueFixture(2);
  const [firstRepository, secondRepository] = fixture.repositories as [string, string];
  const first = await fixture.createGoal(1, firstRepository);
  const second = await fixture.createGoal(2, secondRepository);
  const held = deferred();
  const independentRepository = join(fixture.directory, 'independent-repository');
  mkdirSync(join(independentRepository, '.takt'), { recursive: true });
  writeFileSync(join(independentRepository, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n  patrol_interval: 900\n');
  await registerProject({ globalConfigDirectory: fixture.directory, projectDirectory: independentRepository, command: 'manager', managerUsed: true });
  const independent = await fixture.createGoal(3, independentRepository);
  const independentLabel = `registered:${independent.id}`;
  let activeWorkspaceTurns = 0;
  let maximumWorkspaceTurns = 0;
  let firstSignal: AbortSignal | undefined;
  fixture.hook.mockImplementation(async (label, signal) => {
    if (label === independentLabel) return;
    activeWorkspaceTurns++; maximumWorkspaceTurns = Math.max(maximumWorkspaceTurns, activeWorkspaceTurns);
    try {
      if (label === `registered:${first.id}`) { firstSignal = signal; await held.promise; }
    } finally { activeWorkspaceTurns--; }
  });
  saveManagerEvent(firstRepository, { kind: 'registered', goalId: first.id });
  const daemon = await fixture.start();
  try {
    const tell = await fixture.open(daemon.service, true);
    const human = await fixture.open(daemon.service, false);
    await vi.waitFor(() => expect(fixture.turns).toEqual([`registered:${first.id}`]), { timeout: 5000 });
    expect((await tell('D1')).kind).toBe('accepted');
    expect((await human('human-input')).kind).toBe('busy');
    saveManagerEvent(secondRepository, { kind: 'registered', goalId: second.id });
    saveManagerEvent(independentRepository, { kind: 'registered', goalId: independent.id });
    // 別managerの完了を待ち、daemonが後続イベントを調べた後も排他が保たれることを観測する。
    await vi.waitFor(async () => expect((await new GoalStore(independentRepository).get(independent.id)).workLog).toHaveLength(1), { timeout: 5000 });
    expect(readManagerEvents(secondRepository)).toHaveLength(1);
    expect(fixture.turns.filter((label) => label !== independentLabel)).toEqual([`registered:${first.id}`]);
    expect(firstSignal?.aborted).toBe(false);
    expect(maximumWorkspaceTurns).toBe(1);
    held.release();
    await vi.waitFor(() => expect(fixture.turns.filter((label) => label !== independentLabel))
      .toEqual([`registered:${first.id}`, 'D1', `registered:${second.id}`]), { timeout: 5000 });
    await vi.waitFor(() => expect(readManagerEvents(secondRepository)).toEqual([]), { timeout: 5000 });
    expect(maximumWorkspaceTurns).toBe(1);
  } finally { held.release(); await daemon.stop(); }
});

it('keeps the patrol deadline and completion based interval when director messages arrive before and during patrol', async () => {
  const fixture = await queueFixture();
  const repository = fixture.repositories[0]!;
  const goal = await fixture.createGoal(1);
  const goals = new GoalStore(repository);
  await goals.update(goal.id, (value) => ({ ...value, lastPatrolCompletedAt: '2026-10-30T00:00:00.000Z' }));
  const before = deferred(); const patrol = deferred();
  fixture.hook.mockImplementation(async (label) => {
    if (label === 'D1') await before.promise;
    if (label === `patrol:${goal.id}`) await patrol.promise;
  });
  const daemon = await fixture.start();
  const setClock = (time: string | number) => {
    vi.setSystemTime(time);
    vi.spyOn(Date, 'now').mockReturnValue(typeof time === 'number' ? time : Date.parse(time));
  };
  try {
    const tell = await fixture.open(daemon.service, true);
    setClock('2026-10-30T00:14:59.999Z');
    expect((await tell('D1')).kind).toBe('accepted');
    await vi.waitFor(() => expect(fixture.turns).toEqual(['D1']), { timeout: 5000 });
    await enqueueDueGoalPatrols(repository, 900);
    expect(readManagerEvents(repository)).toEqual([]);
    expect((await goals.get(goal.id)).lastPatrolCompletedAt).toBe('2026-10-30T00:00:00.000Z');
    setClock('2026-10-30T00:15:00.000Z');
    await enqueueDueGoalPatrols(repository, 900);
    expect(readManagerEvents(repository)).toHaveLength(1);
    before.release();
    await vi.waitFor(() => expect(fixture.turns).toEqual(['D1', `patrol:${goal.id}`]), { timeout: 5000 });
    const queued = await tell('D2');
    expect(queued.kind).toBe('accepted');
    if (queued.kind !== 'accepted') throw new Error('Director message must be accepted during patrol');
    expect(fixture.store.read(fixture.id, fixture.assignment)?.directorMessages).toEqual([
      { operationId: queued.operationId, text: 'D2', speaker: { namespace: 'agent', id: 'director' },
        directorConversationId: conversationId({ kind: 'daemon' }) },
    ]);
    await enqueueDueGoalPatrols(repository, 900);
    expect(readManagerEvents(repository)).toHaveLength(1);
    expect(fixture.turns).toHaveLength(2);
    setClock('2026-10-30T00:15:10.000Z');
    patrol.release();
    await vi.waitFor(() => expect(fixture.turns).toEqual(['D1', `patrol:${goal.id}`, 'D2']), { timeout: 5000 });
    await vi.waitFor(() => expect(readManagerEvents(repository)).toEqual([]), { timeout: 5000 });
    const completed = Date.parse((await goals.get(goal.id)).lastPatrolCompletedAt!);
    expect(completed).toBeGreaterThanOrEqual(Date.parse('2026-10-30T00:15:10.000Z'));
    setClock(completed + 900_000 - 1);
    await enqueueDueGoalPatrols(repository, 900); expect(readManagerEvents(repository)).toEqual([]);
    setClock(completed + 900_000);
    await enqueueDueGoalPatrols(repository, 900); await enqueueDueGoalPatrols(repository, 900);
    expect(readManagerEvents(repository)).toHaveLength(1);
    await vi.waitFor(() => expect(fixture.turns.filter((label) => label === `patrol:${goal.id}`)).toHaveLength(2), { timeout: 5000 });
  } finally { before.release(); patrol.release(); await daemon.stop(); }
});

it.each([false, true])('restores queued messages without any client and never replays a started director message (started=%s)', async (started) => {
  const fixture = await queueFixture();
  const held = deferred();
  fixture.hook.mockImplementation(async (label) => {
    if (label === (started ? 'D1' : 'human-input')) await held.promise;
  });
  const first = await fixture.start();
  let saved: ReturnType<ConversationStore['read']>;
  let persisted: Map<string, string> = new Map();
  let startedId: string | undefined;
  try {
    const tell = await fixture.open(first.service, true);
    const human = await fixture.open(first.service, false);
    const current = started ? await tell('D1') : await human('human-input');
    expect(current.kind).toBe('accepted');
    if (current.kind === 'accepted') startedId = current.operationId;
    await vi.waitFor(() => expect(fixture.turns).toHaveLength(1), { timeout: 5000 });
    expect((await tell('D2')).kind).toBe('accepted');
    saved = fixture.store.read(fixture.id, fixture.assignment);
    expect(JSON.stringify(saved)).toContain('D2');
    persisted = new Map(readdirSync(fixture.directory, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.json'))
      .map((name) => [name, readFileSync(join(fixture.directory, name), 'utf8')]));
  } finally { held.release(); await first.stop(); }
  if (saved === undefined) throw new Error('Crash snapshot must exist');
  // 正常停止が作る結果も除き、停止直前の永続状態から再起動する。
  for (const name of readdirSync(fixture.directory, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.json'))) {
    if (!persisted.has(name)) rmSync(join(fixture.directory, name));
  }
  for (const [name, content] of persisted) writeFileSync(join(fixture.directory, name), content);
  fixture.turns.length = 0;
  fixture.hook.mockReset();
  const restored = deferred();
  fixture.hook.mockImplementation(async (label) => { if (label === 'D2') await restored.promise; });
  const second = await fixture.start();
  try {
    await vi.waitFor(() => expect(fixture.turns).toEqual(['D2']), { timeout: 5000 });
    expect(doubles.removeOwner).toHaveBeenCalledTimes(1);
    expect(fixture.store.read(fixture.id, fixture.assignment)?.running).not.toBeNull();
    restored.release();
    await vi.waitFor(() => expect(fixture.store.read(fixture.id, fixture.assignment)?.running).toBeNull(), { timeout: 5000 });
    expect(fixture.turns).toEqual(['D2']);
    if (started) {
      const speaker = { namespace: 'local', id: 'operator' };
      const opened = await second.service.open({ conversationId: fixture.id, assignment: fixture.assignment, speaker,
        binding: { port: 'tui', key: fixture.id, counterpart: speaker } }, {
        deliver: async () => ({ kind: 'delivered' }),
      });
      const messages: string[] = [];
      for await (const item of opened.read.items) if (item.kind === 'display_event') messages.push(item.event.message);
      opened.read.complete();
      expect(messages.some((message) => /interrupt|中断/i.test(message))).toBe(true);
      expect(new DirectorMessageResultStore(fixture.directory).read(startedId!)).toEqual({
        operationId: startedId, conversationId: fixture.id, directorConversationId: conversationId({ kind: 'daemon' }),
        result: { kind: 'error', code: 'interrupted', message: expect.stringContaining(startedId!) },
      });
      const directorId = conversationId({ kind: 'daemon' });
      const director = await second.service.open({ conversationId: directorId, assignment: { kind: 'daemon' }, speaker,
        binding: { port: 'tui', key: directorId, counterpart: speaker }, agentOverrides: { provider: 'mock' } }, {
        deliver: async () => ({ kind: 'delivered' }),
      });
      const notifications: string[] = [];
      for await (const item of director.read.items) if (item.kind === 'display_event') notifications.push(item.event.message);
      director.read.complete();
      const interrupted = notifications.filter((message) => message.includes(startedId!));
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatch(/interrupt|中断/i);
      expect(interrupted[0]).toContain(fixture.id);
    }
  } finally { restored.release(); await second.stop(); }
});

it.each(['result', 'running'] as const)('recovers a failed director %s save without a snapshot or a repeated provider call', async (failure) => {
  const fixture = await queueFixture();
  const held = deferred();
  fixture.hook.mockImplementation(async (label) => { if (label === 'D1') await held.promise; });
  const daemon = await fixture.start();
  let failing: ReturnType<typeof vi.spyOn> | undefined;
  let fail = true;
  let failedWrites = 0;
  try {
    const tell = await fixture.open(daemon.service, true);
    const first = await tell('D1');
    expect(first.kind).toBe('accepted');
    if (first.kind !== 'accepted') throw new Error('Director message must be accepted');
    await vi.waitFor(() => expect(fixture.turns).toEqual(['D1']), { timeout: 5000 });
    const second = await tell('D2'); expect(second.kind).toBe('accepted');
    if (failure === 'running') {
      const write = ConversationStore.prototype.write;
      failing = vi.spyOn(ConversationStore.prototype, 'write').mockImplementation(function (this: ConversationStore, value) {
        if (fail && value.id === fixture.id && value.running === null) { failedWrites++; throw new Error('terminal record unavailable'); }
        write.call(this, value);
      });
    } else {
      const write = DirectorMessageResultStore.prototype.write;
      failing = vi.spyOn(DirectorMessageResultStore.prototype, 'write').mockImplementation(function (this: DirectorMessageResultStore, value) {
        if (fail && value.operationId === first.operationId) { failedWrites++; throw new Error('result unavailable'); }
        write.call(this, value);
      });
    }
    held.release();
    const results = new DirectorMessageResultStore(fixture.directory);
    await vi.waitFor(() => expect(failedWrites).toBeGreaterThan(0), { timeout: 5000 });
    if (failure === 'result') expect(results.read(first.operationId)).toBeUndefined();
    else expect(results.read(first.operationId)?.result).toEqual({ kind: 'reply', message: 'reply:D1' });
    expect(fixture.outputs.some((output) => output.kind === 'result' && output.operationId === first.operationId)).toBe(false);
    expect(fixture.store.read(fixture.id, fixture.assignment)?.running?.operationId).toBe(first.operationId);
    expect(fixture.turns).toEqual(['D1']);
    fail = false;
    await vi.waitFor(() => expect(fixture.turns).toEqual(['D1', 'D2']), { timeout: 5000 });
    await vi.waitFor(() => expect(fixture.store.read(fixture.id, fixture.assignment)?.running).toBeNull(), { timeout: 5000 });
    expect(results.read(first.operationId)?.result).toEqual({ kind: 'reply', message: 'reply:D1' });
    expect(fixture.maximumActive).toBe(1);
    expect(fixture.store.read(fixture.id, fixture.assignment)?.revision).toBe(4);
  } finally { fail = false; held.release(); failing?.mockRestore(); await daemon.stop(); }
});
