import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { connectManagerMcp, prepareManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { createTaktMcpServer, type TaktMcpToolSet } from '../features/mcp/server.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal, GoalTaskResult } from '../infra/goals/schema.js';
import { getScenarioQueue, resetScenario, setMockScenario } from '../infra/mock/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { TaskRunner, type TaskInfo } from '../infra/task/index.js';
import { runAllTasks } from '../features/tasks/execute/runAllTasks.js';
import { watchTasks } from '../features/tasks/watch/index.js';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import { runManager } from '../features/manager/runManager.js';
import { mountInk } from '../features/tui/inkMount.js';
import { acquireProjectExecutionLock, getProjectExecutionOwner } from '../infra/task/project-execution-lock.js';
import * as executionLocks from '../infra/task/project-execution-lock.js';
import { readManagerRunFailures, recordManagerRunFailure } from '../infra/task/manager-run-state.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import * as postExecution from '../features/tasks/execute/postExecution.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { isProcessAlive } from '../infra/task/process.js';
import { GOAL_TURN_OWNERS_ENV, withGoalTurns } from '../infra/goals/turn-lock.js';
import { TaskStore } from '../infra/task/store.js';
import { processGoalCompletions, recoverManagerEvents } from '../features/manager/completionTurn.js';
import { claimTasksWithGoalCompletions } from '../features/tasks/execute/claimTasks.js';
import * as completionTurns from '../features/manager/completionTurn.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import * as processIdentity from '../infra/task/process.js';
import { captureOwnedChild, captureOwnedProcess, ownedProcessMarkerScript, readOwnedProcessMarker, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomUUID: vi.fn(original.randomUUID) };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
}));
vi.mock('../infra/task/process.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../infra/task/process.js')>(),
}));

vi.mock('../infra/config/global/globalConfig.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/global/globalConfig.js')>();
  return { ...original, invalidateGlobalConfigCache: vi.fn(original.invalidateGlobalConfigCache) };
});
vi.mock('../features/tasks/execute/postExecution.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/tasks/execute/postExecution.js')>(),
}));

vi.mock('../features/tui/inkMount.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../features/tui/inkMount.js')>(),
  mountInk: vi.fn(),
}));

const newId = '650e8400-e29b-41d4-a716-446655440001';

