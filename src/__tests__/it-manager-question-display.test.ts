import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagerView } from '../features/manager/ManagerView.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { resolveManagerConfig } from '../infra/config/managerConfig.js';
import { invalidateResolvedConfigCache } from '../infra/config/resolveConfigValue.js';
import { appendGoalNotification, formatGoalQuestionNotification } from '../infra/goals/notifications.js';
import { addGoalQuestion, withdrawGoalQuestion } from '../infra/goals/questions.js';
import { GoalStore } from '../infra/goals/store.js';
import { MockProvider } from '../infra/providers/mock.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { processGoalCompletions } from '../features/manager/completionTurn.js';
import { recordGoalCompletion } from '../infra/goals/reconcile.js';
import * as managerPlans from '../features/manager/conversationPlan.js';
import * as managerMcp from '../features/manager/managerMcp.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { EventEmitter } from 'node:events';
import * as workflowCore from '../core/workflow/index.js';
import { executeTaskAndCompleteWithDetails, executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import type { WorkflowState } from '../core/models/index.js';
import { parse as parseYaml } from 'yaml';
import { loadTaskHistory } from '../app/cli/taskHistory.js';
import { formatTaskHistorySummary } from '../features/interactive/interactive-summary.js';
import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';
import type { JsonTaskListItem } from '../infra/task/listSerializer.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((...args: Parameters<typeof actual.execFileSync>) => args[0] === 'git' ? 'a'.repeat(40) : actual.execFileSync(...args)),
  };
});

let cwd: string;
let app: ReturnType<typeof render> | undefined;
let session: ReturnType<typeof createManagerConversationSession> | undefined;

beforeEach(() => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  cwd = realpathSync(mkdtempSync(join(root, 'manager-question-display-')));
  mkdirSync(join(cwd, '.takt'));
  writeFileSync(join(cwd, '.takt', 'config.yaml'), [
    'provider: mock', 'manager:', '  auto_run: false', '  notifications:', '    question: false',
  ].join('\n'));
  invalidateGlobalConfigCache();
  invalidateResolvedConfigCache(cwd);
});

