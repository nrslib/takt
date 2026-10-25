import { mkdirSync, writeFileSync } from 'node:fs';
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
    await vi.waitFor(() => expect(doubles.ipc).toHaveBeenCalledOnce());
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
    });
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