describe('manager turns after worker pool completion', () => {
  let cwd: string;
  let runner: TaskRunner;
  let managerCall: ReturnType<typeof vi.fn<ProviderAgent['call']>>;
  let scheduling: AbortController;
  let taskAbort: AbortController;
  let children: Map<childProcess.ChildProcess, { ended: Promise<void>; owned: Promise<OwnedProcess | undefined> }>;

  function trackProcess<T extends childProcess.ChildProcess>(child: T): T {
    const ended = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => { if (child.pid === undefined) resolve(); });
    });
    const owned = captureOwnedChild(child);
    void owned.catch(() => {});
    children.set(child, { ended, owned });
    return child;
  }

  function observeSpawn() {
    const spawn = childProcess.spawn;
    return vi.spyOn(childProcess, 'spawn').mockImplementation((...args: Parameters<typeof spawn>) => trackProcess(spawn(...args)));
  }

  async function stopOwnedProcesses(): Promise<void> {
    for (const gate of ['release-turn', 'release-completion-child', '.takt/release-drain', '.takt/release-child']) {
      writeFileSync(join(cwd, gate), 'cleanup');
    }
    const waitUntil = async (done: () => boolean): Promise<boolean> => {
      const deadline = Date.now() + 1000;
      while (!done() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return done();
    };
    const errors: unknown[] = [];
    const parents = await Promise.allSettled([...children].map(async ([child, entry]) => {
      const owned = await entry.owned;
      if (owned !== undefined) await terminateOwnedProcess(owned, () => child.exitCode !== null || child.signalCode !== null);
      let closed = false;
      void entry.ended.then(() => { closed = true; });
      if (!await waitUntil(() => closed)) throw new Error(`Process streams did not close: ${child.pid}`);
    }));
    errors.push(...parents.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    const processes: OwnedProcess[] = [];
    for (const marker of ['completion-child-entered', '.takt/child-started']) {
      const path = join(cwd, marker);
      try { if (existsSync(path)) processes.push(readOwnedProcessMarker(readFileSync(path, 'utf8'))); }
      catch (error) { errors.push(error); }
    }
    const lockDirectory = join(cwd, '.takt', 'execution.lock');
    if (existsSync(lockDirectory)) {
      for (const file of readdirSync(lockDirectory).filter((name) => name.startsWith('owner-') && name.endsWith('.json'))) {
        try {
          const owner = JSON.parse(readFileSync(join(lockDirectory, file), 'utf8')) as { pid: number; processIdentity?: { startTime: string } };
          if (owner.pid !== process.pid) processes.push(readOwnedProcessMarker(JSON.stringify({ pid: owner.pid, startTime: owner.processIdentity?.startTime })));
        } catch (error) { errors.push(error); }
      }
    }
    const detached = await Promise.allSettled(processes.map((owned) => terminateOwnedProcess(owned, () => false)));
    errors.push(...detached.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, `Cleanup failed; retaining ${cwd}: ${errors.map(String).join('; ')}`);
  }

  beforeEach(async () => {
    children = new Map();
    const root = join(process.cwd(), '.tmp');
    mkdirSync(root, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(root, 'manager-loop-')));
    git(cwd, ['init', '--initial-branch=main']);
    git(cwd, ['config', 'user.name', 'Manager Test']);
    git(cwd, ['config', 'user.email', 'manager@example.test']);
    const tree = git(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    const commit = git(cwd, ['commit-tree', tree, '-m', 'manager loop fixture']);
    git(cwd, ['update-ref', 'refs/heads/main', commit]);
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), [
      'provider: mock', 'language: en', 'branch_name_strategy: romaji',
      'auto_requeue_max_attempts: 0', 'task_poll_interval_ms: 100',
    ].join('\n'));
    writeFileSync(join(cwd, '.takt', 'workflows', 'loop-fixture.yaml'), [
      'name: loop-fixture', 'description: manager loop fixture', 'max_steps: 2', 'initial_step: work',
      'steps:', '  - name: work', '    persona: coder', '    instruction: "{task}"',
      '    rules:', '      - condition: when(true)', '        next: COMPLETE',
      '      - condition: blocked', '        next: ABORT',
    ].join('\n'));
    await registerFixtureGoal(cwd);
    runner = new TaskRunner(cwd);
    scheduling = new AbortController();
    taskAbort = new AbortController();
    managerCall = vi.fn<ProviderAgent['call']>().mockResolvedValue(managerReply('成果を確認しました', 'goal-session'));
    const setup = MockProvider.prototype.setup;
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      return config.name === 'manager' ? { call: managerCall } : setup.call(this, config);
    });
    resetScenario();
  });

  function identityPreload(): string[] {
    const url = pathToFileURL(join(process.cwd(), 'dist/infra/task/process.js')).href;
    return ['--import', `data:text/javascript,${encodeURIComponent(`import { getSelfProcessIdentity } from ${JSON.stringify(url)}; getSelfProcessIdentity();`)}`];
  }

  async function cleanupTest(directory: string, stopProcesses: () => Promise<void>, cleanupUi: () => void): Promise<void> {
    const errors: unknown[] = [];
    let stopped = false;
    try { await stopProcesses(); stopped = true; }
    catch (error) { errors.push(error); }
    const restore = (action: () => void): void => {
      try { action(); } catch (error) { errors.push(error); }
    };
    restore(cleanupUi);
    restore(resetScenario);
    restore(() => vi.restoreAllMocks());
    restore(() => vi.unstubAllEnvs());
    restore(invalidateGlobalConfigCache);
    if (stopped) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) {
        errors.push(error);
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (errors.length > 0) throw new AggregateError(errors, `Cleanup failed: ${errors.map(String).join('; ')}`);
  }

  afterEach(() => cleanupTest(cwd, stopOwnedProcesses, cleanup));

  it.each(['success', 'process failure', 'UI failure', 'both failures'] as const)('restores all test state before reporting cleanup errors: %s', async (failure) => {
    const directory = join(cwd, 'cleanup-case');
    mkdirSync(directory);
    const previous = process.env.TAKT_TEST_CLEANUP;
    vi.stubEnv('TAKT_TEST_CLEANUP', 'changed');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'leftover' }]);
    const invalidation = vi.mocked(invalidateGlobalConfigCache);
    invalidation.mockClear();
    const processError = new Error('injected termination failure');
    const uiError = new Error('injected UI cleanup failure');
    const processFailed = failure === 'process failure' || failure === 'both failures';
    const uiFailed = failure === 'UI failure' || failure === 'both failures';
    const order: string[] = [];
    let reported: unknown;
    try {
      await cleanupTest(directory, async () => {
        order.push('process');
        if (processFailed) throw processError;
      }, () => {
        order.push('UI');
        cleanup();
        if (uiFailed) throw uiError;
      });
    } catch (error) { reported = error; order.push('reported'); }
    expect(getScenarioQueue()).toBeNull();
    expect(vi.isMockFunction(MockProvider.prototype.setup)).toBe(false);
    expect(process.env.TAKT_TEST_CLEANUP).toBe(previous);
    expect(invalidation).toHaveBeenCalledTimes(1);
    expect(existsSync(directory)).toBe(processFailed);
    expect(order).toEqual(failure === 'success' ? ['process', 'UI'] : ['process', 'UI', 'reported']);
    if (failure === 'success') expect(reported).toBeUndefined();
    else {
      expect(reported).toBeInstanceOf(AggregateError);
      expect((reported as AggregateError).errors).toEqual([
        ...(processFailed ? [processError] : []), ...(uiFailed ? [uiError] : []),
      ]);
    }
  });

  function managerReply(message: string, sessionId: string) {
    return {
      persona: 'manager', status: 'done' as const, timestamp: new Date('2026-10-06T00:00:00Z'),
      content: JSON.stringify({ message, summary: null }), structuredOutput: { message, summary: null }, sessionId,
    };
  }

  function addGoalTask(content: string) {
    const options = { workflow: 'loop-fixture', worktree: false, goal_id: goalId };
    return runner.addTask(content, options);
  }

  function saveCompletedFixture(taskName: string, runSlug: string, id = goalId, completion: GoalTaskResult = { success: true, interrupted: false }) {
    runner.addTask('saved work', { workflow: 'loop-fixture', worktree: false, goal_id: id, slug: taskName });
    const [claimed] = runner.claimNextTasks(1);
    const task = runner.updateRunningTaskExecution(claimed!.name, { runSlug });
    runner.completeTask({ task, success: true, completion, response: 'saved result',
      executionLog: [], startedAt: '2026-10-06T00:00:00Z', completedAt: '2026-10-06T00:01:00Z' });
    return task.name;
  }

  function disableAutoRun() {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nmanager:\n  auto_run: false\n');
  }

  async function openManagerScreen() {
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.mocked(mountInk<void>).mockResolvedValue(undefined);
    try { await runManager({ cwd }); }
    finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  }

  it.each(['MCP', 'TUI', 'run'] as const)('recovers an ownerless goal task through %s after saving its interrupted result', async (entry) => {
    disableAutoRun();
    const task = addGoalTask('crashed goal work');
    const ordinary = runner.addTask('crashed ordinary work', { workflow: 'loop-fixture', worktree: false });
    const live = addGoalTask('live goal work');
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((saved) => ({
      ...saved, status: 'running', started_at: new Date().toISOString(), owner_pid: saved.name === live.name ? process.pid : null,
      run_slug: saved.name === task.name ? 'crashed-run' : undefined,
    })) }));
    managerCall.mockImplementation(async (prompt) => {
      const event = (JSON.parse(prompt) as { event: NonNullable<Goal['events']>[number] }).event;
      expect(new TaskStore(cwd).read().tasks.find((saved) => saved.name === task.name)).toMatchObject({
        status: 'failed', completion: event.result, run_slug: 'crashed-run',
      });
      return managerReply('中断を確認しました', 'recovered-session');
    });
    if (entry === 'run') await runAllTasks(cwd, { goalTasksOnly: true });
    else if (entry === 'TUI') await openManagerScreen();
    else {
      const server = createTaktMcpServer({}, { allowedProjectRoot: cwd });
      const client = new Client({ name: 'crash-recovery', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
        await vi.waitFor(() => expect(managerCall).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(savedGoal().events[0]?.processed).toBe(true));
      } finally { await client.close(); await server.close(); }
    }
    await recoverManagerEvents(cwd);
    expect(managerCall).toHaveBeenCalledTimes(1);
    expect(savedGoal().events).toEqual([expect.objectContaining({
      taskName: task.name, runSlug: 'crashed-run', processed: true,
      result: expect.objectContaining({ success: false, interrupted: true, workflowResult: 'error' }),
    })]);
    expect(runner.listTaskStateItems().filter((saved) => [ordinary.name, live.name].includes(saved.name))
      .map((saved) => saved.status)).toEqual(['running', 'running']);
  });

  it('defers orphan recovery for a busy goal while recovering another goal', async () => {
    disableAutoRun();
    const other = await registerFixtureGoal(cwd, { id: newId, objective: 'other recovery' });
    const busy = addGoalTask('busy orphan');
    const available = runner.addTask('available orphan', { workflow: 'loop-fixture', worktree: false, goal_id: other.id });
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((saved) => ({ ...saved, status: 'running', started_at: new Date().toISOString(), owner_pid: null })) }));
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = withGoalTurns(cwd, [goalId], async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    try {
      await recoverManagerEvents(cwd);
      expect(runner.listTaskStateItems().find((saved) => saved.name === busy.name)?.status).toBe('running');
      expect(runner.listTaskStateItems().find((saved) => saved.name === available.name)?.status).toBe('failed');
      expect((await new GoalStore(cwd).get(other.id)).events?.[0]?.processed).toBe(true);
      expect(managerCall).toHaveBeenCalledTimes(1);
    } finally { release(); await held; }
    await recoverManagerEvents(cwd);
    expect(runner.listTaskStateItems().find((saved) => saved.name === busy.name)?.status).toBe('failed');
    expect(savedGoal().events[0]?.processed).toBe(true);
    expect(managerCall).toHaveBeenCalledTimes(2);
  });

  it.each(['run', 'watch'] as const)('delivers the sole unreadable goal claim and executes manager follow-up work in %s', async (mode) => {
    disableAutoRun();
    const task = addGoalTask('unreadable goal work');
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((saved) => ({
      ...saved, content: undefined, content_file: 'missing-order.md',
    })) }));
    let next: string | undefined;
    managerCall.mockImplementation(async (prompt) => {
      const event = (JSON.parse(prompt) as { event: NonNullable<Goal['events']>[number] }).event;
      const saved = new TaskStore(cwd).read().tasks.find((saved) => saved.name === event.taskName)!;
      expect(saved.completion).toEqual(event.result);
      if (event.taskName === task.name) {
        expect(saved.status).toBe('failed');
        expect(event.result).toMatchObject({ success: false, interrupted: false, workflowResult: 'error' });
        next = addGoalTask('manager follow-up').name;
      } else {
        expect(event.taskName).toBe(next);
        expect(saved.status).toBe('completed');
        if (mode === 'watch') process.emit('SIGINT');
      }
      return managerReply('次の作業を判断しました', 'follow-up-session');
    });
    setMockScenario([{ persona: 'coder', status: 'done', content: 'follow-up completed' }]);
    if (mode === 'run') await runAllTasks(cwd, { provider: 'mock' });
    else await watchTasks(cwd, { provider: 'mock' });
    expect(managerCall).toHaveBeenCalledTimes(2);
    expect(savedGoal().events).toEqual([
      expect.objectContaining({ taskName: task.name, processed: true }),
      expect.objectContaining({ taskName: next, processed: true }),
    ]);
    expect(runner.listTaskStateItems().find((saved) => saved.name === next)?.status).toBe('completed');
  });

  it.each(['initialization', 'execution lock'] as const)('saves detached child %s failure and displays it on manager startup', async (boundary) => {
    const task = addGoalTask('pending after child startup failure');
    const spawn = childProcess.spawn;
    const observed = vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
      if (boundary === 'execution lock') {
        mkdirSync(join(cwd, '.takt', 'execution.lock'));
        writeFileSync(join(cwd, '.takt', 'execution.lock', 'corrupt'), 'invalid lock');
      }
      return trackProcess(spawn(command, args, {
        ...options,
        env: { ...options?.env, ...(boundary === 'initialization' ? { TAKT_CONFIG_DIR: join(cwd, '.takt') } : {}) },
      }));
    });
    await ensureManagerRun(cwd);
    expect(observed).toHaveBeenCalledTimes(1);
    const child = observed.mock.results[0]!.value as childProcess.ChildProcess;
    await children.get(child)!.ended;
    expect(child.exitCode).toBe(1);
    const failures = readManagerRunFailures(cwd);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message.length).toBeGreaterThan(0);
    expect(runner.listTaskStateItems().find((saved) => saved.name === task.name)?.status).toBe('pending');
    if (boundary === 'execution lock') rmSync(join(cwd, '.takt', 'execution.lock'), { recursive: true });
    observed.mockRestore();
    disableAutoRun();
    vi.mocked(mountInk<void>).mockImplementationOnce(async (buildTree) => {
      const app = render(buildTree({ settle: vi.fn(), fail: vi.fn() }));
      try { await vi.waitFor(() => expect(app.lastFrame()!.replace(/\s/g, '')).toContain(failures[0]!.message.replace(/\s/g, ''))); }
      finally { app.unmount(); }
    });
    await openManagerScreen();
  });

  it('retries a pending response after goal publication fails', async () => {
    saveCompletedFixture('saved-task', 'saved-run');
    const update = GoalStore.prototype.update;
    let failed = false;
    vi.spyOn(GoalStore.prototype, 'update').mockImplementation(function (this: GoalStore, id, action) {
      return update.call(this, id, (current) => {
        const next = action(current);
        if (!failed && next.events?.some((event) => event.processed)) { failed = true; throw new Error('injected goal publication failure'); }
        return next;
      });
    });
    await processGoalCompletions(cwd, goalId);
    expect(failed).toBe(true);
    expect(savedGoal().events[0]!.processed).toBe(false);
    await processGoalCompletions(cwd, goalId);
    expect(managerCall).toHaveBeenCalledTimes(2);
    expect(savedGoal().events[0]).toMatchObject({ processed: true, summary: '成果を確認しました' });
  });

  it('recovers an event that failed after conversation MCP setup on the next operation in that connection', async () => {
    const prepared = await prepareManagerMcp(createGoalConfirmation(cwd).publicKey);
    const encodedOwners = prepared.env[GOAL_TURN_OWNERS_ENV];
    const server = createTaktMcpServer({}, {
      toolSet: 'manager', allowedProjectRoot: cwd,
      goalTurnOwners: encodedOwners === undefined ? undefined : JSON.parse(encodedOwners),
    });
    const client = new Client({ name: 'conversation-recovery', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.callTool({ name: 'takt_list_goals', arguments: { cwd } })).isError).toBeUndefined();
      saveCompletedFixture('saved-task', 'saved-run');
      managerCall.mockRejectedValueOnce(new Error('injected completion turn failure'));
      await processGoalCompletions(cwd, goalId);
      expect(savedGoal().events[0]!.processed).toBe(false);
      expect((await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } })).isError).toBeUndefined();
      await vi.waitFor(() => expect(savedGoal().events[0]!.processed).toBe(true));
      expect(savedGoal().events).toEqual([expect.objectContaining({ processed: true, taskName: 'saved-task', runSlug: 'saved-run' })]);
      expect(managerCall).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await server.close();
      await prepared.dispose();
    }
  });

  it.each([false, true].flatMap((ignoreSigterm) => ['assertion', 'timeout'].map((failure) => ({ ignoreSigterm, failure }))))('confirms process exit before cleanup after failure: %j', async ({ ignoreSigterm, failure }) => {
    const child = trackProcess(childProcess.spawn(process.execPath, [...identityPreload(), '-e', `
      process.on('SIGTERM', () => { ${ignoreSigterm ? '' : 'process.exit(0);'} });
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    try {
      if (failure === 'timeout') await new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('injected timeout')), 20));
      else expect('actual').toBe('expected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    } finally {
      await stopOwnedProcesses();
    }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.signalCode).toBe(ignoreSigterm ? 'SIGKILL' : null);
    expect(existsSync(cwd)).toBe(true);
  });

  it('retains files when an exit cannot be confirmed and still terminates the other child', async () => {
    const launch = () => trackProcess(childProcess.spawn(process.execPath, [...identityPreload(), '-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
    const held = launch();
    await new Promise<void>((resolve) => held.stdout!.once('data', () => resolve()));
    const other = launch();
    await new Promise<void>((resolve) => other.stdout!.once('data', () => resolve()));
    const kill = process.kill;
    const injected = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === held.pid && signal !== 0) return true;
      return kill.call(process, pid, signal);
    });
    try {
      await expect(stopOwnedProcesses()).rejects.toThrow('retaining');
      expect(existsSync(cwd)).toBe(true);
      expect(other.exitCode !== null || other.signalCode !== null).toBe(true);
      expect(held.exitCode).toBeNull();
    } finally { injected.mockRestore(); await stopOwnedProcesses(); }
  });

  it.each(['marker', 'owner'].flatMap((source) => ['reused', 'unknown'].map((identity) => ({ source, identity }))))('checks recorded process ownership and retains unknown live processes: %j', async ({ source, identity }) => {
    const held = childProcess.spawn(process.execPath, [...identityPreload(), '-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve) => held.stdout!.once('data', () => resolve()));
    const recorded = captureOwnedProcess(held.pid!);
    expect(recorded.identity).toBeDefined();
    const marker = { pid: recorded.pid, startTime: recorded.identity!.startTime };
    let ownerFile: string | undefined;
    if (source === 'marker') writeFileSync(join(cwd, '.takt', 'child-started'), JSON.stringify(marker));
    if (source === 'owner') {
      mkdirSync(join(cwd, '.takt', 'execution.lock'));
      ownerFile = join(cwd, '.takt', 'execution.lock', 'owner-cleanup.json');
      writeFileSync(ownerFile, JSON.stringify({ pid: recorded.pid, processIdentity: recorded.identity }));
    }
    const other = trackProcess(childProcess.spawn(process.execPath, [...identityPreload(), '-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
    await new Promise<void>((resolve) => other.stdout!.once('data', () => resolve()));
    const inspect = processIdentity.getProcessIdentity;
    const controlled = vi.spyOn(processIdentity, 'getProcessIdentity').mockImplementation((pid) => pid === recorded.pid
      ? identity === 'unknown' ? undefined : { startTime: process.platform === 'win32' ? '2000-01-01T00:00:00.0000000Z'
        : process.platform === 'linux' ? recorded.identity!.startTime.replace(/[0-9a-f]$/, (value) => value === '0' ? '1' : '0')
          : recorded.identity!.startTime.replace(/:\d+$/, (value) => `:${BigInt(value.slice(1)) + 1n}`) }
      : inspect(pid));
    const kill = vi.spyOn(process, 'kill');
    try {
      if (identity === 'unknown') await expect(stopOwnedProcesses()).rejects.toThrow(AggregateError);
      else await expect(stopOwnedProcesses()).resolves.toBeUndefined();
      expect(kill.mock.calls.filter(([pid, signal]) => pid === recorded.pid && signal !== 0)).toEqual([]);
      expect(isProcessAlive(recorded.pid)).toBe(true);
      expect(existsSync(cwd)).toBe(true);
      expect(other.exitCode !== null || other.signalCode !== null).toBe(true);
    } finally {
      controlled.mockRestore(); kill.mockRestore();
      await terminateOwnedProcess(recorded, () => held.exitCode !== null || held.signalCode !== null);
      if (ownerFile !== undefined) rmSync(ownerFile);
    }
  });

  it('recovers a pending event after goal completion releases the goal lock with an empty queue', async () => {
    disableAutoRun();
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{
      taskName: 'saved-task', runSlug: 'saved-run', processed: false, result: { success: true, interrupted: false },
    }] }));
    expect(runner.listTaskStateItems()).toEqual([]);
    let writeEntered!: () => void;
    let recoveryFinished!: () => void;
    const entered = new Promise<void>((resolve) => { writeEntered = resolve; });
    const recovered = new Promise<void>((resolve) => { recoveryFinished = resolve; });
    const list = GoalStore.prototype.list;
    vi.spyOn(GoalStore.prototype, 'list').mockImplementationOnce(async function (this: GoalStore) {
      await entered;
      return list.call(this);
    });
    const update = GoalStore.prototype.update;
    vi.spyOn(GoalStore.prototype, 'update').mockImplementationOnce(async function (this: GoalStore, id, action) {
      expect(getProjectExecutionOwner(join(cwd, '.takt', 'goals', goalId))).toBeDefined();
      writeEntered();
      await recovered;
      return update.call(this, id, action);
    });
    const recover = completionTurns.recoverManagerEvents;
    vi.spyOn(completionTurns, 'recoverManagerEvents').mockImplementationOnce(async (project) => {
      await recover(project);
      expect(getProjectExecutionOwner(join(cwd, '.takt', 'goals', goalId))).toBeDefined();
      expect(savedGoal().events[0]!.processed).toBe(false);
      expect(managerCall).not.toHaveBeenCalled();
      recoveryFinished();
    });
    managerCall.mockImplementationOnce(async () => {
      const saved = await new GoalStore(cwd).get(goalId);
      expect(saved.status).not.toBe('created');
      expect(JSON.stringify(saved)).toContain('成果を確認する');
      return managerReply('成果を確認しました', 'goal-session');
    });
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    const client = new Client({ name: 'same-goal-recovery', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain('takt_complete_goal');
      const currentGoal = await new GoalStore(cwd).get(goalId);
      const response = await client.callTool({ name: 'takt_complete_goal', arguments: {
        cwd, goalId, expectedSha: git(cwd, ['rev-parse', currentGoal.branch]), summary: '成果を確認する',
      } });
      expect(response.isError, firstTextContent(response.content)).toBeUndefined();
      await vi.waitFor(() => expect(savedGoal().events[0]!.processed).toBe(true));
      expect(managerCall).toHaveBeenCalledTimes(1);
      expect(runner.listTaskStateItems()).toEqual([]);
    } finally {
      writeEntered();
      recoveryFinished();
      await client.close();
      await server.close();
    }
  });

  it.each([true, false])('distinguishes task/run pairs when recovering persisted results through MCP: %s', async (bothSaved) => {
    saveCompletedFixture('a/b', 'c');
    if (bothSaved) saveCompletedFixture('a', 'b/c');
    else new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => ({ ...task, name: 'a', run_slug: 'b/c' })) }));
    const pairs = bothSaved ? [['a/b', 'c'], ['a', 'b/c']] : [['a', 'b/c']];
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: pairs.map(([taskName, runSlug]) => ({
      taskName: taskName!, runSlug: runSlug!, processed: false, result: { success: true, interrupted: false },
    })) }));
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    const client = new Client({ name: 'tuple-verification', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      await vi.waitFor(() => expect(savedGoal().events.every((event) => event.processed)).toBe(true));
      expect(managerCall).toHaveBeenCalledTimes(bothSaved ? 2 : 1);
      expect(managerCall.mock.calls.map(([prompt]) => {
        const { event } = JSON.parse(prompt) as { event: { taskName: string; runSlug: string } };
        return [event.taskName, event.runSlug];
      })).toEqual(pairs);
      expect(savedGoal().events.every((event) => event.processed)).toBe(true);
    } finally { await client.close(); await server.close(); }
  });

  function savedGoal() {
    return JSON.parse(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf8')) as {
      events: Array<{
        taskName: string; runSlug: string; processed: boolean;
        result: { success: boolean; branch?: string; sha?: string; interrupted: boolean; failureReason?: string };
      }>;
    };
  }

  it.each([true, false])('enqueues work for another goal while a completion turn is held, then recovers its pending event: active=%s', async (active) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nmanager:\n  auto_run: false\n');
    await registerFixtureGoal(cwd, { id: newId, objective: 'another goal' });
    saveCompletedFixture('held-task', 'held-run');
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{
      taskName: 'held-task', runSlug: 'held-run', processed: false, result: { success: true, interrupted: false },
    }] }));
    let releaseTurn!: () => void;
    const release = new Promise<void>((resolve) => { releaseTurn = resolve; });
    managerCall.mockImplementationOnce(async () => { await release; throw new Error('injected completion failure'); });
    const turn = active ? processGoalCompletions(cwd, goalId) : undefined;
    if (active) await vi.waitFor(() => expect(managerCall).toHaveBeenCalledTimes(1), { timeout: 15000 });
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    const client = new Client({ name: 'independent-goal-work', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const enqueue = client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
        cwd, goalId: newId, workflow: 'loop-fixture', task: 'independent work', purpose: '別ゴールの作業',
      } });
      let timeout!: ReturnType<typeof setTimeout>;
      try {
        const response = await Promise.race([enqueue, new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Another goal enqueue waited for the completion turn')), 3000);
        })]);
        expect(response.isError).toBeUndefined();
      } finally { clearTimeout(timeout); }
      expect(runner.listTaskStateItems().find((task) => task.goalId === newId)).toMatchObject({ status: 'pending' });
      await vi.waitFor(() => expect(managerCall).toHaveBeenCalledTimes(1));
      await recoverManagerEvents(cwd);
      expect(managerCall).toHaveBeenCalledTimes(1);
      expect(savedGoal().events[0]!.processed).toBe(false);
      releaseTurn();
      if (turn !== undefined) await turn;
      await vi.waitFor(() => expect(getProjectExecutionOwner(join(cwd, '.takt', 'goals', goalId))).toBeUndefined());
      await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId: newId } });
      await vi.waitFor(() => expect(savedGoal().events[0]!.processed).toBe(true));
      expect(managerCall).toHaveBeenCalledTimes(2);
      expect(readManagerRunFailures(cwd)).toHaveLength(1);
    } finally {
      releaseTurn();
      if (turn !== undefined) await turn;
      await client.close();
      await server.close();
    }
  });

  it('waits for a busy goal turn after a failed claim and claims the follow-up work', async () => {
    const broken = addGoalTask('unreadable goal work');
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name === broken.name
      ? { ...task, content: undefined, content_file: 'missing-instruction.md' } : task) }));
    const projectLock = acquireProjectExecutionLock(cwd, 'run');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const turn = withGoalTurns(cwd, [goalId], async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    let followUp: TaskInfo | undefined;
    managerCall.mockImplementationOnce(async () => {
      followUp = addGoalTask('follow-up after failed claim');
      return managerReply('次の作業を投入しました', 'goal-session');
    });
    setMockScenario([{ persona: 'coder', status: 'done', content: 'follow-up result' }]);
    const claim = await claimTasksWithGoalCompletions(runner, 1, cwd, { provider: 'mock' }, scheduling.signal);
    let settled = false;
    const running = runWithWorkerPool(runner, claim.tasks, 1, cwd, { provider: 'mock' }, undefined, 100, 'run', {
      schedulingSignal: scheduling.signal, taskAbortSignal: taskAbort.signal,
    }, claim.managerCompletion).then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(runner.listTaskStateItems()[0]).toMatchObject({ status: 'failed' }));
      await recoverManagerEvents(cwd);
      expect(managerCall).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      release();
      await turn;
      expect(await running).toMatchObject({ success: 1, executedTaskNames: [followUp!.name] });
      expect(managerCall).toHaveBeenCalledTimes(2);
      expect(savedGoal().events).toEqual([
        expect.objectContaining({ taskName: broken.name, processed: true }),
        expect.objectContaining({ taskName: followUp!.name, processed: true }),
      ]);
    } finally {
      release();
      await turn;
      await running;
      projectLock.release();
    }
  });

  it.each(['run', 'watch'].flatMap((mode) => [false, true].map((pollClaim) => ({ mode, pollClaim }))))('starts ordinary work while an unreadable goal claim waits for its turn: %j', async ({ mode, pollClaim }) => {
    disableAutoRun();
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nconcurrency: 1\n');
    if (pollClaim) runner.addTask('initial ordinary work', { workflow: 'loop-fixture', worktree: false });
    const broken = addGoalTask('unreadable goal work');
    const ordinary = runner.addTask('ordinary work', { workflow: 'loop-fixture', worktree: false });
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name === broken.name
      ? { ...task, content: undefined, content_file: 'missing-instruction.md' } : task) }));
    const goalLock = acquireProjectExecutionLock(join(cwd, '.takt', 'goals', goalId), 'run');
    setMockScenario(Array.from({ length: pollClaim ? 2 : 1 }, () => ({ persona: 'coder', status: 'done' as const, content: 'ordinary result' })));
    managerCall.mockImplementationOnce(async () => {
      if (mode === 'watch') process.emit('SIGINT');
      return managerReply('失敗した作業を確認しました', 'goal-session');
    });
    let settled = false;
    const running = (mode === 'run' ? runAllTasks(cwd, { provider: 'mock' }) : watchTasks(cwd, { provider: 'mock' }))
      .then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(runner.listTaskStateItems().find(({ name }) => name === ordinary.name)?.status).toBe('completed'), { timeout: 15000 });
      expect(runner.listTaskStateItems().find(({ name }) => name === broken.name)?.status).toBe('failed');
      expect(managerCall).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      goalLock.release();
      await running;
      expect(savedGoal().events).toEqual([expect.objectContaining({ taskName: broken.name, processed: true })]);
    } finally {
      goalLock.release();
      if (!settled) process.emit('SIGINT');
      await running;
    }
  });

  it.each(['run', 'watch'] as const)('stops waiting for an unreadable goal claim on SIGINT in direct %s', async (mode) => {
    disableAutoRun();
    const broken = addGoalTask('unreadable goal work');
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name === broken.name
      ? { ...task, content: undefined, content_file: 'missing-instruction.md' } : task) }));
    const goalRoot = join(cwd, '.takt', 'goals', goalId);
    const goalLock = acquireProjectExecutionLock(goalRoot, 'run');
    const running = mode === 'run' ? runAllTasks(cwd, { provider: 'mock' }) : watchTasks(cwd, { provider: 'mock' });
    let settled = false;
    void running.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(runner.listTaskStateItems()[0]?.status).toBe('failed'));
      process.emit('SIGINT');
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(getProjectExecutionOwner(goalRoot)?.ownerId).toBe(goalLock.owner.ownerId);
      expect(getProjectExecutionOwner(cwd)).toBeUndefined();
      expect(managerCall).not.toHaveBeenCalled();
      expect(runner.listTaskStateItems()[0]?.completion).toBeDefined();
    } finally {
      goalLock.release();
      await running;
    }
  });

  it.each([true, false].flatMap((goalTasksOnly) => [true, false].map((brokenFirst) => ({ goalTasksOnly, brokenFirst }))))('executes readable work at concurrency two and fails an unreadable claim without leaving running tasks: %j', async ({ goalTasksOnly, brokenFirst }) => {
    runner = new TaskRunner(cwd, { goalTasksOnly });
    const first = addGoalTask('first queued task');
    const second = addGoalTask('second queued task');
    const broken = brokenFirst ? first : second;
    const readable = brokenFirst ? second : first;
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name === broken.name
      ? { ...task, content: undefined, content_file: 'missing-instruction.md' } : task) }));
    setMockScenario([{ persona: 'coder', status: 'done', content: 'readable work completed' }]);
    const lock = acquireProjectExecutionLock(cwd, 'run');
    try {
      const claimed = runner.claimNextTasks(2);
      expect(claimed.map((task) => task.name)).toEqual([readable.name]);
      expect(claimed[0]!.status).toBe('running');
      expect(await runWithWorkerPool(runner, claimed, 2, cwd, { provider: 'mock' }, undefined, 100, 'run', {
        schedulingSignal: scheduling.signal, taskAbortSignal: taskAbort.signal,
      })).toMatchObject({ success: 1, fail: 0, executedTaskNames: [readable.name] });
      const saved = new TaskStore(cwd).read().tasks;
      expect(saved.find((task) => task.name === readable.name)).toMatchObject({ status: 'completed', owner_pid: null });
      expect(saved.find((task) => task.name === broken.name)).toMatchObject({
        status: 'failed', owner_pid: null, failure: { error: expect.any(String) },
        run_slug: expect.any(String), completion: { success: false, interrupted: false, workflowResult: 'error' },
      });
      expect(saved.some((task) => task.status === 'running')).toBe(false);
      expect(savedGoal().events).toEqual(expect.arrayContaining([
        expect.objectContaining({ taskName: broken.name, processed: true, result: expect.objectContaining({ success: false }) }),
        expect.objectContaining({ taskName: readable.name, processed: true, result: expect.objectContaining({ success: true }) }),
      ]));
    } finally { lock.release(); }
  });

  it.each([true, false])('propagates an ordinary read failure and leaves a mixed batch pending with goalFirst=%s', async (goalFirst) => {
    const addOrdinary = () => runner.addTask('ordinary work', { workflow: 'loop-fixture', worktree: false });
    const first = goalFirst ? addGoalTask('goal work') : addOrdinary();
    const second = goalFirst ? addOrdinary() : addGoalTask('goal work');
    const ordinary = goalFirst ? second : first;
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name === ordinary.name
      ? { ...task, content: undefined, content_file: 'missing-order.md' } : task) }));
    const saved = readFileSync(runner.getTasksFilePath());
    expect(() => runner.claimNextTasks(2)).toThrow();
    expect(readFileSync(runner.getTasksFilePath())).toEqual(saved);
    expect(runner.listTaskStateItems()).toEqual([
      expect.objectContaining({ name: first.name, status: 'pending' }),
      expect.objectContaining({ name: second.name, status: 'pending' }),
    ]);
    expect(managerCall).not.toHaveBeenCalled();
  });

  it.each(['run', 'watch'] as const)('propagates a sole ordinary read failure through %s', async (mode) => {
    const ordinary = runner.addTask('ordinary work', { workflow: 'loop-fixture', worktree: false });
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name === ordinary.name
      ? { ...task, content: undefined, content_file: 'missing-order.md' } : task) }));
    const saved = readFileSync(runner.getTasksFilePath());
    const execute = mode === 'run' ? runAllTasks : watchTasks;
    await expect(execute(cwd)).rejects.toThrow();
    expect(readFileSync(runner.getTasksFilePath())).toEqual(saved);
    expect(runner.listTaskStateItems()[0]).toMatchObject({ name: ordinary.name, status: 'pending' });
    expect(managerCall).not.toHaveBeenCalled();
  });

  it.each(['run', 'watch'] as const)('settles already claimed goal work before propagating a later ordinary read failure in %s', async (mode) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nconcurrency: 2\nauto_requeue_max_attempts: 0\ntask_poll_interval_ms: 100\n');
    const readable = addGoalTask('readable goal work');
    const broken = addGoalTask('unreadable goal work');
    let ordinaryName: string | undefined;
    new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name !== broken.name
      ? task : { ...task, content: undefined, content_file: 'missing-order.md' }) }));
    managerCall.mockImplementation(async () => {
      if (ordinaryName === undefined) {
        ordinaryName = runner.addTask('ordinary work', { workflow: 'loop-fixture', worktree: false }).name;
        new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name !== ordinaryName
          ? task : { ...task, content: undefined, content_file: 'missing-order.md' }) }));
      }
      return managerReply('成果を確認しました', 'goal-session');
    });
    setMockScenario([{ persona: 'coder', status: 'done', content: 'goal work completed' }]);
    const execute = mode === 'run' ? runAllTasks : watchTasks;
    await expect(execute(cwd)).rejects.toThrow();
    expect(runner.listTaskStateItems()).toEqual([
      expect.objectContaining({ name: readable.name, status: 'completed' }),
      expect.objectContaining({ name: broken.name, status: 'failed', completion: expect.objectContaining({ success: false }) }),
      expect.objectContaining({ name: ordinaryName, status: 'pending' }),
    ]);
    expect(savedGoal().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskName: readable.name, processed: true }),
      expect.objectContaining({ taskName: broken.name, processed: true }),
    ]));
  });

  async function runPool(mode: 'run' | 'watch' = 'run', stopAfterManagerCalls = 1) {
    if (mode === 'watch') {
      const original = managerCall.getMockImplementation()!;
      managerCall.mockImplementation(async (...args) => {
        try { return await original(...args); }
        finally { if (managerCall.mock.calls.length >= stopAfterManagerCalls) scheduling.abort(); }
      });
    }
    const lock = acquireProjectExecutionLock(cwd, mode);
    try {
      return await runWithWorkerPool(
        runner, runner.claimNextTasks(1), 1, cwd, { provider: 'mock' }, undefined, 100, mode,
        { schedulingSignal: scheduling.signal, taskAbortSignal: taskAbort.signal },
      );
    } finally {
      lock.release();
    }
  }

  it.each(['run', 'watch'] as const)('calls the goal manager only after saving the task result in %s mode', async (mode) => {
    const task = addGoalTask('first completed task');
    const observedStatuses: string[] = [];
    managerCall.mockImplementation(async () => {
      observedStatuses.push(new TaskRunner(cwd).listAllTaskItems().find(({ name }) => name === task.name)!.kind);
      const events = savedGoal().events;
      expect(events).toEqual([expect.objectContaining({ taskName: task.name, processed: false })]);
      return managerReply('成果を確認しました', 'goal-session');
    });
    setMockScenario([{ persona: 'coder', status: 'done', content: 'work completed' }]);

    const running = runPool(mode);
    try {
      // watch は未実装の通知を待ち続けるので、テストの待機上限を設ける。
      await vi.waitFor(() => expect(managerCall).toHaveBeenCalledTimes(1), { timeout: 15000 });
      await running;
      expect(observedStatuses).toEqual(['completed']);
      expect(savedGoal().events).toEqual([expect.objectContaining({ taskName: task.name, processed: true })]);
    } finally {
      scheduling.abort();
      await running;
    }
  });

  it('keeps separate completion events for different task runs in the same goal', async () => {
    const first = addGoalTask('task-a');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'first result' }]);
    await runPool();
    const previous = savedGoal().events;
    expect(previous).toHaveLength(1);
    const firstSha = git(cwd, ['rev-parse', 'HEAD']);
    const nextSha = git(cwd, ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'later task progress']);
    git(cwd, ['update-ref', 'refs/heads/main', nextSha]);
    const second = addGoalTask('task-b');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'second result' }]);

    await runPool();

    const events = savedGoal().events;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(previous[0]);
    expect(events.map(({ taskName }) => taskName)).toEqual([first.name, second.name]);
    expect(new Set(events.map(({ runSlug }) => runSlug)).size).toBe(2);
    for (const event of events) {
      expect(event.runSlug).toEqual(expect.any(String));
      expect(event.runSlug.length).toBeGreaterThan(0);
      expect(event.result).toMatchObject({ success: true, interrupted: false });
      expect(event.result.branch).toBe(git(cwd, ['branch', '--show-current']));
    }
    expect(events.map(({ result }) => result.sha)).toEqual([firstSha, nextSha]);
  });

  it('processes parallel completions after a goal turn exceeds two minutes and runs its follow-up in the same run', async () => {
    disableAutoRun();
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nconcurrency: 2\n');
    const first = addGoalTask('first parallel work');
    const second = addGoalTask('second parallel work');
    let turnEntered!: () => void;
    let releaseTurn!: () => void;
    const entered = new Promise<void>((resolve) => { turnEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let followUp: string | undefined;
    managerCall.mockImplementation(async (prompt) => {
      const event = (JSON.parse(prompt) as { event: NonNullable<Goal['events']>[number] }).event;
      if (event.taskName === first.name) {
        expect(savedGoal().events.map(({ taskName }) => taskName)).toEqual([first.name]);
        turnEntered();
        await release;
      } else if (event.taskName === second.name) {
        expect(savedGoal().events.find(({ taskName }) => taskName === first.name)?.processed).toBe(true);
        followUp = addGoalTask('follow-up after parallel work').name;
      } else {
        expect(event.taskName).toBe(followUp);
      }
      return managerReply('結果を確認しました', 'parallel-session');
    });
    const setup = vi.mocked(MockProvider.prototype.setup).getMockImplementation()!;
    let coderCalls = 0;
    vi.mocked(MockProvider.prototype.setup).mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'coder') return agent;
      return { call: async (...args) => {
        if (++coderCalls === 2) await entered;
        return agent.call(...args);
      } };
    });
    const now = Date.now;
    let elapsed = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
    const acquire = executionLocks.acquireProjectExecutionLock;
    let conflicts = 0;
    vi.spyOn(executionLocks, 'acquireProjectExecutionLock').mockImplementation((root, kind) => {
      try { return acquire(root, kind); }
      catch (error) {
        if (root === join(cwd, '.takt', 'goals', goalId) && error instanceof executionLocks.ProjectExecutionAlreadyRunningError) {
          elapsed = 120_001;
          conflicts++;
        }
        throw error;
      }
    });
    setMockScenario([
      { persona: 'coder', status: 'done', content: 'first result' },
      { persona: 'coder', status: 'done', content: 'second result' },
      { persona: 'coder', status: 'done', content: 'follow-up result' },
    ]);
    const running = runAllTasks(cwd, { provider: 'mock' });
    const settled = vi.fn();
    void running.then(settled, settled);
    try {
      await vi.waitFor(() => expect(conflicts).toBeGreaterThanOrEqual(2), { timeout: 60000 });
      expect(elapsed).toBeGreaterThan(120_000);
      expect(runner.listTaskStateItems().find(({ name }) => name === second.name)).toMatchObject({
        status: 'completed', runSlug: expect.any(String), completion: { success: true, interrupted: false },
      });
      expect(savedGoal().events.map(({ taskName }) => taskName)).toEqual([first.name]);
      expect(managerCall).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();
      expect(readManagerRunFailures(cwd)).toEqual([]);
      releaseTurn();
      await running;
      expect(managerCall).toHaveBeenCalledTimes(3);
      expect(savedGoal().events).toEqual([
        expect.objectContaining({ taskName: first.name, processed: true }),
        expect.objectContaining({ taskName: second.name, processed: true }),
        expect.objectContaining({ taskName: followUp, processed: true }),
      ]);
      expect(runner.listTaskStateItems().find(({ name }) => name === followUp)?.status).toBe('completed');
      expect(readManagerRunFailures(cwd)).toEqual([]);
    } finally {
      turnEntered();
      releaseTurn();
      await running;
      clock.mockRestore();
    }
  });

  it('records a workflow failure with its reason instead of marking it as an interruption', async () => {
    const path = join(cwd, '.takt', 'workflows', 'loop-fixture.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('next: COMPLETE', 'next: ABORT'));
    const task = addGoalTask('workflow failure');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'cannot complete this work' }]);
    managerCall.mockImplementation(async () => {
      expect(new TaskRunner(cwd).listAllTaskItems().find(({ name }) => name === task.name)?.kind).toBe('failed');
      expect(savedGoal().events[0]!.result).toMatchObject({ success: false, interrupted: false });
      expect(savedGoal().events[0]!.result.failureReason).toEqual(expect.any(String));
      expect(savedGoal().events[0]!.result.failureReason!.length).toBeGreaterThan(0);
      return managerReply('失敗の方針を判断しました', 'goal-session');
    });

    expect(await runPool()).toMatchObject({ success: 0, fail: 1 });

    expect(managerCall).toHaveBeenCalledTimes(1);
    expect(savedGoal().events[0]!.processed).toBe(true);
  });

  it('records task interruption separately from an ordinary workflow failure', async () => {
    addGoalTask('interrupted task');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'waiting for interruption', waitForAbort: true }]);
    let entered = false;
    const setup = vi.mocked(MockProvider.prototype.setup).getMockImplementation()!;
    vi.mocked(MockProvider.prototype.setup).mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      return config.name !== 'coder' ? agent : { call: (...args) => { entered = true; return agent.call(...args); } };
    });
    const running = runPool();
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2000 });
      taskAbort.abort();
      expect(await running).toMatchObject({ success: 0, fail: 1 });
      expect(managerCall).toHaveBeenCalledTimes(1);
      expect(savedGoal().events[0]!.result).toMatchObject({ success: false, interrupted: true });
    } finally {
      taskAbort.abort();
      await running;
    }
  });

  it('records the workflow iteration limit as a failure rather than an interruption', async () => {
    const path = join(cwd, '.takt', 'workflows', 'loop-fixture.yaml');
    writeFileSync(path, readFileSync(path, 'utf8').replace('next: COMPLETE', 'next: work'));
    addGoalTask('task exceeding the workflow iteration limit');
    setMockScenario([
      { persona: 'coder', status: 'done', content: 'first iteration' },
      { persona: 'coder', status: 'done', content: 'second iteration' },
    ]);

    expect(await runPool()).toMatchObject({ success: 0, fail: 1 });

    expect(managerCall).toHaveBeenCalledTimes(1);
    expect(savedGoal().events[0]!.result).toMatchObject({ success: false, interrupted: false });
    expect(savedGoal().events[0]!.result.failureReason).toEqual(expect.any(String));
    expect(savedGoal().events[0]!.result.failureReason!.length).toBeGreaterThan(0);
  });

  it('records an execution setup failure without inventing a result SHA', async () => {
    const options = { workflow: 'missing-workflow', worktree: false, goal_id: goalId };
    runner.addTask('task with unavailable workflow', options);

    expect(await runPool()).toMatchObject({ success: 0, fail: 1 });

    expect(managerCall).toHaveBeenCalledTimes(1);
    expect(savedGoal().events[0]!.result).toMatchObject({ success: false, interrupted: false });
    expect(savedGoal().events[0]!.result.sha).toBeUndefined();
    expect(savedGoal().events[0]!.result.failureReason).toEqual(expect.any(String));
  });

  it.each([
    { failedUpdate: 1, recovery: 'direct' }, { failedUpdate: 2, recovery: 'direct' },
    { failedUpdate: 1, recovery: 'MCP' }, { failedUpdate: 2, recovery: 'MCP' },
    { failedUpdate: 1, recovery: 'TUI' }, { failedUpdate: 2, recovery: 'TUI' },
  ] as const)('persists and delivers the selected run after a running update fails: %j', async ({ failedUpdate, recovery }) => {
    const task = addGoalTask('running persistence failure');
    const update = TaskRunner.prototype.updateRunningTaskExecution;
    let calls = 0;
    let selectedRun: string | undefined;
    vi.spyOn(TaskRunner.prototype, 'updateRunningTaskExecution').mockImplementation(function (this: TaskRunner, name, execution) {
      if (name === task.name && ++calls === failedUpdate) {
        selectedRun = execution.runSlug;
        throw new Error('injected running persistence failure');
      }
      return update.call(this, name, execution);
    });
    if (recovery !== 'direct') managerCall.mockRejectedValueOnce(new Error('injected manager delivery failure'));
    expect(await runPool()).toMatchObject({ success: 0, fail: 1 });
    expect(selectedRun).toEqual(failedUpdate === 1 ? expect.stringMatching(/^setup-/) : expect.any(String));
    if (failedUpdate === 2) expect(selectedRun).not.toMatch(/^setup-/);
    const saved = new TaskStore(cwd).read().tasks.find(({ name }) => name === task.name)!;
    expect(saved).toMatchObject({ status: 'failed', run_slug: selectedRun, completion: {
      success: false, interrupted: false, failureReason: 'injected running persistence failure',
    } });
    const completion = { taskName: task.name, runSlug: selectedRun!, result: saved.completion! };
    expect(savedGoal().events).toEqual([expect.objectContaining({ ...completion, processed: recovery === 'direct' })]);
    expect(JSON.parse(managerCall.mock.calls[0]![0]) as unknown).toMatchObject({ event: completion });

    if (recovery === 'MCP') {
      const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
      const client = new Client({ name: 'run-persistence-recovery', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport); await client.connect(clientTransport);
        const result = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
        expect(result.isError).toBeUndefined();
        await vi.waitFor(() => expect(savedGoal().events[0]!.processed).toBe(true));
      } finally { await client.close(); await server.close(); }
    } else if (recovery === 'TUI') {
      const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
      vi.mocked(mountInk<void>).mockResolvedValue(undefined);
      try { await runManager({ cwd }); }
      finally {
        if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
        else Reflect.deleteProperty(process.stdin, 'isTTY');
        if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
        else Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }
    expect(managerCall).toHaveBeenCalledTimes(recovery === 'direct' ? 1 : 2);
    for (const [prompt] of managerCall.mock.calls) expect(JSON.parse(prompt) as unknown).toMatchObject({ event: completion });
    expect(savedGoal().events).toEqual([expect.objectContaining({ ...completion, processed: true })]);
  });
  it('preserves the workflow outcome and result SHA when post execution fails', async () => {
    const task = runner.addTask('post execution failure', { workflow: 'loop-fixture', worktree: join(cwd, 'post-clone'), goal_id: goalId });
    vi.spyOn(postExecution, 'postExecutionFlow').mockResolvedValueOnce({ taskFailed: true, taskError: 'injected commit failure' });
    setMockScenario([{ persona: 'coder', status: 'done', content: 'workflow completed' }]);
    expect(await runPool()).toMatchObject({ success: 0, fail: 1 });
    const event = savedGoal().events[0]!;
    expect(event).toMatchObject({ taskName: task.name, processed: true, result: { success: false, interrupted: false, workflowResult: 'completed', failureReason: 'injected commit failure' } });
    expect(event.result.sha).toBe(git(cwd, ['rev-parse', 'HEAD']));
  });

  it('keeps a failed manager event pending and recovers the same event through a later MCP operation', async () => {
    const task = addGoalTask('task-a');
    managerCall.mockRejectedValueOnce(new Error('injected manager failure'));
    setMockScenario([{ persona: 'coder', status: 'done', content: 'completed before manager failed' }]);

    const result = await runPool();

    expect(result).toMatchObject({ success: 1, fail: 0 });
    const pending = savedGoal().events;
    expect(pending).toEqual([expect.objectContaining({ taskName: task.name, processed: false })]);
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    const client = new Client({ name: 'manager-recovery-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      await vi.waitFor(() => expect(savedGoal().events[0]!.processed).toBe(true));
    } finally {
      await client.close();
      await server.close();
    }
    const recovered = savedGoal().events;
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ taskName: pending[0]!.taskName, runSlug: pending[0]!.runSlug, processed: true });
    expect(recovered[0]!.result).toEqual(pending[0]!.result);
  });

  it('preserves a completion published while its manager waits even when the task is manually requeued', async () => {
    const workflowPath = join(cwd, '.takt', 'workflows', 'loop-fixture.yaml');
    writeFileSync(workflowPath, readFileSync(workflowPath, 'utf8').replace('next: COMPLETE', 'next: ABORT'));
    const task = addGoalTask('failed task requeued while manager waits');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'saved failed attempt' }]);
    let releaseTurn!: () => void;
    let turnEntered!: () => void;
    const release = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const entered = new Promise<void>((resolve) => { turnEntered = resolve; });
    const owner = withGoalTurns(cwd, [goalId], async () => { turnEntered(); await release; });
    await entered;
    const execution = runPool();
    void execution.catch(() => {});
    try {
      await vi.waitFor(() => expect(runner.listAllTaskItems()[0]!.kind).toBe('failed'), { timeout: 20000 });
      expect(savedGoal().events ?? []).toEqual([]);
      const savedTask = runner.listTaskStateItems()[0]!;
      const event = { taskName: task.name, runSlug: savedTask.runSlug!, result: savedTask.completion!, processed: false };
      expect(event).toMatchObject({ taskName: task.name, processed: false, result: { success: false, interrupted: false } });
      expect(managerCall).not.toHaveBeenCalled();
      runner.requeueFailedTask(task.name);
      expect(runner.listTaskStateItems()[0]!.completion).toBeUndefined();
      scheduling.abort();
      releaseTurn();
      await owner;
      expect(await execution).toMatchObject({ success: 0, fail: 1 });
      expect(savedGoal().events).toEqual([{ ...event, processed: true, summary: '成果を確認しました' }]);
      expect(runner.listPendingTaskItems().map(({ name }) => name)).toEqual([task.name]);
    } finally {
      scheduling.abort();
      releaseTurn();
      await Promise.allSettled([owner, execution]);
    }
  }, 60000);

  it('recovers a saved pending completion in a fresh process without changing its result or duplicating the event', async () => {
    const task = addGoalTask('completion awaiting a fresh process');
    managerCall.mockRejectedValueOnce(new Error('injected manager failure before restart'));
    setMockScenario([{ persona: 'coder', status: 'done', content: 'persisted workflow result' }]);
    await runPool();
    const pending = savedGoal().events;
    expect(pending).toEqual([expect.objectContaining({ taskName: task.name, processed: false })]);
    const source = `
import { recoverManagerEvents } from ${JSON.stringify(new URL('../features/manager/completionTurn.ts', import.meta.url).href)};
import { setMockScenario } from ${JSON.stringify(new URL('../infra/mock/index.ts', import.meta.url).href)};
setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: '別プロセスで保存済みの成果を確認しました', summary: null }) }]);
await recoverManagerEvents(process.cwd());
console.log(process.pid);
`;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd, env: { ...process.env }, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output.trim()).toMatch(/^\d+$/);
    expect(Number(output.trim())).not.toBe(process.pid);
    const recovered = savedGoal().events;
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ taskName: pending[0]!.taskName, runSlug: pending[0]!.runSlug, processed: true });
    expect(recovered[0]!.result).toEqual(pending[0]!.result);
  });

  it('recovers a persisted task result through TUI startup when no event was saved', async () => {
    const result = { success: true, interrupted: false, sha: 'saved-sha' };
    const name = saveCompletedFixture('tui-recovery', 'tui-run', goalId, result);
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.mocked(mountInk<void>).mockResolvedValue(undefined);
    try {
      await runManager({ cwd });
      expect(managerCall).toHaveBeenCalledTimes(1);
      const context = JSON.parse(managerCall.mock.calls[0]![0]) as { event: { result: GoalTaskResult } };
      expect(context.event.result).toEqual(result);
      expect(savedGoal().events).toEqual([expect.objectContaining({ result, processed: true })]);
      expect(runner.listTaskStateItems().find((task) => task.name === name)?.completion).toEqual(result);
      expect(runner.listPendingTaskItems()).toEqual([]);
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('recovers a pending completion event on the next manager startup without duplicating it', async () => {
    const task = addGoalTask('task awaiting manager startup');
    managerCall.mockRejectedValueOnce(new Error('injected completion turn failure'));
    setMockScenario([{ persona: 'coder', status: 'done', content: 'saved task result' }]);
    await runPool();
    const pending = savedGoal().events;
    expect(pending).toEqual([expect.objectContaining({ taskName: task.name, processed: false })]);
    const scenario = join(cwd, 'recovery-scenario.json');
    writeFileSync(scenario, JSON.stringify([{
      persona: 'manager', status: 'done',
      content: JSON.stringify({ message: '保存済みの終了を処理しました', summary: null }),
    }]));
    vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.mocked(mountInk<void>).mockImplementation(async () => {
      await vi.waitFor(() => expect(savedGoal().events[0]!.processed).toBe(true), { timeout: 3000 });
    });
    try {
      await runManager({ cwd });
      expect(mountInk).toHaveBeenCalledTimes(1);
      const recovered = savedGoal().events;
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ taskName: pending[0]!.taskName, runSlug: pending[0]!.runSlug, processed: true });
      expect(recovered[0]!.result).toEqual(pending[0]!.result);
    } finally {
      vi.unstubAllEnvs();
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it('resumes the goal session across turns without using the conversation session', async () => {
    const confirmation = createGoalConfirmation(cwd);
    const session = createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}), confirmation,
      mcpClient: { callTool: vi.fn() },
    });
    managerCall.mockResolvedValueOnce(managerReply('人との会話', 'human-session'));
    try {
      await session.handleUserMessage({ text: '既存ゴールを確認してください' });
      addGoalTask('first task');
      setMockScenario([{ persona: 'coder', status: 'done', content: 'first result' }]);
      await runPool();
      addGoalTask('second task');
      setMockScenario([{ persona: 'coder', status: 'done', content: 'second result' }]);
      await runPool();
      expect(managerCall).toHaveBeenCalledTimes(3);
      expect(managerCall.mock.calls[1]![1].sessionId).toBeUndefined();
      expect(managerCall.mock.calls[2]![1].sessionId).toBe('goal-session');
      for (const [, options] of managerCall.mock.calls.slice(1)) {
        expect(options.permissionMode).toBe('readonly');
        expect(options.mcpOnlySideEffects).toEqual(options.allowedTools);
        expect(options.allowedTools).not.toContain('Bash');
      }
    } finally {
      await session.close();
    }
  });

  it('keeps independent provider sessions for two goals across interleaved completions', async () => {
    const otherId = '750e8400-e29b-41d4-a716-446655440002';
    await registerFixtureGoal(cwd, { id: otherId });
    managerCall.mockResolvedValueOnce(managerReply('最初のゴール', 'first-goal-session'));
    addGoalTask('first goal task');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'first goal result' }]);
    await runPool();
    const options = { workflow: 'loop-fixture', worktree: false, goal_id: otherId };
    runner.addTask('other goal task', options);
    managerCall.mockResolvedValueOnce(managerReply('別のゴール', 'other-goal-session'));
    setMockScenario([{ persona: 'coder', status: 'done', content: 'other goal result' }]);
    await runPool();
    addGoalTask('first goal next task');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'first goal next result' }]);

    await runPool();

    expect(managerCall).toHaveBeenCalledTimes(3);
    expect(managerCall.mock.calls[0]![1].sessionId).toBeUndefined();
    expect(managerCall.mock.calls[1]![1].sessionId).toBeUndefined();
    expect(managerCall.mock.calls[2]![1].sessionId).toBe('first-goal-session');
  });

  it('keeps the saved goal session when a later provider response has no session ID', async () => {
    addGoalTask('first session task');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'first result' }]);
    await runPool();
    managerCall.mockResolvedValueOnce({
      persona: 'manager', status: 'done', timestamp: new Date('2026-10-06T00:00:00Z'),
      content: JSON.stringify({ message: '既存のセッションを維持します', summary: null }),
    });
    addGoalTask('second session task');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'second result' }]);
    await runPool();
    addGoalTask('third session task');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'third result' }]);

    await runPool();

    expect(managerCall).toHaveBeenCalledTimes(3);
    expect(managerCall.mock.calls[1]![1].sessionId).toBe('goal-session');
    expect(managerCall.mock.calls[2]![1].sessionId).toBe('goal-session');
  });

  it('rebuilds the completion turn from the saved goal and earlier task events', async () => {
    const first = addGoalTask('earlier completed work');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'first result' }]);
    await runPool();
    const second = addGoalTask('new completed work');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'second result' }]);

    await runPool();

    expect(managerCall).toHaveBeenCalledTimes(2);
    const prompt = managerCall.mock.calls[1]![0];
    expect(prompt).toContain(goalRecord().objective);
    expect(prompt).toContain(goalRecord().acceptanceCriteria[0]!);
    expect(prompt).toContain(first.name);
    expect(prompt).toContain(second.name);
    for (const event of savedGoal().events) expect(prompt).toContain(event.runSlug);
  });

  it('allows independent conversations without locking all existing goals', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maxActive = 0;
    managerCall.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      try { await gate; return managerReply('状態を確認しました', 'human-session'); }
      finally { active--; }
    });
    const sessions = Array.from({ length: 2 }, () => createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}),
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    }));
    const turns = sessions.map((session) => session.handleUserMessage({ text: '同じゴールを確認してください' }));
    try {
      await vi.waitFor(() => expect(managerCall.mock.calls.length).toBe(2));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(managerCall).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await Promise.all(turns);
      await Promise.all(sessions.map((session) => session.close()));
    }
    expect((await Promise.all(turns)).map(({ kind }) => kind)).toEqual(['reply', 'reply']);
    expect(maxActive).toBe(2);
    expect(managerCall).toHaveBeenCalledTimes(2);
  });

  it('allows a completion turn to enqueue through its separate MCP process without waiting on its own goal lock', async () => {
    addGoalTask('first task');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'first task complete' }]);
    managerCall.mockImplementation(async (_prompt, options) => {
      const server = Object.values(options.mcpServers ?? {}).find((server) => server.type === 'stdio');
      if (server?.type !== 'stdio') throw new Error('Completion manager must receive its MCP server');
      const client = new Client({ name: 'completion-mcp-test', version: '1.0.0' });
      const env = Object.fromEntries(Object.entries({ ...process.env, ...server.env })
        .filter((entry): entry is [string, string] => entry[1] !== undefined));
      const transport = new StdioClientTransport({ command: server.command, args: server.args, env, cwd });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
          cwd, goalId, workflow: 'loop-fixture', task: 'Implement next validation', purpose: '次の検証を追加する',
        } }, undefined, { timeout: 15000 });
        expect(result.isError).toBeUndefined();
        expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(1);
        scheduling.abort();
        return managerReply('別プロセスから次の作業を保存しました', 'goal-session');
      } finally {
        await client.close();
        await transport.close();
      }
    });

    expect(await runPool()).toMatchObject({ success: 1, fail: 0 });

    expect(managerCall).toHaveBeenCalledTimes(1);
    expect(savedGoal().events[0]!.processed).toBe(true);
    expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(1);
  });

  it.each(['run', 'watch'] as const)('waits for the manager turn and executes the task it adds in the same %s pool', async (mode) => {
    addGoalTask('first task');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    managerCall.mockImplementation(async () => {
      if (managerCall.mock.calls.length === 1) {
        await gate;
        addGoalTask('next task');
      }
      return managerReply('次の作業を投入しました', 'goal-session');
    });
    setMockScenario([
      { persona: 'coder', status: 'done', content: 'first result' },
      { persona: 'coder', status: 'done', content: 'next result' },
    ]);
    let settled = false;
    const running = runPool(mode, 2).then((result) => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(managerCall).toHaveBeenCalledTimes(1), { timeout: 15000 });
      expect(settled).toBe(false);
      expect(runner.listAllTaskItems().map(({ kind }) => kind)).toEqual(['completed']);
    } finally {
      release();
      if (!managerCall.mock.calls.length) scheduling.abort();
      await running;
    }
    expect(runner.listAllTaskItems().map(({ kind }) => kind)).toEqual(['completed', 'completed']);
    expect(managerCall).toHaveBeenCalledTimes(2);
    expect(await running).toMatchObject({ success: mode === 'run' ? 2 : 0, fail: 0 });
  });

  it('does not call a goal manager for an ordinary task', async () => {
    runner.addTask('ordinary task', { workflow: 'loop-fixture', worktree: false });
    setMockScenario([{ persona: 'coder', status: 'done', content: 'ordinary result' }]);

    expect(await runPool()).toMatchObject({ success: 1, fail: 0 });

    expect(managerCall).not.toHaveBeenCalled();
  });

  it('restarts pending work through MCP after the execution owner exits before claiming a task', async () => {
    const task = runner.addTask('work after owner exit', { workflow: 'loop-fixture', worktree: false, goal_id: goalId });
    const source = `