afterEach(async () => {
  app?.unmount();
  app = undefined;
  cleanup();
  try { await session?.close(); }
  finally {
    vi.restoreAllMocks();
    session = undefined;
    invalidateGlobalConfigCache();
    invalidateResolvedConfigCache(cwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function mountGoalControls(lang: 'ja' | 'en', goal: Goal) {
  const store = new GoalStore(cwd);
  await store.create(goal);
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({
    persona: 'manager', status: 'done', timestamp: new Date(),
    content: '', structuredOutput: { message: 'Conversation received', summary: null },
  });
  const provider = new MockProvider();
  vi.spyOn(provider, 'setup').mockReturnValue({ call });
  const callTool = vi.fn();
  session = createManagerConversationSession({
    cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool },
    plan: { ctx: { providerType: 'mock', model: undefined, lang, provider },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } },
  });
  app = render(createElement(ManagerView, { cwd, lang, session, initialDiagnostics: [], onExit: vi.fn() }));
  await vi.waitFor(() => expect(app!.lastFrame()!.replace(/\n/gu, '')).toContain(cwd));
  const send = async (text: string): Promise<void> => {
    app!.stdin.write(text);
    await vi.waitFor(() => expect(app!.lastFrame()).toContain(text.split('\n')[0]!));
    app!.stdin.write('\r');
  };
  return { store, call, callTool, send };
}

const irreversibleWarning = /取り消せ|元に戻せ|不可逆|cannot.*undo|irreversible/iu;

async function expectAbortConfirmation(goal: Goal): Promise<void> {
  await vi.waitFor(() => {
    const frame = app!.lastFrame()!.replace(/\s+/gu, ' ');
    expect(frame).toContain(goal.id);
    expect(frame).toContain(goal.objective);
    expect(frame).toMatch(irreversibleWarning);
  });
}

function confirmAbort(): void {
  app!.stdin.write('\x1b[A');
  app!.stdin.write('\r');
}

it.each([
  { lang: 'ja' as const, executionStatus: 'active' as const },
  { lang: 'en' as const, executionStatus: 'active' as const },
  { lang: 'ja' as const, executionStatus: 'paused' as const },
  { lang: 'en' as const, executionStatus: 'paused' as const },
])('aborts a $executionStatus goal only after human confirmation and refreshes the same $lang TUI', async ({ lang, executionStatus }) => {
  const saved: Goal = { ...goalRecord(), executionStatus, objective: 'Abort target',
    workUnits: [{ taskName: 'saved-work', purpose: 'Retain evidence' }],
  };
  const { store, call, callTool, send } = await mountGoalControls(lang, saved);
  if (executionStatus === 'paused') await vi.waitFor(() => expect(app!.lastFrame()).toContain(`/resume ${saved.id}`));
  await send(`/abort ${saved.id}`);
  await expectAbortConfirmation(saved);
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
  confirmAbort();
  await vi.waitFor(async () => expect((await store.get(saved.id)).executionStatus).toBe('aborted'));
  expect(await store.get(saved.id)).toEqual({ ...saved, executionStatus: 'aborted' });
  const expectAbortedGoal = (): void => {
    const rows = app!.lastFrame()!.split('\n');
    const index = rows.findIndex((row) => row.includes(saved.objective));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(rows.slice(Math.max(0, index - 2), index + 3).join('\n')).toMatch(lang === 'ja' ? /中止/u : /abort/iu);
    expect(rows.filter((row) => row.includes(`/resume ${saved.id}`))).toEqual([]);
  };
  await vi.waitFor(expectAbortedGoal);
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
  await send(`/resume ${saved.id}`);
  await vi.waitFor(() => expect(app!.lastFrame()).toMatch(/再開.*でき|cannot.*resum|中止|abort/iu));
  expect((await store.get(saved.id)).executionStatus).toBe('aborted');
  app!.unmount();
  app = render(createElement(ManagerView, { cwd, lang, session: session!, initialDiagnostics: [], onExit: vi.fn() }));
  await vi.waitFor(expectAbortedGoal);
});

it.each(['default', 'escape'] as const)('cancels abort with %s without changing saved state or calling the agent', async (choice) => {
  const saved = { ...goalRecord(), objective: 'Abort target' };
  const { store, call, callTool, send } = await mountGoalControls('ja', saved);
  await send(`/abort ${saved.id}`);
  await expectAbortConfirmation(saved);
  app!.stdin.write(choice === 'default' ? '\r' : '\x1b[27u');
  await vi.waitFor(() => expect(app!.lastFrame()!.replace(/\s+/gu, ' ')).not.toMatch(irreversibleWarning));
  expect(await store.get(saved.id)).toEqual(saved);
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
  await send('Continue conversation');
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  expect(await store.get(saved.id)).toEqual(saved);
});

it.each([
  `操作例: /abort ${goalId}`, `> /abort ${goalId}`, `/aborted ${goalId}`,
  `\`\`\`text\n/abort ${goalId}\n\`\`\``, `~~~text\n> /abort ${goalId}\n~~~`,
  `\`\`\`text\n> ~~~\n/abort ${goalId}\n~~~\n\`\`\``, `\`\`\`\n/abort ${goalId}`,
  `説明\n/abort ${goalId}`,
])('keeps abort examples as conversation text without opening confirmation: %s', async (text) => {
  const saved = goalRecord();
  const { store, call, callTool, send } = await mountGoalControls('ja', saved);
  await send(text);
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  expect(call.mock.calls[0]![0]).toBe(text);
  expect(await store.get(saved.id)).toEqual(saved);
  expect(app!.lastFrame()!.replace(/\s+/gu, ' ')).not.toMatch(irreversibleWarning);
  expect(callTool).not.toHaveBeenCalled();
});

it('invalidates only pending work belonging to the confirmed goal and preserves running and terminal records', async () => {
  const saved = { ...goalRecord(), objective: 'Abort target' };
  const { store, send } = await mountGoalControls('en', saved);
  const other = await store.create({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' });
  const runner = new TaskRunner(cwd);
  const running = runner.addTask('in-flight work', { goal_id: saved.id });
  expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([running.name]);
  const pending = runner.addTask('cancel this work', { goal_id: saved.id });
  const ordinary = runner.addTask('ordinary work');
  const unrelated = runner.addTask('other goal work', { goal_id: other.id });
  const completed = runner.addTask('completed work', { goal_id: saved.id });
  runner.completeTask({ task: completed, success: true, startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z', response: 'done', executionLog: [], prUrl: 'https://example.com/pull/7', branch: 'task/completed-work' });
  const failed = runner.addTask('failed work', { goal_id: saved.id });
  runner.failTask({ task: failed, success: false, startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z', response: 'Execution failed', executionLog: [] });
  const before = runner.listTaskStateItems();
  const beforeRecords = new TaskStore(cwd).read().tasks;
  await send(`/abort ${saved.id}`);
  await expectAbortConfirmation(saved);
  expect(runner.listTaskStateItems()).toEqual(before);
  confirmAbort();
  await vi.waitFor(() => expect(runner.listTaskStateItems().find(({ name }) => name === pending.name)).toMatchObject({ status: 'failed' }));
  const reader = new TaskRunner(cwd);
  const after = reader.listTaskStateItems();
  expect(after).toHaveLength(before.length);
  const invalidated = after.find(({ name }) => name === pending.name)!;
  expect(invalidated).toMatchObject({ goalId: saved.id, status: 'failed', failure: { error: expect.stringMatching(/goal.*abort|ゴール.*中止/iu), retryable: false } });
  expect(invalidated.startedAt).toBeUndefined();
  expect(invalidated.completedAt).toBeUndefined();
  const restored = new TaskStore(cwd).read().tasks;
  const expectedInvalidation = { ...beforeRecords.find(({ name }) => name === pending.name)!, status: 'failed', started_at: null, completed_at: null,
    failure: invalidated.failure };
  expect(restored).toContainEqual(expect.objectContaining(expectedInvalidation));
  expect(parseYaml(readFileSync(join(cwd, '.takt', 'tasks.yaml'), 'utf8'))).toMatchObject({
    tasks: expect.arrayContaining([expect.objectContaining(expectedInvalidation)]),
  });
  for (const task of [running, ordinary, unrelated, completed, failed]) {
    expect(after.find(({ name }) => name === task.name)).toEqual(before.find(({ name }) => name === task.name));
    expect(restored.find(({ name }) => name === task.name)).toEqual(beforeRecords.find(({ name }) => name === task.name));
  }
  for (const lang of ['ja', 'en'] as const) {
    const history = loadTaskHistory(cwd, lang);
    const cancelledHistory = history.find(({ worktreeId }) => worktreeId === pending.name)!;
    expect(cancelledHistory).toMatchObject({ status: 'failed', startedAt: 'N/A', completedAt: 'N/A', failureSummary: invalidated.failure!.error });
    expect(formatTaskHistorySummary([cancelledHistory], lang)).toContain('N/A / N/A');
    for (const task of [completed, failed]) {
      const executedHistory = history.find(({ worktreeId }) => worktreeId === task.name)!;
      expect(executedHistory).toMatchObject({ startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z' });
      expect(formatTaskHistorySummary([executedHistory], lang)).toContain('2026-10-10T00:00:00Z / 2026-10-10T00:01:00Z');
    }
  }
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await listTasksNonInteractive(cwd, { enabled: true, format: 'json' });
  expect(output).toHaveBeenCalledOnce();
  const json = JSON.parse(output.mock.calls[0]![0] as string) as { tasks: JsonTaskListItem[] };
  output.mockRestore();
  expect(json.tasks).toHaveLength(before.length);
  const cancelledJson = json.tasks.find(({ name }) => name === pending.name)!;
  expect(cancelledJson).toMatchObject({ kind: 'failed', failure: { error: invalidated.failure!.error } });
  expect(cancelledJson).not.toHaveProperty('startedAt');
  expect(cancelledJson).not.toHaveProperty('completedAt');
  for (const task of [completed, failed]) {
    expect(json.tasks.find(({ name }) => name === task.name)).toMatchObject({ startedAt: '2026-10-10T00:00:00Z', completedAt: '2026-10-10T00:01:00Z' });
  }
  expect(runner.claimNextTasks(3).map(({ name }) => name)).toEqual([ordinary.name, unrelated.name]);
  expect(runner.claimNextTasks(1)).toEqual([]);
  expect(await store.get(saved.id)).toEqual({ ...saved, executionStatus: 'aborted' });
});

it('keeps a failed pending invalidation visible and retries it without reopening the aborted goal', async () => {
  const saved = { ...goalRecord(), objective: 'Abort target' };
  const { store, send, call, callTool } = await mountGoalControls('en', saved);
  const runner = new TaskRunner(cwd);
  const pending = runner.addTask('pending abort retry', { goal_id: saved.id });
  await send(`/abort ${saved.id}`);
  await expectAbortConfirmation(saved);
  const update = vi.spyOn(TaskStore.prototype, 'update').mockImplementationOnce(() => { throw new Error('Pending write unavailable'); });
  confirmAbort();
  await vi.waitFor(async () => expect((await store.get(saved.id)).executionStatus).toBe('aborted'));
  await vi.waitFor(() => expect(app!.lastFrame()).toContain('Pending write unavailable'));
  update.mockRestore();
  expect(new TaskStore(cwd).read().tasks).toContainEqual(expect.objectContaining({ name: pending.name, status: 'pending', started_at: null, completed_at: null }));
  expect(runner.claimNextTasks(1)).toEqual([]);
  await send(`/abort ${saved.id}`);
  await expectAbortConfirmation(saved);
  confirmAbort();
  await vi.waitFor(() => expect(runner.listTaskStateItems()).toContainEqual(expect.objectContaining({ name: pending.name, status: 'failed', failure: expect.objectContaining({ retryable: false }) })));
  expect(new TaskStore(cwd).read().tasks).toContainEqual(expect.objectContaining({ name: pending.name, status: 'failed', started_at: null, completed_at: null, failure: expect.objectContaining({ retryable: false }) }));
  expect(runner.claimNextTasks(1)).toEqual([]);
  expect((await store.get(saved.id)).executionStatus).toBe('aborted');
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
});

it('exposes manager work tools without exposing a goal abort tool to the agent', async () => {
  const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
  const client = new Client({ name: 'manager-abort-tools-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).toContain('takt_enqueue_goal_task');
    expect(names.filter((name) => /abort/iu.test(name))).toEqual([]);
  } finally { await client.close(); await server.close(); }
});

it('saves completion and human answer events after abort without invoking a manager turn', async () => {
  const question = addGoalQuestion({ ...goalRecord(), executionStatus: 'aborted' }, { body: 'Which format?' });
  const { store, call, callTool } = await mountGoalControls('en', question.goal);
  const completion = { taskName: 'interrupted-task', runSlug: 'aborted-run', result: {
    success: false, interrupted: true, workflowResult: 'aborted' as const, failureReason: 'Goal was aborted',
  } };
  await processGoalCompletions(cwd, goalId, {}, completion);
  const savedEvent = (await store.get(goalId)).events![0]!;
  expect(savedEvent).toMatchObject({ ...completion, kind: 'completion', processed: false });
  await processGoalCompletions(cwd, goalId, {}, completion);
  expect((await store.get(goalId)).events).toEqual([savedEvent]);
  expect((await session!.answerQuestion({ goalId, questionId: question.questionId, text: 'JSON' })).kind).toBe('reply');
  const after = await store.get(goalId);
  expect(after.executionStatus).toBe('aborted');
  expect(after.questions).toContainEqual(expect.objectContaining({ id: question.questionId, status: 'answered', answer: expect.objectContaining({ text: 'JSON', source: 'tui' }) }));
  expect(after.events).toEqual([savedEvent, expect.objectContaining({ kind: 'answer', questionId: question.questionId, processed: false, answer: expect.objectContaining({ text: 'JSON', source: 'tui' }) })]);
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
});

it('keeps SIGINT ownership when a single goal task receives its own signal without a worker pool', async () => {
  const goal = await new GoalStore(cwd).create(goalRecord());
  mkdirSync(join(cwd, '.takt', 'workflows'));
  writeFileSync(join(cwd, '.takt', 'workflows', 'single-goal.yaml'), 'name: single-goal\nmax_steps: 2\ninitial_step: work\nsteps:\n  - name: work\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
  const engine = new EventEmitter();
  let finish!: (state: Partial<WorkflowState>) => void;
  const work = new Promise<Partial<WorkflowState>>((resolve) => { finish = resolve; });
  let interrupted = false;
  const abort = (): void => {
    if (interrupted) return;
    interrupted = true;
    const state = { status: 'aborted' as const, iteration: 1 };
    engine.emit('workflow:abort', state, 'user_interrupted', 'interrupt', {
      kind: 'interrupt', step: 'work', reason: 'user_interrupted', error: 'user_interrupted',
    });
    finish(state);
  };
  let providerSignal: AbortSignal | undefined;
  vi.spyOn(workflowCore, 'WorkflowEngine').mockImplementation(function (_config, _cwd, _task, options) {
    providerSignal = options?.abortSignal;
    return Object.assign(engine, { run: async () => work, abort, isAbortRequested: () => interrupted }) as never;
  });
  const runner = new TaskRunner(cwd);
  runner.addTask('single goal work', { workflow: 'single-goal', goal_id: goal.id, worktree: false });
  const task = runner.claimNextTasks(1)[0]!;
  const listeners = new Set(process.listeners('SIGINT'));
  let taskSignal: AbortSignal | undefined;
  const execution = executeTaskAndCompleteWithDetails(task, runner, cwd, (options) => {
    taskSignal = options.abortSignal;
    return executeTaskWithResult(options);
  });
  try {
    let listener: NodeJS.SignalsListener | undefined;
    await vi.waitFor(() => {
      listener = process.listeners('SIGINT').find((value) => !listeners.has(value));
      expect(listener).toBeDefined();
      expect(providerSignal).toBeDefined();
    }, { timeout: 2000 });
    expect(taskSignal).toBeDefined();
    expect(taskSignal!.aborted).toBe(false);
    listener!('SIGINT');
    expect(providerSignal!.aborted).toBe(true);
    expect((await execution).success).toBe(false);
    expect(runner.listTaskStateItems()).toContainEqual(expect.objectContaining({ name: task.name, status: 'failed', completion: expect.objectContaining({ success: false, interrupted: true }) }));
    expect(process.listeners('SIGINT').filter((value) => !listeners.has(value))).toEqual([]);
  } finally { abort(); await execution; }
});

it.each(['ja', 'en'] as const)('pauses and resumes an awaiting-merge goal from commands in the same %s TUI while preserving evidence', async (lang) => {
  const saved: Goal = { ...goalRecord(), objective: 'Goal display fixture', status: 'awaiting_merge',
    completion: {
      goalBranch: goalRecord().branch, goalSha: 'a'.repeat(40), targetBranch: 'main', summary: 'Ready for integration',
      changeSummary: { filesChanged: 1, additions: 2, deletions: 0,
        files: [{ path: 'result.txt', additions: 2, deletions: 0 }], truncated: false, totalsTruncated: false },
      instructions: ['git merge --ff-only goal-branch'],
    },
  };
  const { store, call, callTool, send } = await mountGoalControls(lang, saved);
  await send(`/pause ${goalId}`);
  await vi.waitFor(async () => expect((await store.get(goalId)).executionStatus).toBe('paused'));
  expect(await store.get(goalId)).toEqual({ ...saved, executionStatus: 'paused' });
  await vi.waitFor(() => {
    const rows = app!.lastFrame()!.split('\n');
    const goalRow = rows.findIndex((row) => row.includes(saved.objective));
    expect(goalRow).toBeGreaterThanOrEqual(0);
    expect(rows.slice(Math.max(0, goalRow - 1), goalRow + 3).join('\n')).toMatch(lang === 'ja' ? /一時停止|停止中/u : /paused/iu);
  });
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
  await send(`/resume ${goalId}`);
  await vi.waitFor(async () => expect((await store.get(goalId)).executionStatus).toBe('active'));
  expect(await store.get(goalId)).toEqual(saved);
  await vi.waitFor(() => {
    const rows = app!.lastFrame()!.split('\n');
    const goalRow = rows.findIndex((row) => row.includes(saved.objective));
    if (goalRow !== -1) expect(rows.slice(Math.max(0, goalRow - 1), goalRow + 3).join('\n')).not.toMatch(lang === 'ja' ? /一時停止|停止中/u : /paused/iu);
  });
  expect(call).not.toHaveBeenCalled();
  expect(callTool).not.toHaveBeenCalled();
});

it.each([
  '操作例: /pause', '> /pause', '```\n/pause', '~~~\n/pause',
  '```\n/pause GOAL\n```', '~~~\n/pause GOAL\n~~~', '/paused',
  '説明\n/pause',
])('keeps command-like conversation text as ordinary input: %s', async (prefix) => {
  const saved = goalRecord();
  const { store, call, send } = await mountGoalControls('ja', saved);
  const text = prefix.includes('GOAL') ? prefix.replace('GOAL', goalId) : `${prefix} ${goalId}`;
  await send(text);
  await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
  expect(call.mock.calls[0]![0]).toBe(text);
  expect(await store.get(goalId)).toEqual(saved);
});

it.each([false, true])('preserves the saved completion identity across pause and resume (previously saved=%s)', async (previouslySaved) => {
  const store = new GoalStore(cwd);
  await store.create({ ...goalRecord(), executionStatus: 'paused' });
  const completion = { taskName: 'task-a', runSlug: 'run-a', result: { success: true, interrupted: false, sha: 'a'.repeat(40) } };
  if (previouslySaved) await recordGoalCompletion(cwd, goalId, completion);
  const previousId = (await store.get(goalId)).events?.[0]?.id;
  const provider = new MockProvider();
  const call = vi.fn<ProviderAgent['call']>().mockResolvedValue({ persona: 'manager', status: 'done', timestamp: new Date(),
    content: '', structuredOutput: { message: 'saved completion processed', summary: null } });
  vi.spyOn(provider, 'setup').mockReturnValue({ call });
  const plan = { ctx: { providerType: 'mock' as const, model: undefined, lang: 'ja' as const, provider },
    strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } };
  vi.spyOn(managerPlans, 'createManagerConversationPlan').mockReturnValue(plan);
  vi.spyOn(managerMcp, 'prepareManagerMcp').mockResolvedValue({ command: process.execPath, args: [], env: {}, servers: {}, dispose: async () => {} });
  session = createManagerConversationSession({ cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() }, plan });
  await processGoalCompletions(cwd, goalId, {}, completion);
  const paused = await store.get(goalId);
  expect(paused.events).toEqual([expect.objectContaining({ ...completion, id: expect.any(String), kind: 'completion', processed: false })]);
  if (previouslySaved) expect(paused.events![0]!.id).toBe(previousId);
  expect(call).not.toHaveBeenCalled();
  const event = paused.events![0]!;
  expect((await session.resumeGoal({ goalId })).kind).toBe('reply');
  expect((await store.get(goalId)).events).toEqual([{ ...event, processed: true, summary: 'saved completion processed' }]);
  expect(call).toHaveBeenCalledOnce();
  expect(JSON.parse(call.mock.calls[0]![0]).event.id).toBe(event.id);
});

it('shows pending questions and their answer commands when question notifications are disabled, excluding withdrawn questions on reopening', async () => {
  const input = { body: '出力形式はどれですか', options: ['CSV', 'JSON'], recommendation: 'CSV' };
  const added = addGoalQuestion(goalRecord(), input);
  const remaining = addGoalQuestion(added.goal, { body: '保存先はどこですか' });
  const policy = resolveManagerConfig(cwd).notifications;
  expect(policy.question).toBe(false);
  const store = new GoalStore(cwd);
  await store.create(appendGoalNotification(remaining.goal, { kind: 'question', body: input.body }, policy));
  const saved = await store.get(goalId);
  expect(saved.notifications ?? []).toEqual([]);
  expect(saved.questions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: added.questionId, ...input, status: 'pending' }),
  ]));

  session = createManagerConversationSession({
    cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    plan: {
      ctx: { providerType: 'mock', model: undefined, lang: 'ja', provider: new MockProvider() },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] },
    },
  });
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));

  await vi.waitFor(() => {
    const frame = app!.lastFrame();
    expect(frame).toContain(`${goalId}: ${saved.objective}`);
    expect(frame).toContain(`${added.questionId}: ${input.body}`);
    expect(frame).toContain('CSV / JSON');
    expect(frame).toContain(`推奨: ${input.recommendation}`);
    expect(frame).toContain(`/answer ${added.questionId}`);
    expect(frame).toContain(`/answer ${remaining.questionId}`);
  });

  app.unmount();
  await store.update(goalId, (goal) => withdrawGoalQuestion(goal, added.questionId));
  const display = await readManagerDisplayEvents(cwd);
  expect(display.events).toEqual([]);
  expect(display.diagnostics).toEqual([]);
  expect(display.questions.map(({ question }) => question.id)).toEqual([remaining.questionId]);
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));

  await vi.waitFor(() => {
    const frame = app!.lastFrame();
    expect(frame).toContain(`/answer ${remaining.questionId}`);
    expect(frame).not.toContain(added.questionId);
    expect(frame).not.toContain(input.body);
  });
});