import { acquireProjectExecutionLock } from ${JSON.stringify(new URL('../infra/task/project-execution-lock.ts', import.meta.url).href)};
acquireProjectExecutionLock(process.cwd(), 'run');
process.exit(23);
`;
    const child = trackProcess(childProcess.spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    let errors = '';
    child.stderr!.on('data', (chunk) => { errors += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect({ code, errors }).toEqual({ code: 23, errors: '' });
    expect(runner.listPendingTaskItems().map(({ name }) => name)).toEqual([task.name]);
    expect(isProcessAlive(process.pid)).toBe(true);
    const scenario = join(cwd, 'owner-recovery-scenario.json');
    writeFileSync(scenario, JSON.stringify([
      { persona: 'coder', status: 'done', content: 'recovered work completed' },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: 'recovered goal work completed', summary: null }) },
    ]));
    vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
    const spawn = observeSpawn();
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    const client = new Client({ name: 'execution-owner-recovery', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } });
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toHaveLength(1);
      await vi.waitFor(() => expect(runner.listTaskStateItems()[0]).toMatchObject({ name: task.name, status: 'completed' }), { timeout: 15000 });
    } finally { await client.close(); await server.close(); await stopOwnedProcesses(); }
  }, 60000);

  it.each([
    { mode: 'run', ordinary: 'existing' },
    { mode: 'run', ordinary: 'late' },
    { mode: 'run', ordinary: 'none' },
    { mode: 'watch', ordinary: 'existing' },
    { mode: 'watch', ordinary: 'late' },
    { mode: 'watch', ordinary: 'none' },
  ] as const)('starts $mode independently of startup recovery and drains its follow-up work (ordinary: $ordinary)', async ({ mode, ordinary }) => {
    disableAutoRun();
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{
      taskName: 'saved', runSlug: 'saved-run', processed: false, result: { success: true, interrupted: false },
    }] }));
    let task = ordinary === 'existing' ? runner.addTask('ordinary task during recovery', { workflow: 'loop-fixture', worktree: false }) : undefined;
    const claim = vi.spyOn(TaskRunner.prototype, 'claimNextTasks');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    managerCall.mockImplementation(async (prompt) => {
      const event = (JSON.parse(prompt) as { event: NonNullable<Goal['events']>[number] }).event;
      if (event.taskName === 'saved') {
        await gate;
        addGoalTask('recovery follow-up');
      } else if (mode === 'watch') process.emit('SIGINT');
      return managerReply('回収後の作業を判断しました', 'recovery-session');
    });
    setMockScenario([
      ...(ordinary !== 'none' ? [{ persona: 'coder', status: 'done' as const, content: 'ordinary result' }] : []),
      { persona: 'coder', status: 'done', content: 'recovery follow-up result' },
    ]);
    let settled = false;
    const execute = mode === 'run' ? runAllTasks : watchTasks;
    const running = execute(cwd, { provider: 'mock' }).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(managerCall).toHaveBeenCalledTimes(1), { timeout: 15000 });
      if (ordinary === 'late') task = runner.addTask('ordinary task added during recovery', { workflow: 'loop-fixture', worktree: false });
      if (task !== undefined) {
        const taskName = task.name;
        await vi.waitFor(() => expect(runner.listTaskStateItems().find(({ name }) => name === taskName)?.status).toBe('completed'), { timeout: 15000 });
      } else if (mode === 'watch') {
        await vi.waitFor(() => expect(claim).toHaveBeenCalled());
      }
      expect(settled).toBe(false);
      expect(getProjectExecutionOwner(cwd)?.kind).toBe(mode);
      expect(savedGoal().events[0]!.processed).toBe(false);
    } finally {
      release();
      await running;
    }
    expect(managerCall).toHaveBeenCalledTimes(2);
    expect(runner.listTaskStateItems().map(({ status }) => status)).toEqual(ordinary !== 'none' ? ['completed', 'completed'] : ['completed']);
    expect(savedGoal().events.every(({ processed }) => processed)).toBe(true);
    expect(getProjectExecutionOwner(cwd)).toBeUndefined();
  });

  it('shows healthy summaries, startup failures and corrupt goal diagnostics once across successive messages', async () => {
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{
      taskName: 'saved', runSlug: 'run', processed: true, summary: '保存された正常な要約', result: { success: true, interrupted: false },
    }] }));
    const corrupt = join(cwd, '.takt', 'goals', newId);
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'goal.json'), '{');
    recordManagerRunFailure(cwd, new Error('保存された起動失敗'));
    const session = createManagerConversationSession({ cwd, plan: createManagerConversationPlan(cwd, {}), confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() } });
    const app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain('保存された正常な要約');
        expect(app.lastFrame()).toContain('保存された起動失敗');
        expect(app.lastFrame()).toContain(newId);
      });
      const diagnosticOccurrences = app.lastFrame()!.split(newId).length;
      await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [...goal.events!, {
        taskName: 'next', runSlug: 'next-run', processed: true, summary: '次の保存要約', result: { success: true, interrupted: false },
      }] }));
      app.stdin.write('状態を確認');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('状態を確認'));
      app.stdin.write('\r');
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain('次の保存要約');
        expect(app.lastFrame()!.split('保存された正常な要約')).toHaveLength(2);
        expect(app.lastFrame()!.split('保存された起動失敗')).toHaveLength(2);
        expect(app.lastFrame()!.split(newId)).toHaveLength(diagnosticOccurrences);
      });
      await vi.waitFor(() => {
        expect(managerCall).toHaveBeenCalledTimes(1);
        expect(app.lastFrame()).not.toContain('処理中');
      });
      app.stdin.write('もう一度確認');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('もう一度確認'));
      app.stdin.write('\r');
      await vi.waitFor(() => expect(managerCall).toHaveBeenCalledTimes(2));
      expect(app.lastFrame()!.split(newId)).toHaveLength(diagnosticOccurrences);
    } finally { app.unmount(); await session.close(); }
  });

  it.each(['success', 'persistent failure', 'temporary failure'] as const)('shows saved startup failures through runManager when goal listing has %s', async (condition) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nmanager:\n  auto_run: false\n');
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{
      taskName: 'saved', runSlug: 'run', processed: true, summary: '保存された正常な要約', result: { success: true, interrupted: false },
    }] }));
    recordManagerRunFailure(cwd, new Error('保存された起動失敗'));
    const task = runner.addTask('ordinary work with auto run disabled', { workflow: 'loop-fixture', worktree: false });
    let diagnostic: string | undefined;
    if (condition === 'persistent failure') {
      const goalsRoot = join(cwd, '.takt', 'goals');
      rmSync(goalsRoot, { recursive: true });
      writeFileSync(goalsRoot, 'not a directory');
      diagnostic = await new GoalStore(cwd).list().then(
        () => { throw new Error('Goal listing should reject a file in place of its directory'); },
        (error: Error) => error.message,
      );
    } else if (condition === 'temporary failure') {
      diagnostic = '一覧回収失敗';
      vi.spyOn(GoalStore.prototype, 'list').mockRejectedValueOnce(new Error(`${diagnostic}\x1b[?25l api_key=fixture-secret`));
    }
    const spawn = observeSpawn();
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.mocked(mountInk<void>).mockImplementationOnce(async (buildTree) => {
      const app = render(buildTree({ settle: vi.fn(), fail: vi.fn() }));
      try {
        await vi.waitFor(() => {
          const frame = app.lastFrame()!.replace(/\n/g, '');
          expect(frame).toContain('保存された起動失敗');
          if (condition !== 'persistent failure') expect(frame).toContain('保存された正常な要約');
          if (diagnostic !== undefined) expect(frame.replace(/\s/g, '')).toContain(diagnostic.replace(/\s/g, ''));
          if (condition === 'temporary failure') {
            expect(frame).toContain(`${diagnostic} api_key=[REDACTED]`);
            expect(frame).not.toContain('fixture-secret');
            expect(frame).not.toContain('\x1b');
          }
        });
      } finally { app.unmount(); }
    });
    try {
      await runManager({ cwd });
      expect(managerCall).not.toHaveBeenCalled();
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toEqual([]);
      expect(runner.listPendingTaskItems().map(({ name }) => name)).toEqual([task.name]);
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it.each([true, false])('recovers an event through MCP and runs its newly enqueued task after the parent exits (auto_run: %s)', async (autoRun) => {
    vi.restoreAllMocks();
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + `\nmanager:\n  auto_run: ${autoRun}\n`);
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), `provider: mock\nworktree_dir: ${join(cwd, 'completion-clones')}\n`);
    saveCompletedFixture('previous', 'previous-run');
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{ taskName: 'previous', runSlug: 'previous-run', processed: false, result: { success: true, interrupted: false } }] }));
    expect(getProjectExecutionOwner(cwd)).toBeUndefined();
    expect(runner.listTaskStateItems()).toEqual([expect.objectContaining({ name: 'previous', status: 'completed' })]);
    const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
    const scenario = join(cwd, 'completion-child-scenario.json');
    writeFileSync(scenario, JSON.stringify([
      { persona: 'coder', status: 'done', content: 'completed after parent', file_writes: [{ path: 'completion.txt', content: 'done' }] },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: 'child completion saved', summary: null }) },
    ]));
    const hook = join(cwd, 'completion-hook.mjs');
    writeFileSync(hook, `
${ownedProcessMarkerScript(moduleUrl('infra/task/process.js'))}
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockProvider } from ${JSON.stringify(moduleUrl('infra/providers/mock.js'))};
const setup = MockProvider.prototype.setup;
MockProvider.prototype.setup = function(config) {
  const agent = setup.call(this, config);
  return { call: async (...args) => {
    if (config.name === 'coder') {
      const root = process.env.TAKT_TEST_COMPLETION_ROOT;
      writeProcessMarker(join(root, 'completion-child-entered'));
      const deadline = Date.now() + 20000;
      while (!existsSync(join(root, 'release-completion-child'))) {
        if (Date.now() >= deadline) throw new Error('Completion child was not released');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    return agent.call(...args);
  } };
};
`);
    const source = `
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTaktMcpServer } from ${JSON.stringify(moduleUrl('features/mcp/server.js'))};
import { setMockScenario } from ${JSON.stringify(moduleUrl('infra/mock/index.js'))};
setMockScenario([{ persona: 'manager', status: 'done', content: JSON.stringify({ message: 'event work enqueued', summary: null }), mcpToolCalls: [{
  server: ${JSON.stringify(TAKT_MANAGER_MCP_SERVER_NAME)}, tool: 'takt_enqueue_goal_task',
  arguments: { cwd: process.cwd(), goalId: ${JSON.stringify(goalId)}, workflow: 'loop-fixture', task: 'Implement completion work', purpose: 'completion event work' },
}] }]);
const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: process.cwd() });
const client = new Client({ name: 'completion-parent', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport); await client.connect(clientTransport);
  const result = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd: process.cwd() } });
  if (result.isError) throw new Error(JSON.stringify(result));
} finally { await client.close(); await server.close(); }
`;
    const parent = trackProcess(childProcess.spawn(process.execPath, ['--input-type=module', '--eval', source], {
      cwd, stdio: ['ignore', 'ignore', 'pipe'], env: {
        ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`,
        TAKT_TEST_COMPLETION_ROOT: cwd, TAKT_MOCK_SCENARIO: scenario,
      },
    }));
    let errors = '';
    parent.stderr!.on('data', (chunk) => { errors += String(chunk); });
    const done = new Promise<void>((resolve, reject) => {
      parent.once('error', reject);
      parent.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors || `Parent exited: ${code}`)));
    });
    void done.catch(() => {});
    let childPid: number | undefined;
    try {
      await done;
      expect(parent.exitCode).toBe(0);
      expect((await new GoalStore(cwd).get(goalId)).events![0]).toMatchObject({ processed: true, summary: 'event work enqueued' });
      const tasks = runner.listTaskStateItems().filter((task) => task.name !== 'previous');
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.goalId).toBe(goalId);
      if (autoRun) {
        await vi.waitFor(() => expect(existsSync(join(cwd, 'completion-child-entered'))).toBe(true), { timeout: 15000 });
        childPid = readOwnedProcessMarker(readFileSync(join(cwd, 'completion-child-entered'), 'utf8')).pid;
        expect(isProcessAlive(childPid)).toBe(true);
        writeFileSync(join(cwd, 'release-completion-child'), 'parent has exited');
        await vi.waitFor(() => {
          const savedTask = runner.listTaskStateItems().find((task) => task.name !== 'previous');
          expect(savedTask, JSON.stringify(savedTask)).toMatchObject({ status: 'completed', completion: { success: true, interrupted: false } });
        }, { timeout: 15000 });
        await vi.waitFor(() => expect(savedGoal().events).toHaveLength(2), { timeout: 15000 });
        await vi.waitFor(() => expect(savedGoal().events[1]!.processed).toBe(true), { timeout: 15000 });
        await vi.waitFor(() => expect(isProcessAlive(childPid!)).toBe(false), { timeout: 15000 });
      } else {
        expect(tasks[0]!.status).toBe('pending');
        expect(existsSync(join(cwd, 'completion-child-entered'))).toBe(false);
        expect(getProjectExecutionOwner(cwd)).toBeUndefined();
      }
    } finally {
      writeFileSync(join(cwd, 'release-completion-child'), 'cleanup');
      await stopOwnedProcesses();
    }
  }, 60000);

  it('executes the next task enqueued by the native mock provider through real stdio MCP in the same pool', async () => {
    vi.restoreAllMocks();
    const globalDirectory = process.env.TAKT_CONFIG_DIR!;
    writeFileSync(join(globalDirectory, 'config.yaml'), `provider: mock\nworktree_dir: ${join(cwd, 'native-clones')}\n`);
    invalidateGlobalConfigCache();
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nmanager:\n  auto_run: false\n');
    addGoalTask('native first task');
    setMockScenario([
      { persona: 'coder', status: 'done', content: 'first result' },
      { persona: 'coder', status: 'done', content: 'second result' },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '次の検証を投入しました', summary: null }), mcpToolCalls: [{
        server: TAKT_MANAGER_MCP_SERVER_NAME, tool: 'takt_enqueue_goal_task',
        arguments: { cwd, goalId, workflow: 'loop-fixture', task: 'Native next task', purpose: 'native MCP の投入を確認する' },
      }] },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '次の検証が完了しました', summary: null }) },
    ]);
    expect(await runPool()).toMatchObject({ success: 2, fail: 0 });
    expect(new TaskRunner(cwd).listAllTaskItems().map(({ kind }) => kind)).toEqual(['completed', 'completed']);
    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved.workUnits).toEqual([expect.objectContaining({ purpose: 'native MCP の投入を確認する' })]);
    expect(saved.events!.map(({ processed }) => processed)).toEqual([true, true]);
  });

  it('allows a completion turn to finish while a conversation is waiting in another process', async () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nmanager:\n  auto_run: false\n');
    saveCompletedFixture('saved-task', 'saved-run');
    const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
    const source = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockProvider } from ${JSON.stringify(moduleUrl('../infra/providers/mock.ts'))};
import { createManagerConversationPlan } from ${JSON.stringify(moduleUrl('../features/manager/conversationPlan.ts'))};
import { createManagerConversationSession } from ${JSON.stringify(moduleUrl('../features/manager/conversationSession.ts'))};
import { createGoalConfirmation } from ${JSON.stringify(moduleUrl('../features/manager/goalConfirmation.ts'))};
import { processGoalCompletions } from ${JSON.stringify(moduleUrl('../features/manager/completionTurn.ts'))};
const cwd = process.cwd();
const role = process.env.TAKT_TEST_TURN_ROLE;
MockProvider.prototype.setup = () => ({ call: async () => {
  writeFileSync(join(cwd, role + '-entered'), 'entered');
  while (role === 'conversation' && !existsSync(join(cwd, 'release-turn'))) await new Promise(resolve => setTimeout(resolve, 20));
  return { persona: 'manager', status: 'done', content: JSON.stringify({ message: role, summary: null }), timestamp: new Date(), sessionId: role };
} });
writeFileSync(join(cwd, role + '-attempt'), 'attempt');
if (role === 'completion') await processGoalCompletions(cwd, ${JSON.stringify(goalId)}, {}, { taskName: 'saved-task', runSlug: 'saved-run', result: { success: true, interrupted: false } });
else {
  const session = createManagerConversationSession({ cwd, plan: createManagerConversationPlan(cwd, {}), confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: async () => { throw new Error('unused'); } } });
  try {
    const response = await session.handleUserMessage({ text: 'Review the saved goal' });
    if (response.kind !== 'reply') throw new Error(JSON.stringify(response));
  } finally { await session.close(); }
}
`;
    const launch = (role: string) => {
      const child = trackProcess(childProcess.spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], { cwd, env: { ...process.env, TAKT_TEST_TURN_ROLE: role }, stdio: ['ignore', 'pipe', 'pipe'] }));
      let errors = '';
      child.stderr!.on('data', (chunk) => { errors += String(chunk); });
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors || `Child failed: ${code}`)));
      });
      void done.catch(() => {});
      return done;
    };
    try {
      const conversation = launch('conversation');
      await vi.waitFor(() => expect(existsSync(join(cwd, 'conversation-entered'))).toBe(true), { timeout: 15000 });
      const completion = launch('completion');
      await vi.waitFor(() => expect(existsSync(join(cwd, 'completion-attempt'))).toBe(true), { timeout: 15000 });
      await completion;
      expect(existsSync(join(cwd, 'completion-entered'))).toBe(true);
      expect(existsSync(join(cwd, 'release-turn'))).toBe(false);
      expect((await new GoalStore(cwd).get(goalId)).events![0]).toMatchObject({ processed: true });
      writeFileSync(join(cwd, 'release-turn'), 'release');
      await Promise.all([conversation, completion]);
      expect(existsSync(join(cwd, 'completion-entered'))).toBe(true);
      expect((await new GoalStore(cwd).get(goalId)).events![0]).toMatchObject({ processed: true, summary: 'completion' });
    } finally {
      writeFileSync(join(cwd, 'release-turn'), 'release');
      await stopOwnedProcesses();
    }
  });

  it.each([
    { pending: false, autoRun: undefined, owner: undefined, taskGoalId: goalId },
    { pending: true, autoRun: false, owner: undefined, taskGoalId: goalId },
    { pending: true, autoRun: undefined, owner: 'run' as const, taskGoalId: goalId },
    { pending: true, autoRun: undefined, owner: 'watch' as const, taskGoalId: goalId },
    { pending: true, autoRun: undefined, owner: undefined, taskGoalId: undefined },
  ])('does not start an extra run when a conversation ends without a launch condition: %j', async ({ pending, autoRun, owner, taskGoalId }) => {
    if (autoRun !== undefined) {
      writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\n');
    }
    if (pending) runner.addTask('pending task', { workflow: 'loop-fixture', worktree: false, goal_id: taskGoalId });
    const lock = owner === undefined ? undefined : acquireProjectExecutionLock(cwd, owner);
    const spawn = observeSpawn();
    let session: ReturnType<typeof createManagerConversationSession> | undefined;
    try {
      session = createManagerConversationSession({
        cwd, plan: createManagerConversationPlan(cwd, {}),
        confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
      });
      expect((await session.handleUserMessage({ text: '進捗を確認してください' })).kind).toBe('reply');
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toEqual([]);
      if (lock !== undefined) {
        expect(JSON.stringify(lock.owner)).toContain(`"kind":"${owner}"`);
        expect(existsSync(join(cwd, '.takt', 'execution.lock', `owner-${lock.owner.ownerId}.json`))).toBe(true);
      }
      expect(runner.listPendingTaskItems()).toHaveLength(pending ? 1 : 0);
    } finally {
      await session?.close();
      lock?.release();
    }
  });

  it.each([false, true])('starts a detached run for saved pending work after a conversation turn (provider failed: %s)', async (failed) => {
    let taskName: string | undefined;
    const scenario = join(cwd, 'child-scenario.json');
    writeFileSync(scenario, JSON.stringify([
      { persona: 'coder', status: 'done', content: 'completed in child' },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '子の成果を確認しました', summary: null }) },
    ]));
    vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
    const spawn = observeSpawn();
    managerCall.mockImplementationOnce(async () => {
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toEqual([]);
      taskName = runner.addTask('pending task', { workflow: 'loop-fixture', worktree: false, goal_id: goalId }).name;
      if (failed) throw new Error('provider failed after enqueue');
      return managerReply('作業を保存しました', 'human-session');
    });
    const session = createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}),
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    });
    try {
      expect((await session.handleUserMessage({ text: '保存済みの作業を進めてください' })).kind).toBe(failed ? 'error' : 'reply');
      const launches = spawn.mock.calls.flatMap((call) => {
        const [, args] = call;
        return Array.isArray(args) && args.includes('run') ? [{ call }] : [];
      });
      expect(launches).toHaveLength(1);
      expect(launches[0]!.call[0]).toBe(process.execPath);
      expect(launches[0]!.call[2]).toMatchObject({
        cwd, detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)],
      });
      await vi.waitFor(() => {
        expect(new TaskRunner(cwd).listAllTaskItems().find(({ name }) => name === taskName)?.kind).toBe('completed');
      }, { timeout: 15000 });
    } finally {
      await session.close();
      await stopOwnedProcesses();
      vi.unstubAllEnvs();
    }
  });

  it('records and displays a failed run spawn without discarding the pending task', async () => {
    const task = runner.addTask('pending after failed spawn', { workflow: 'loop-fixture', worktree: false, goal_id: goalId });
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('injected run spawn failure');
    });
    const session = createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}),
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    });
    try {
      await session.handleUserMessage({ text: '保存済みの作業を進めてください' });
      expect(spawn).toHaveBeenCalled();
      expect(new TaskRunner(cwd).listPendingTaskItems().map(({ name }) => name)).toEqual([task.name]);
      const app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
      await vi.waitFor(() => expect(app.lastFrame()).toContain('injected run spawn failure'));
      app.unmount();
    } finally {
      await session.close();
    }
  });

  it('executes saved work when two conversation sessions launch concurrently', async () => {
    const task = runner.addTask('goal pending task', { workflow: 'loop-fixture', worktree: false, goal_id: goalId });
    const scenario = join(cwd, 'concurrent-scenario.json');
    writeFileSync(scenario, JSON.stringify([
      { persona: 'coder', status: 'done', content: 'completed once', delay_ms: 300 },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: 'goal work completed', summary: null }) },
    ]));
    vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
    const spawn = observeSpawn();
    const sessions = Array.from({ length: 2 }, () => createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}),
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    }));
    try {
      const turns = await Promise.all(sessions.map((session) => session.handleUserMessage({ text: '作業を進めてください' })));
      expect(turns.map(({ kind }) => kind)).toEqual(['reply', 'reply']);
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run')).length).toBeGreaterThanOrEqual(1);
      await vi.waitFor(() => {
        expect(new TaskRunner(cwd).listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([{ name: task.name, kind: 'completed' }]);
      }, { timeout: 15000 });
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await stopOwnedProcesses();
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])('runs registration, MCP enqueue and task completions after the conversation parent exits (enqueue after drain: %s)', async (enqueueAfterDrain) => {
    // 子にも適用するテスト用 provider。業務判断だけを置き換え、投入・実行・保存は実コードを通す。
    const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
    const hook = join(cwd, 'provider-hook.mjs');
    writeFileSync(hook, `