it.each([true, false])('shows only human questions and their saved automatic notifications in the TUI (notifications=%s)', async (enabled) => {
  writeFileSync(join(cwd, '.takt', 'config.yaml'), `provider: mock\nmanager:\n  auto_run: false\n  notifications:\n    question: ${enabled}\n`);
  invalidateResolvedConfigCache(cwd);
  const human = addGoalQuestion(goalRecord(), { recipient: 'human', body: '出力形式はどれですか' });
  const director = addGoalQuestion(human.goal, { recipient: 'director', body: '出力形式はどれですか' });
  const questions = director.goal.questions!;
  const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
  let saved = director.goal;
  for (const question of questions) saved = appendGoalNotification(saved, { kind: 'question', body: formatGoalQuestionNotification(question) }, policy);
  saved = appendGoalNotification(saved, { kind: 'custom', body: `${director.questionId}: 一般通知` }, policy);
  saved = appendGoalNotification(saved, { kind: 'question', body: `関連質問 ${director.questionId}: 本文中のID` }, policy);
  await new GoalStore(cwd).create(saved);
  const display = await readManagerDisplayEvents(cwd);
  expect(display.questions.map(({ question }) => question.id)).toEqual([human.questionId]);
  expect(display.events.map(({ id }) => JSON.parse(id)[2])).toEqual([
    saved.notifications![0]!.id, saved.notifications![2]!.id, saved.notifications![3]!.id,
  ]);
  session = createManagerConversationSession({
    cwd, confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    plan: { ctx: { providerType: 'mock', model: undefined, lang: 'ja', provider: new MockProvider() },
      strategy: { systemPrompt: 'manager fixture', allowedTools: ['Read'] } },
  });
  app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
  await vi.waitFor(() => {
    const frame = app!.lastFrame();
    expect(frame).toContain(`/answer ${human.questionId}`);
    expect(frame).not.toContain(`/answer ${director.questionId}`);
    expect(frame).toContain(`${director.questionId}: 一般通知`);
  });
});