${ownedProcessMarkerScript(moduleUrl('../infra/task/process.ts'))}
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MockProvider } from ${JSON.stringify(moduleUrl('../infra/providers/mock.ts'))};
import { GoalStore } from ${JSON.stringify(moduleUrl('../infra/goals/store.ts'))};
import { TaskRunner } from ${JSON.stringify(moduleUrl('../infra/task/runner.ts'))};
const root = process.env.TAKT_TEST_LOOP_ROOT;
const claim = TaskRunner.prototype.claimNextTasks;
TaskRunner.prototype.claimNextTasks = function(count) {
  const claimed = claim.call(this, count);
  const tasks = this.listAllTaskItems();
  const goalId = tasks[0]?.data?.goal_id;
  const goalFile = goalId === undefined ? undefined : join(root, '.takt', 'goals', goalId, 'goal.json');
  const events = goalFile && existsSync(goalFile) ? JSON.parse(readFileSync(goalFile, 'utf8')).events : undefined;
  if (process.env.TAKT_TEST_HOLD_DRAIN === '1' && claimed.length === 0 && tasks.length === 2 && tasks.every(task => task.kind === 'completed') && events?.length === 2 && events.every(event => event.processed) && !existsSync(join(root, '.takt', 'after-drain'))) {
    writeFileSync(join(root, '.takt', 'after-drain'), String(process.pid));
    const deadline = Date.now() + 20000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(join(root, '.takt', 'release-drain'))) {
      if (Date.now() > deadline) throw new Error('Test did not release drain');
      Atomics.wait(wait, 0, 0, 20);
    }
  }
  return claimed;
};
const setup = MockProvider.prototype.setup;
MockProvider.prototype.setup = function(config) {
  const agent = setup.call(this, config);
  return { call: async (prompt, options) => {
    if (config.name === 'coder') {
      writeProcessMarker(join(root, '.takt', 'child-started'));
      const deadline = Date.now() + 20000;
      while (!existsSync(join(root, '.takt', 'release-child'))) {
        if (Date.now() > deadline) throw new Error('Test did not release child');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const response = await agent.call(prompt, options);
    if (config.name !== 'manager') return response;
    const goals = (await new GoalStore(root).list()).goals;
    if (goals.length === 0) return response;
    const goal = goals[0];
    const tasks = new TaskRunner(root).listAllTaskItems().filter(task => task.data?.goal_id === goal.id);
    const completed = tasks.filter(task => task.kind === 'completed').length;
    if (tasks.length === 0 || (tasks.length === 1 && completed === 1)) {
      const server = Object.values(options.mcpServers ?? {}).find(server => server.type === 'stdio');
      if (!server) throw new Error('Manager must receive its actual MCP server');
      const client = new Client({ name: 'loop-provider-fixture', version: '1.0.0' });
      const transport = new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env }, cwd: root });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
          cwd: root, goalId: goal.id, workflow: 'loop-fixture',
          task: completed === 0 ? 'Implement input validation' : 'Implement output validation',
          purpose: completed === 0 ? '入力を検証する' : '出力を検証する',
        } });
        if (result.isError) throw new Error(JSON.stringify(result.content));
      } finally { await client.close(); await transport.close(); }
    }
    return response;
  } };
};
`);
    const globalDirectory = process.env.TAKT_CONFIG_DIR!;
    writeFileSync(join(globalDirectory, 'config.yaml'), `provider: mock\nworktree_dir: ${join(cwd, 'clones')}\nbranch_name_strategy: romaji\n`);
    const scenario = join(cwd, 'loop-scenario.json');
    writeFileSync(scenario, JSON.stringify([
      { persona: 'coder', status: 'done', content: 'input validation complete', file_writes: [{ path: 'input.txt', content: 'input validated' }] },
      { persona: 'coder', status: 'done', content: 'output validation complete', file_writes: [{ path: 'output.txt', content: 'output validated' }] },
      { persona: 'coder', status: 'done', content: 'final validation complete' },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '保存した成果から次の手を判断しました', summary: null }) },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '循環の成果を確認しました', summary: null }) },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '終了直前に投入した成果も確認しました', summary: null }) },
    ]));
    const parentSource = `
import { createManagerConversationPlan } from ${JSON.stringify(moduleUrl('../features/manager/conversationPlan.ts'))};
import { createManagerConversationSession } from ${JSON.stringify(moduleUrl('../features/manager/conversationSession.ts'))};
import { createGoalConfirmation } from ${JSON.stringify(moduleUrl('../features/manager/goalConfirmation.ts'))};
import { connectManagerMcp } from ${JSON.stringify(moduleUrl('../features/manager/managerMcp.ts'))};
import { setMockScenario } from ${JSON.stringify(moduleUrl('../infra/mock/index.ts'))};
const cwd = process.cwd();
const confirmation = createGoalConfirmation(cwd);
const mcp = await connectManagerMcp(cwd, confirmation.publicKey);
const plan = createManagerConversationPlan(cwd, {});
const session = createManagerConversationSession({ cwd, confirmation, mcpClient: mcp.client, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: mcp.servers } } });
setMockScenario([
  { persona: 'manager', status: 'done', content: JSON.stringify({ message: '登録を承認してください', summary: { objective: '入出力を検証する', outOfScope: [], acceptanceCriteria: ['入出力が検証される'], startBranch: 'main', integrationBranch: 'main' } }) },
  { persona: 'manager', status: 'done', content: JSON.stringify({ message: '最初の作業を投入しました', summary: null }) },
]);
try {
  await session.handleUserMessage({ text: '入出力の検証を追加してください' });
  if (process.env.TAKT_TEST_RECOVER_ONLY !== '1') {
    const registered = await session.approveSummary(session.getPendingSummary().revision);
    if (registered.kind !== 'goal_registered') throw new Error(JSON.stringify(registered));
  }
  console.log('parent-finished');
} finally { await session.close(); await mcp.dispose(); }
`;
    // 親は新規ゴールを登録するため、既存 fixture のゴールを除いて開始する。
    rmSync(join(cwd, '.takt', 'goals'), { recursive: true });
    const parentOptions = {
      cwd, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, NODE_OPTIONS: `--import tsx --import ${pathToFileURL(hook).href}`,
        TAKT_CONFIG_DIR: globalDirectory, TAKT_TEST_LOOP_ROOT: cwd, TAKT_MOCK_SCENARIO: scenario,
        TAKT_TEST_HOLD_DRAIN: enqueueAfterDrain ? '1' : '0',
        GIT_AUTHOR_NAME: 'Loop Test', GIT_AUTHOR_EMAIL: 'loop@example.test',
        GIT_COMMITTER_NAME: 'Loop Test', GIT_COMMITTER_EMAIL: 'loop@example.test',
      },
    };
    const parent = trackProcess(childProcess.spawn(process.execPath, ['--input-type=module', '--eval', parentSource], parentOptions));
    let stdout = '';
    let stderr = '';
    parent.stdout.on('data', (chunk) => { stdout += String(chunk); });
    parent.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exit = new Promise<number | null>((resolve, reject) => { parent.once('error', reject); parent.once('exit', resolve); });
    try {
      await vi.waitFor(() => {
        const state = JSON.stringify(getProjectExecutionOwner(cwd));
        expect(parent.exitCode, `${stderr}\n${stdout}\n${state}`).not.toBeNull();
      }, { timeout: 15000 });
      expect(await exit, stderr).toBe(0);
      expect(stdout).toContain('parent-finished');
      await vi.waitFor(() => expect(existsSync(join(cwd, '.takt', 'child-started'))).toBe(true), { timeout: 15000 });
      expect(new TaskRunner(cwd).listAllTaskItems().filter(({ kind }) => kind === 'completed')).toHaveLength(0);
      writeFileSync(join(cwd, '.takt', 'release-child'), 'continue after parent exit');
      if (enqueueAfterDrain) {
        await vi.waitFor(() => expect(existsSync(join(cwd, '.takt', 'after-drain'))).toBe(true), { timeout: 30000 });
        const created = (await new GoalStore(cwd).list()).goals[0]!;
        const connection = await connectManagerMcp(cwd, createGoalConfirmation(cwd).publicKey);
        try {
          const result = await connection.client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
            cwd, goalId: created.id, workflow: 'loop-fixture', task: 'Implement final validation', purpose: '終了直前の検証',
          } }, undefined, { timeout: 5000 });
          expect(result.isError).toBeUndefined();
          expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(1);
        } finally {
          await connection.dispose();
          writeFileSync(join(cwd, '.takt', 'release-drain'), 'continue after enqueue');
        }
      }
      const expectedCount = enqueueAfterDrain ? 3 : 2;
      await vi.waitFor(() => {
        expect(new TaskRunner(cwd).listAllTaskItems().map(({ kind }) => kind)).toEqual(Array.from({ length: expectedCount }, () => 'completed'));
      }, { timeout: 30000 });
      const created = (await new GoalStore(cwd).list()).goals[0]!;
      const saved = JSON.parse(readFileSync(join(cwd, '.takt', 'goals', created.id, 'goal.json'), 'utf8')) as {
        workUnits: Array<{ taskName: string; purpose: string }>; events: Array<{ processed: boolean }>;
      };
      expect(saved.workUnits.map(({ purpose }) => purpose)).toEqual(['入力を検証する', '出力を検証する', ...(enqueueAfterDrain ? ['終了直前の検証'] : [])]);
      await vi.waitFor(() => {
        const events = (JSON.parse(readFileSync(join(cwd, '.takt', 'goals', created.id, 'goal.json'), 'utf8')) as typeof saved).events;
        expect(events.map(({ processed }) => processed)).toEqual(Array.from({ length: expectedCount }, () => true));
      }, { timeout: 15000 });
      expect(readdirSync(join(cwd, '.takt'), { recursive: true }).some((name) => String(name).endsWith('.log'))).toBe(true);
    } catch (error) {
      console.error('Conversation parent loop failed', error, {
        parentPid: parent.pid, parentExitCode: parent.exitCode, parentSignalCode: parent.signalCode,
        stdout, stderr,
      });
      try { console.error('Saved loop state', { owner: getProjectExecutionOwner(cwd), tasks: new TaskStore(cwd).read().tasks }); }
      catch (stateError) { console.error('Cannot read saved loop state', stateError); }
      throw error;
    } finally {
      await stopOwnedProcesses();
    }
  }, 150000);

  it('loads a saved goal event summary when a new manager screen opens', async () => {
    const message = '保存された入力検証の成果';
    managerCall.mockResolvedValueOnce(managerReply(message, 'goal-session'));
    addGoalTask('input validation');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'validated input' }]);
    await runPool();
    expect(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf8')).toContain(message);
    const session = createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}),
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    });
    const app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await vi.waitFor(() => expect(app.lastFrame()).toContain(message));
    } finally {
      app.unmount();
      await session.close();
    }
  });

  it('reads new saved goal events on the next message in the same mounted manager screen', async () => {
    const firstMessage = '入力検証の保存済み成果';
    const nextMessage = '出力検証の追加成果';
    managerCall.mockResolvedValueOnce(managerReply(firstMessage, 'goal-session'));
    addGoalTask('input validation');
    setMockScenario([{ persona: 'coder', status: 'done', content: 'validated input' }]);
    await runPool();
    const session = createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}),
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    });
    const app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await vi.waitFor(() => expect(app.lastFrame()).toContain(firstMessage));
      managerCall.mockResolvedValueOnce(managerReply(nextMessage, 'goal-session'));
      addGoalTask('output validation');
      setMockScenario([{ persona: 'coder', status: 'done', content: 'validated output' }]);
      await runPool();
      expect(readFileSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'), 'utf8')).toContain(nextMessage);
      app.stdin.write('進捗を確認してください');
      await vi.waitFor(() => expect(app.lastFrame()).toContain('進捗を確認してください'));
      app.stdin.write('\r');
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain(firstMessage);
        expect(app.lastFrame()).toContain(nextMessage);
      });
    } finally {
      app.unmount();
      await session.close();
    }
  });
});

const summary = {
  objective: 'JSONを出力する', outOfScope: ['CSV出力'], acceptanceCriteria: ['JSONを取得できる'],
  startBranch: 'release', integrationBranch: 'main',
};

describe('manager registration through task execution to local goal completion', () => {
  let cwd: string;
  const evidence = '受け入れ条件: result.txt が生成される。根拠: run の正常終了と成果物の確認。';

  beforeEach(() => {
    const root = join(process.cwd(), '.tmp');
    mkdirSync(root, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(root, 'manager-completion-')));
    git(cwd, ['init', '--initial-branch=main']);
    git(cwd, ['config', 'user.name', 'Manager Test']);
    git(cwd, ['config', 'user.email', 'manager@example.test']);
    git(cwd, ['commit', '--allow-empty', '-m', 'initial']);
    git(cwd, ['switch', '-c', 'human/work']);
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'workflows', 'complete-fixture.yaml'), [
      'name: complete-fixture', 'description: completion fixture', 'max_steps: 2', 'initial_step: work',
      'steps:', '  - name: work', '    persona: coder', '    instruction: "{task}"', '    rules:',
      '      - condition: when(true)', '        next: COMPLETE',
    ].join('\n'));
    writeFileSync(join(process.env.TAKT_CONFIG_DIR!, 'config.yaml'), [
      'provider: mock', 'branch_name_strategy: romaji', `worktree_dir: ${join(cwd, 'clones')}`,
      'notification_sound: false',
    ].join('\n'));
    invalidateGlobalConfigCache();
    resetScenario();
  }, 30000);

  afterEach(async () => {
    resetScenario(); vi.restoreAllMocks(); invalidateGlobalConfigCache();
    rmSync(cwd, { recursive: true, force: true });
    await yieldToEventLoop();
  });

  it.each(['auto', 'approve'] as const)('registers, enqueues, runs and integrates through real MCP before completing in %s mode', async (mode) => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), [
      'provider: mock', 'language: ja', 'branch_name_strategy: romaji', 'auto_requeue_max_attempts: 0',
      'manager:', '  auto_run: false', `  main_merge: ${mode}`,
    ].join('\n'));
    const initialMain = git(cwd, ['rev-parse', 'main']);
    let registeredId: string | undefined;
    const observed: Array<{ name: string; sessionId: string | undefined }> = [];
    const managerSummary = { objective: '成果物を生成する', outOfScope: [], acceptanceCriteria: ['result.txt が生成される'], startBranch: 'main', integrationBranch: 'main' };
    setMockScenario([
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '要約を確認してください', summary: managerSummary }) },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '作業を投入しました', summary: null }) },
      { persona: 'coder', status: 'done', content: '成果物を生成しました', fileWrites: [{ path: 'result.txt', content: 'completed result\n' }] },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '成果を確認しました', summary: null }) },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: '人の取り込みを確認しました', summary: null }) },
      { persona: 'manager', status: 'done', content: JSON.stringify({ message: 'ゴールを閉じました', summary: null }) },
    ]);
    const setup = MockProvider.prototype.setup;
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      if (config.name !== 'manager') return agent;
      return { call: async (prompt, options) => {
        const response = await agent.call(prompt, options);
        const payload = prompt.startsWith('{') ? JSON.parse(prompt) as {
          goalRegistered?: Goal; goal?: Goal; event?: { taskName: string; result: GoalTaskResult };
        } : undefined;
        if (payload?.goalRegistered === undefined && payload?.event === undefined && prompt !== '人の取り込みを確認してください') return response;
        const server = Object.values(options.mcpServers ?? {}).find((candidate) => candidate.type === 'stdio');
        if (server?.type !== 'stdio') throw new Error('Manager must receive its production MCP server');
        const transport = new StdioClientTransport({ command: server.command, args: server.args,
          env: { ...getDefaultEnvironment(), ...server.env }, cwd, stderr: 'pipe' });
        const client = new Client({ name: 'goal-completion-provider', version: '1' });
        try {
          await client.connect(transport);
          const invoke = async (name: string, args: Record<string, unknown>) => {
            expect(options.allowedTools).toContain(`mcp__${TAKT_MANAGER_MCP_SERVER_NAME}__${name}`);
            expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(name);
            observed.push({ name, sessionId: options.sessionId });
            const result = await client.callTool({ name, arguments: { cwd, ...args } }, undefined, { timeout: 10000 });
            expect(result.isError, firstTextContent(result.content)).toBeUndefined();
            return result;
          };
          if (payload?.goalRegistered !== undefined) {
            registeredId = payload.goalRegistered.id;
            await invoke('takt_enqueue_goal_task', { goalId: registeredId, purpose: '成果物を生成する', task: 'Create result.txt with completed result', workflow: 'complete-fixture' });
          } else if (payload?.goal !== undefined && payload.event !== undefined) {
            const event = payload.event;
            expect(event.result.success).toBe(true);
            expect(event.result.branch).toBeDefined();
            expect(event.result.sha).toBeDefined();
            expect(git(cwd, ['show', `${event.result.sha}:result.txt`])).toBe('completed result');
            await invoke('takt_get_goal_diff', { goalId: payload.goal.id, taskName: event.taskName });
            await invoke('takt_merge_goal_task', { goalId: payload.goal.id, taskName: event.taskName, expectedSha: event.result.sha });
            const detail = await invoke('takt_get_goal', { goalId: payload.goal.id });
            const goal = JSON.parse(firstTextContent(detail.content)).goal as Goal;
            await invoke('takt_complete_goal', { goalId: goal.id, expectedSha: git(cwd, ['rev-parse', goal.branch]), summary: evidence });
          } else {
            expect(registeredId).toBeDefined();
            await invoke('takt_check_goal_completion', { goalId: registeredId });
          }
          expect(options.permissionMode).toBe('readonly');
          expect(options.mcpOnlySideEffects).toEqual(options.allowedTools);
          return response;
        } finally { try { await client.close(); } finally { await transport.close(); } }
      } };
    });
    const confirmation = createGoalConfirmation(cwd);
    const plan = createManagerConversationPlan(cwd, {});
    const connection = await connectManagerMcp(cwd, confirmation.publicKey);
    let session: ReturnType<typeof createManagerConversationSession> | undefined;
    try {
      session = createManagerConversationSession({ cwd, confirmation, mcpClient: connection.client,
        plan: { ...plan, ctx: { ...plan.ctx, mcpServers: connection.servers } } });
      expect((await session.handleUserMessage({ text: '成果物を生成してください' })).kind).toBe('reply');
      const pending = session.getPendingSummary();
      expect(pending).not.toBeNull();
      const registered = await session.approveSummary(pending!.revision);
      expect(registered.kind).toBe('goal_registered');
      if (registered.kind !== 'goal_registered') throw new Error(registered.message);
      expect(registered.turn.kind).toBe('reply');
      expect(new TaskRunner(cwd).listPendingTaskItems()).toHaveLength(1);
      await runAllTasks(cwd, { provider: 'mock', goalTasksOnly: true });
      const saved = await new GoalStore(cwd).get(registered.goal.id);
      expect(saved.events).toEqual([expect.objectContaining({ processed: true, result: expect.objectContaining({ success: true, branch: expect.any(String), sha: expect.any(String) }) })]);
      expect(observed.map(({ name }) => name)).toEqual(['takt_enqueue_goal_task', 'takt_get_goal_diff', 'takt_merge_goal_task', 'takt_get_goal', 'takt_complete_goal']);
      expect(git(cwd, ['show', `${saved.branch}:result.txt`])).toBe('completed result');
      expect(JSON.stringify(saved)).toContain(evidence);
      if (mode === 'auto') {
        expect(saved.status).toBe('completed');
        expect(git(cwd, ['merge-base', '--is-ancestor', saved.branch, 'main'])).toBe('');
        expect(git(cwd, ['show', 'main:result.txt'])).toBe('completed result');
      } else {
        expect(saved.status).not.toBe('created');
        expect(saved.status).not.toBe('completed');
        expect(git(cwd, ['rev-parse', 'main'])).toBe(initialMain);
        expect((await session.handleUserMessage({ text: '人の取り込みを確認してください' })).kind).toBe('reply');
        expect((await new GoalStore(cwd).get(saved.id)).status).not.toBe('completed');
        const human = join(cwd, 'human-main');
        git(cwd, ['worktree', 'add', human, 'main']);
        git(human, ['merge', '--no-ff', '--no-edit', saved.branch]);
        expect((await session.handleUserMessage({ text: '人の取り込みを確認してください' })).kind).toBe('reply');
        expect((await new GoalStore(cwd).get(saved.id)).status).toBe('completed');
        const checks = observed.filter(({ name }) => name === 'takt_check_goal_completion');
        expect(checks).toHaveLength(2);
        expect(checks[0]!.sessionId).toBeDefined();
        expect(checks[1]!.sessionId).toBe(checks[0]!.sessionId);
      }
      expect(git(cwd, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/human/work');
      expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(initialMain);
      expect(existsSync(join(cwd, 'result.txt'))).toBe(false);
    } finally { try { await session?.close(); } finally { await connection.dispose(); } }
  }, 60000);
});

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env, GIT_AUTHOR_NAME: 'Manager Test', GIT_AUTHOR_EMAIL: 'manager@example.test',
      GIT_COMMITTER_NAME: 'Manager Test', GIT_COMMITTER_EMAIL: 'manager@example.test',
    },
  }).trim();
}

describe('manager conversation to local goal registration', () => {
  let cwd: string;
  let releaseCommit: string;

  beforeEach(() => {
    const temporaryRoot = join(process.cwd(), '.tmp');
    mkdirSync(temporaryRoot, { recursive: true });
    cwd = realpathSync(mkdtempSync(join(temporaryRoot, 'manager-goal-')));
    git(cwd, ['init', '--initial-branch=main']);
    const tree = git(cwd, ['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    const mainCommit = git(cwd, ['commit-tree', tree, '-m', 'main fixture']);
    releaseCommit = git(cwd, ['commit-tree', tree, '-p', mainCommit, '-m', 'release fixture']);
    git(cwd, ['update-ref', 'refs/heads/main', mainCommit]);
    git(cwd, ['update-ref', 'refs/heads/release', releaseCommit]);
    mkdirSync(join(cwd, '.takt'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    resetScenario();
  });

  afterEach(async () => {
    resetScenario();
    vi.restoreAllMocks();
    vi.mocked(crypto.randomUUID).mockImplementation((await vi.importActual<typeof import('node:crypto')>('node:crypto')).randomUUID);
    rmSync(cwd, { recursive: true, force: true });
  });

  async function withManager<T>(action: (context: {
    session: ReturnType<typeof createManagerConversationSession>; client: Client;
  }) => Promise<T>): Promise<T> {
    const confirmation = createGoalConfirmation(cwd);
    const server = createTaktMcpServer({}, {
      toolSet: 'manager' as TaktMcpToolSet,
      allowedProjectRoot: cwd, goalConfirmationPublicKey: confirmation.publicKey,
    });
    const client = new Client({ name: 'manager-goal-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const plan = createManagerConversationPlan(cwd, { language: 'en' });
      const session = createManagerConversationSession({ cwd, plan, confirmation, mcpClient: client });
      return await action({ session, client });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('registers a new host ID through MCP after approval and preserves the existing goal and task queue', async () => {
    const existing = await registerFixtureGoal(cwd);
    git(cwd, ['update-ref', `refs/heads/${existing.branch}`, releaseCommit]);
    const existingPath = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    const saved = readFileSync(existingPath);
    vi.mocked(crypto.randomUUID).mockReturnValue(newId);
    setMockScenario([
      { status: 'done', content: JSON.stringify({ message: '範囲外は何ですか', summary: null }) },
      { status: 'done', content: JSON.stringify({ message: '要約を確認してください', summary }), structuredOutput: { message: '要約を確認してください', summary } },
    ]);

    await withManager(async ({ session, client }) => {
      const calls = vi.spyOn(client, 'callTool');
      await session.handleUserMessage({ text: 'JSON出力を追加したい' });
      expect(session.getPendingSummary()).toBeNull();
      await session.handleUserMessage({ text: 'CSVは範囲外。JSONを取得できることを受け入れ条件にする' });
      expect(session.getPendingSummary()?.summary).toEqual(summary);
      expect((await new GoalStore(cwd).list()).goals.map(({ id }) => id)).toEqual([goalId]);

      const result = await session.approveSummary(session.getPendingSummary()!.revision);

      expect(result.kind).toBe('goal_registered');
      expect(calls.mock.calls.map(([request]) => request.name)).toEqual(['takt_create_goal']);
      const created = await new GoalStore(cwd).get(newId);
      expect(created).toMatchObject({ id: newId, ...summary, creationOrigin: 'human', status: 'created', mode: 'local' });
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(releaseCommit);
      const detail = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId: newId } });
      expect(detail.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(detail.content))).toEqual({ goal: created });
      const listed = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
      expect(listed.isError).toBeUndefined();
      expect((JSON.parse(firstTextContent(listed.content)) as { goals: Goal[] }).goals.map(({ id }) => id).sort()).toEqual([goalId, newId].sort());
      expect(readFileSync(existingPath)).toEqual(saved);
      expect(git(cwd, ['rev-parse', `refs/heads/${existing.branch}`])).toBe(releaseCommit);
      const tasks = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } });
      expect(JSON.parse(firstTextContent(tasks.content))).toEqual({ tasks: [] });
      expect(existsSync(join(cwd, '.takt', 'tasks.yaml'))).toBe(false);
      expect(existsSync(join(cwd, '.takt', 'runs'))).toBe(false);
    });
  });

  it('rejects a host ID collision without changing the existing goal or Git references', async () => {
    const existing = await registerFixtureGoal(cwd);
    git(cwd, ['update-ref', `refs/heads/${existing.branch}`, releaseCommit]);
    const path = join(cwd, '.takt', 'goals', goalId, 'goal.json');
    const saved = readFileSync(path);
    const branches = git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
    vi.mocked(crypto.randomUUID).mockReturnValue(goalId);
    setMockScenario([{ status: 'done', content: JSON.stringify({ message: '要約', summary }), structuredOutput: { message: '要約', summary } }]);

    await withManager(async ({ session }) => {
      await session.handleUserMessage({ text: 'JSON出力' });
      const result = await session.approveSummary(session.getPendingSummary()!.revision);

      expect(result.kind).toBe('error');
      expect(readFileSync(path)).toEqual(saved);
      expect(git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'])).toBe(branches);
    });
  });

  it('registers through the production stdio MCP process and removes its public key after shutdown', async () => {
    const confirmation = createGoalConfirmation(cwd);
    const connection = await connectManagerMcp(cwd, confirmation.publicKey);
    const server = Object.values(connection.servers)[0];
    if (server?.type !== 'stdio') throw new Error('Expected stdio server');
    const keyPath = server.args![server.args!.indexOf('--goal-confirmation-public-key') + 1]!;
    const plan = createManagerConversationPlan(cwd, { language: 'en' });
    const session = createManagerConversationSession({ cwd, plan: { ...plan, ctx: { ...plan.ctx, mcpServers: connection.servers } }, confirmation, mcpClient: connection.client });
    try {
      expect(readFileSync(keyPath, 'utf8')).toBe(confirmation.publicKey);
      expect((await connection.client.listTools()).tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'takt_create_goal', 'takt_list_goals', 'takt_get_goal', 'takt_list_tasks', 'takt_get_run',
        'takt_enqueue_goal_task', 'takt_list_workflows', 'takt_merge_goal_task',
        'takt_complete_goal', 'takt_check_goal_completion',
        'takt_get_goal_diff', 'takt_get_goal_history', 'takt_get_goal_relation',
      ]));
      vi.mocked(crypto.randomUUID).mockReturnValue(newId);
      setMockScenario([{ status: 'done', content: JSON.stringify({ message: '要約', summary }), structuredOutput: { message: '要約', summary } }]);
      await session.handleUserMessage({ text: 'JSON出力' });
      expect((await session.approveSummary(session.getPendingSummary()!.revision)).kind).toBe('goal_registered');
      const created = await new GoalStore(cwd).get(newId);
      expect(created).toMatchObject(summary);
      expect(git(cwd, ['rev-parse', `refs/heads/${created.branch}`])).toBe(releaseCommit);
    } finally {
      try { await session.close(); } finally { await connection.dispose(); }
    }
    expect(existsSync(keyPath)).toBe(false);
  });
});
