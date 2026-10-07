import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createElement } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagerConversationPlan } from '../features/manager/conversationPlan.js';
import { createManagerConversationSession } from '../features/manager/conversationSession.js';
import { createGoalConfirmation } from '../features/manager/goalConfirmation.js';
import { connectManagerMcp, TAKT_MANAGER_MCP_SERVER_NAME } from '../features/manager/managerMcp.js';
import { createTaktMcpServer, type TaktMcpToolSet } from '../features/mcp/server.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal, GoalTaskResult } from '../infra/goals/schema.js';
import { getScenarioQueue, resetScenario, setMockScenario } from '../infra/mock/index.js';
import { MockProvider } from '../infra/providers/mock.js';
import type { ProviderAgent } from '../infra/providers/types.js';
import { TaskRunner } from '../infra/task/index.js';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { ManagerView } from '../features/manager/ManagerView.js';
import { runManager } from '../features/manager/runManager.js';
import { mountInk } from '../features/tui/inkMount.js';
import { acquireProjectExecutionLock, getProjectExecutionOwner } from '../infra/task/project-execution-lock.js';
import { readManagerRunState, writeManagerRunState } from '../infra/task/manager-run-state.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import * as postExecution from '../features/tasks/execute/postExecution.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { isProcessAlive } from '../infra/task/process.js';
import { withGoalTurns } from '../infra/goals/turn-lock.js';
import { TaskStore } from '../infra/task/store.js';
import { hostProjectStateDirectory } from '../infra/config/host-state.js';
import { processGoalCompletions } from '../features/manager/completionTurn.js';
import { ensureManagerRun } from '../features/manager/autoRun.js';
import { goalCompletionEvent, markGoalCompletionProcessed } from '../infra/goals/completion-evidence.js';
import * as processIdentity from '../infra/task/process.js';
import { captureOwnedChild, captureOwnedProcess, ownedProcessMarkerScript, readOwnedProcessMarker, signalOwnedProcess, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';

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
    for (const gate of ['release-turn', 'release-completion-child', '.takt/release-adoption', '.takt/release-drain', '.takt/release-child']) {
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
    for (const marker of ['completion-child-entered', '.takt/child-started', '.takt/before-adoption']) {
      const path = join(cwd, marker);
      try { if (existsSync(path)) processes.push(readOwnedProcessMarker(readFileSync(path, 'utf8'))); }
      catch (error) { errors.push(error); }
    }
    try {
      const child = readManagerRunState(cwd).reservation?.child;
      if (child !== undefined) processes.push(readOwnedProcessMarker(JSON.stringify(child)));
    } catch (error) { errors.push(error); }
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
        const coordination = join(directory, '.takt', 'run-coordination.lock');
        console.error('Cleanup failure', error, { pid: process.pid, cwd: directory });
        try { if (existsSync(coordination)) console.error('Saved coordination lock', readFileSync(coordination, 'utf8')); }
        catch (stateError) { console.error('Cannot read coordination lock', stateError); }
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
    writeManagerRunState(cwd, { requested: false, failures: readManagerRunState(cwd).failures });
    return task.name;
  }

  it.each(['saved', 'missing evidence', 'missing task', 'event result', 'task and event result'] as const)('accepts only trusted completions through MCP recovery: %s', async (change) => {
    const result = { success: true, interrupted: false, sha: 'saved-sha' };
    const name = saveCompletedFixture('saved-task', 'saved-run', goalId, result);
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{ taskName: name, runSlug: 'saved-run', result, processed: false }] }));
    if (change === 'missing evidence') rmSync(hostProjectStateDirectory(cwd, 'goal-completions'), { recursive: true });
    if (change === 'missing task') new TaskStore(cwd).update(() => ({ tasks: [] }));
    if (change === 'event result' || change === 'task and event result') {
      await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: goal.events!.map((event) => ({ ...event, result: { ...event.result, sha: 'forged-sha' } })) }));
      if (change === 'task and event result') new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => ({ ...task, completion: { ...result, sha: 'forged-sha' } })) }));
    }
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    const client = new Client({ name: 'completion-verification', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const detail = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      const recovered = change === 'saved' || change === 'event result';
      if (!recovered) expect(JSON.parse(firstTextContent(detail.content)).goal.events).toEqual([]);
      expect(managerCall).toHaveBeenCalledTimes(recovered ? 1 : 0);
      if (recovered) {
        expect(savedGoal().events[0]).toMatchObject({ processed: true, summary: '成果を確認しました', result });
        expect(JSON.parse(managerCall.mock.calls[0]![0]).event.result).toEqual(result);
      }
      expect(runner.listPendingTaskItems()).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('passes only verified events and host summaries to the provider and recovers after provider failure', async () => {
    saveCompletedFixture('saved-task', 'saved-run');
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [
      { taskName: 'saved-task', runSlug: 'saved-run', processed: false, summary: 'forged summary', result: { success: true, interrupted: false } },
      { taskName: 'injected-task', runSlug: 'injected-run', processed: false, result: { success: true, interrupted: false, sha: 'injected-sha' } },
    ] }));
    managerCall.mockRejectedValueOnce(new Error('injected provider failure'));
    await processGoalCompletions(cwd, goalId);
    expect(savedGoal().events[0]!.processed).toBe(false);
    await processGoalCompletions(cwd, goalId);
    expect(managerCall).toHaveBeenCalledTimes(2);
    const prompt = JSON.parse(managerCall.mock.calls[1]![0]) as { goal: Goal };
    expect(prompt.goal.events).toEqual([{ taskName: 'saved-task', runSlug: 'saved-run', processed: false, result: { success: true, interrupted: false } }]);
    expect(savedGoal().events[0]!.processed).toBe(true);
  });

  it.each(['saved', 'missing evidence', 'missing task', 'task result'] as const)('returns verified events from decision, get and list MCP responses: %s', async (change) => {
    const result = { success: true, interrupted: false, sha: 'saved-sha' };
    const name = saveCompletedFixture('saved-task', 'saved-run', goalId, result);
    const completion = { taskName: name, runSlug: 'saved-run', result };
    markGoalCompletionProcessed(cwd, goalId, completion, 'host summary', { provider: 'mock', sessionId: 'host-session' });
    const untrusted = { ...completion, result: { ...result, sha: 'forged-sha' }, processed: false, summary: 'forged summary' };
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [untrusted] }));
    if (change === 'missing evidence') rmSync(hostProjectStateDirectory(cwd, 'goal-completions'), { recursive: true });
    if (change === 'missing task') new TaskStore(cwd).update(() => ({ tasks: [] }));
    if (change === 'task result') new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => ({ ...task, completion: { ...result, sha: 'forged-sha' } })) }));
    await withGoalTurns(cwd, [goalId], async (goalTurnOwners) => {
      const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd, goalTurnOwners });
      const client = new Client({ name: 'decision-verification', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport); await client.connect(clientTransport);
        const decision = await client.callTool({ name: 'takt_record_goal_decision', arguments: { cwd, goalId, decision: 'complete', reason: 'reviewed' } });
        expect(decision.isError).toBeUndefined();
        const get = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
        const list = await client.callTool({ name: 'takt_list_goals', arguments: { cwd } });
        const goals = [JSON.parse(firstTextContent(decision.content)).goal, JSON.parse(firstTextContent(get.content)).goal, JSON.parse(firstTextContent(list.content)).goals[0]] as Goal[];
        for (const goal of goals) {
          expect(goal.events).toEqual(change === 'saved' ? [{ ...completion, processed: true, summary: 'host summary' }] : []);
          expect(goal.status).toBe('created');
          expect(goal.decisions).toEqual([expect.objectContaining({ decision: 'complete', reason: 'reviewed' })]);
        }
        expect((await new GoalStore(cwd).get(goalId)).events).toEqual([untrusted]);
      } finally { await client.close(); await server.close(); }
    });
    const diagnosticServer = createTaktMcpServer({}, { toolSet: 'read-only', allowedProjectRoot: cwd });
    const diagnosticClient = new Client({ name: 'diagnostic-read', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await diagnosticServer.connect(serverTransport); await diagnosticClient.connect(clientTransport);
      const detail = await diagnosticClient.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId } });
      expect(JSON.parse(firstTextContent(detail.content)).goal.events).toEqual([untrusted]);
    } finally { await diagnosticClient.close(); await diagnosticServer.close(); }
    expect(managerCall).not.toHaveBeenCalled();
    expect(runner.listPendingTaskItems()).toEqual([]);
  });

  it.each([true, false])('recovers host results on direct notification despite modified duplicates (evidence: %s)', async (evidence) => {
    const result = { success: true, interrupted: false, sha: 'saved-sha' };
    const name = saveCompletedFixture('direct-task', 'direct-run', goalId, result);
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [0, 1].map(() => ({ taskName: name, runSlug: 'direct-run', result: { ...result, sha: 'forged-sha' }, processed: true, summary: 'forged summary' })) }));
    if (!evidence) rmSync(hostProjectStateDirectory(cwd, 'goal-completions'), { recursive: true });
    await processGoalCompletions(cwd, goalId, {}, { taskName: name, runSlug: 'direct-run', result });
    await processGoalCompletions(cwd, goalId);
    expect(managerCall).toHaveBeenCalledTimes(evidence ? 1 : 0);
    if (evidence) {
      expect(JSON.parse(managerCall.mock.calls[0]![0]).event.result).toEqual(result);
      expect(savedGoal().events).toEqual([{ taskName: name, runSlug: 'direct-run', result, processed: true, summary: '成果を確認しました' }]);
    }
    expect(runner.listTaskStateItems()[0]).toMatchObject({ status: 'completed', completion: result });
    expect(runner.listPendingTaskItems()).toEqual([]);
  });

  it('restores a host-processed response after goal publication fails without calling the provider twice', async () => {
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
    expect(managerCall).toHaveBeenCalledTimes(1);
    expect(savedGoal().events[0]).toMatchObject({ processed: true, summary: '成果を確認しました' });
  });

  it('keeps a saved success and a diagnostic when the host completion directory is unusable', async () => {
    const directory = hostProjectStateDirectory(cwd, 'goal-completions');
    mkdirSync(join(directory, '..'), { recursive: true });
    writeFileSync(directory, 'unusable');
    try {
      saveCompletedFixture('saved-task', 'saved-run');
      expect(readManagerRunState(cwd).failures).toHaveLength(1);
      await processGoalCompletions(cwd, goalId);
      expect(runner.listTaskStateItems()).toEqual([expect.objectContaining({ status: 'completed', completion: { success: true, interrupted: false } })]);
      expect(managerCall).not.toHaveBeenCalled();
      expect(readManagerRunState(cwd).failures.length).toBeGreaterThanOrEqual(1);
    } finally { rmSync(directory); }
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

  it.each(['marker', 'reservation', 'owner'].flatMap((source) => ['reused', 'unknown'].map((identity) => ({ source, identity }))))('checks recorded process ownership and retains unknown live processes: %j', async ({ source, identity }) => {
    const held = childProcess.spawn(process.execPath, [...identityPreload(), '-e', "process.stdout.write('ready'); setInterval(() => {}, 1000);"], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve) => held.stdout!.once('data', () => resolve()));
    const recorded = captureOwnedProcess(held.pid!);
    expect(recorded.identity).toBeDefined();
    const marker = { pid: recorded.pid, startTime: recorded.identity!.startTime };
    let ownerFile: string | undefined;
    if (source === 'marker') writeFileSync(join(cwd, '.takt', 'child-started'), JSON.stringify(marker));
    if (source === 'reservation') writeManagerRunState(cwd, { requested: false, failures: [], reservation: { token: crypto.randomUUID(), launcher: marker, child: marker } });
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
          : recorded.identity!.startTime.replace(/:\d+$/, (value) => value === ':0' ? ':1' : ':0') }
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

  it.each([true, false])('distinguishes completion evidence for structured task/run pairs through MCP: %s', async (bothSaved) => {
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
      expect(managerCall).toHaveBeenCalledTimes(bothSaved ? 2 : 0);
      expect(savedGoal().events.every((event) => event.processed)).toBe(bothSaved);
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
    expect(goalCompletionEvent(cwd, goalId, completion)).toMatchObject({ ...completion, processed: recovery === 'direct' });
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
    expect(goalCompletionEvent(cwd, goalId, completion)).toMatchObject({ ...completion, processed: true });
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
      await vi.waitFor(() => expect(savedGoal().events).toHaveLength(1), { timeout: 5000 });
      const event = structuredClone(savedGoal().events[0]!);
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

  it.each([true, false])('recovers a forged duplicate through TUI startup only with host evidence: %s', async (hasEvidence) => {
    const result = { success: true, interrupted: false, sha: 'saved-sha' };
    const name = saveCompletedFixture('tui-recovery', 'tui-run', goalId, result);
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{
      taskName: name, runSlug: 'tui-run', result: { ...result, sha: 'forged-sha' }, processed: false,
    }] }));
    if (!hasEvidence) rmSync(hostProjectStateDirectory(cwd, 'goal-completions'), { recursive: true });
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.mocked(mountInk<void>).mockResolvedValue(undefined);
    try {
      await runManager({ cwd });
      expect(managerCall).toHaveBeenCalledTimes(hasEvidence ? 1 : 0);
      if (hasEvidence) {
        const context = JSON.parse(managerCall.mock.calls[0]![0]) as { event: { result: GoalTaskResult } };
        expect(context.event.result).toEqual(result);
        expect(savedGoal().events).toEqual([expect.objectContaining({ result, processed: true })]);
      }
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

  it.each(['host', 'project'] as const)('resumes only host goal sessions and preserves them across responses without IDs: %s', async (source) => {
    const session = { provider: 'mock', sessionId: 'goal-session' };
    const previous = { taskName: saveCompletedFixture('session-previous', 'session-previous-run'), runSlug: 'session-previous-run', result: { success: true, interrupted: false } };
    markGoalCompletionProcessed(cwd, goalId, previous, 'previous summary', source === 'host' ? session : undefined);
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, sessions: [session], events: [{ ...previous, processed: true }] }));
    const reply = { persona: 'manager', status: 'done' as const, timestamp: new Date(), content: JSON.stringify({ message: 'IDなし応答', summary: null }) };
    managerCall.mockResolvedValueOnce(reply).mockResolvedValueOnce(reply);
    saveCompletedFixture('session-next', 'session-next-run');
    await processGoalCompletions(cwd, goalId);
    saveCompletedFixture('session-last', 'session-last-run');
    await processGoalCompletions(cwd, goalId);
    expect(managerCall).toHaveBeenCalledTimes(2);
    for (const [prompt, options] of managerCall.mock.calls) {
      expect(options.sessionId).toBe(source === 'host' ? 'goal-session' : undefined);
      expect(JSON.parse(prompt).goal.sessions).toEqual(source === 'host' ? [session] : []);
    }
    expect((await new GoalStore(cwd).get(goalId)).sessions).toEqual(source === 'host' ? [session] : []);
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

  it('serializes conversation turns from two sessions that share the same goal', async () => {
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
      await vi.waitFor(() => expect(managerCall.mock.calls.length).toBeGreaterThan(0));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(managerCall).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all(turns);
      await Promise.all(sessions.map((session) => session.close()));
    }
    expect((await Promise.all(turns)).map(({ kind }) => kind)).toEqual(['reply', 'reply']);
    expect(maxActive).toBe(1);
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

  it('keeps the saved task result without calling a manager when the goal registration no longer matches', async () => {
    const task = addGoalTask('already queued goal work');
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, objective: 'unconfirmed objective' }));
    setMockScenario([{ persona: 'coder', status: 'done', content: 'completed task' }]);
    expect(await runPool()).toMatchObject({ success: 1, fail: 0 });
    expect(runner.listTaskStateItems()).toEqual([expect.objectContaining({
      name: task.name, status: 'completed', completion: expect.objectContaining({ success: true, interrupted: false }),
    })]);
    expect(managerCall).not.toHaveBeenCalled();
    expect((await new GoalStore(cwd).get(goalId)).events).toBeUndefined();
  });

  it.each(['registered', 'changed objective', 'unsigned', 'missing evidence'] as const)('verifies saved registration before MCP event recovery: %s', async (condition) => {
    const summary = { objective: 'CSVを出力する', outOfScope: [], acceptanceCriteria: ['CSVを取得できる'] };
    const goal = condition === 'unsigned'
      ? await new GoalStore(cwd).create({ ...goalRecord(), ...summary, id: newId })
      : await registerFixtureGoal(cwd, { ...summary, id: newId });
    const savedTask = saveCompletedFixture('saved-task', 'saved-run', goal.id);
    await new GoalStore(cwd).update(goal.id, (saved) => ({
      ...saved, objective: condition === 'changed objective' ? 'JSONを出力する' : saved.objective,
      events: [{ taskName: 'saved-task', runSlug: 'saved-run', processed: false, summary: 'CSVを出力する', result: { success: true, interrupted: false } }],
    }));
    if (condition === 'missing evidence') {
      const namespace = crypto.createHash('sha256').update(cwd).digest('hex');
      rmSync(join(process.env.TAKT_CONFIG_DIR!, 'goal-registrations', namespace, `${goal.id}.json`));
    }
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    const client = new Client({ name: 'registration-recovery', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: 'takt_get_goal', arguments: { cwd, goalId: goal.id } });
      expect(result.isError === true).toBe(condition !== 'registered');
      expect(managerCall).toHaveBeenCalledTimes(condition === 'registered' ? 1 : 0);
      expect((await new GoalStore(cwd).get(goal.id)).events![0]!.processed).toBe(condition === 'registered');
      expect(runner.listTaskStateItems()).toEqual([expect.objectContaining({ name: savedTask, status: 'completed' })]);
      if (condition !== 'registered') {
        const enqueue = await client.callTool({ name: 'takt_enqueue_goal_task', arguments: {
          cwd, goalId: goal.id, workflow: 'loop-fixture', task: 'unapproved work', purpose: 'unapproved purpose',
        } });
        const decision = await client.callTool({ name: 'takt_record_goal_decision', arguments: {
          cwd, goalId: goal.id, decision: 'complete', reason: 'unapproved decision',
        } });
        expect(enqueue.isError).toBe(true);
        expect(decision.isError).toBe(true);
        expect(runner.listTaskStateItems()).toEqual([expect.objectContaining({ name: savedTask, status: 'completed' })]);
        expect((await new GoalStore(cwd).get(goal.id)).decisions).toBeUndefined();
      }
    } finally { await client.close(); await server.close(); }
  });

  it('does not start unrequested pending work when the manager TUI opens', async () => {
    const task = runner.addTask('unrequested ordinary work', { workflow: 'loop-fixture', worktree: false });
    expect(readManagerRunState(cwd).requested).toBe(false);
    const spawn = observeSpawn();
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.mocked(mountInk<void>).mockResolvedValue(undefined);
    try {
      await runManager({ cwd });
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toEqual([]);
      expect(managerCall).not.toHaveBeenCalled();
      expect(runner.listPendingTaskItems().map(({ name }) => name)).toEqual([task.name]);
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
    }
  });

  it.each(['host', 'project'] as const)('uses only a host-issued request when the manager TUI opens: %s', async (origin) => {
    const task = runner.addTask('work A', { workflow: 'loop-fixture', worktree: false });
    const state = { requested: true, failures: [] };
    if (origin === 'host') writeManagerRunState(cwd, state);
    else writeFileSync(join(cwd, '.takt', 'manager-run.json'), JSON.stringify(state));
    const scenario = join(cwd, 'request-scenario.json');
    writeFileSync(scenario, JSON.stringify([{ persona: 'coder', status: 'done', content: 'work A completed' }]));
    vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
    const spawn = observeSpawn();
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.mocked(mountInk<void>).mockResolvedValue(undefined);
    try {
      await runManager({ cwd });
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toHaveLength(origin === 'host' ? 1 : 0);
      if (origin === 'host') await vi.waitFor(() => expect(runner.listTaskStateItems()[0]).toMatchObject({ name: task.name, status: 'completed' }), { timeout: 15000 });
      else expect(runner.listPendingTaskItems().map(({ name }) => name)).toEqual([task.name]);
    } finally {
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY); else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY); else Reflect.deleteProperty(process.stdout, 'isTTY');
      await stopOwnedProcesses();
    }
  });

  it.each(['same project host', 'other project host', 'project file'] as const)('recovers only the same project host reservation through MCP: %s', async (origin) => {
    const task = runner.addTask('work A', { workflow: 'loop-fixture', worktree: false });
    expect(isProcessAlive(999999)).toBe(false);
    const state = { requested: false, failures: [], reservation: { token: crypto.randomUUID(), launcher: { pid: 999999 } } };
    if (origin === 'same project host') writeManagerRunState(cwd, state);
    if (origin === 'other project host') {
      const other = join(cwd, 'other-project'); mkdirSync(other);
      writeManagerRunState(other, state);
    }
    if (origin === 'project file') writeFileSync(join(cwd, '.takt', 'manager-run.json'), JSON.stringify(state));
    const scenario = join(cwd, 'reservation-scenario.json');
    writeFileSync(scenario, JSON.stringify([{ persona: 'coder', status: 'done', content: 'work A completed' }]));
    vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
    const spawn = observeSpawn();
    const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    const client = new Client({ name: 'reservation-verification', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } });
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toHaveLength(origin === 'same project host' ? 1 : 0);
      if (origin === 'same project host') await vi.waitFor(() => expect(runner.listTaskStateItems()[0]).toMatchObject({ name: task.name, status: 'completed' }), { timeout: 15000 });
      else expect(runner.listPendingTaskItems().map(({ name }) => name)).toEqual([task.name]);
    } finally { await client.close(); await server.close(); await stopOwnedProcesses(); }
  });

  it('keeps ordinary manual execution working while refusing automatic launch with unusable host storage', async () => {
    const hostRoot = process.env.TAKT_CONFIG_DIR!;
    const task = runner.addTask('ordinary work', { workflow: 'loop-fixture', worktree: false });
    const spawn = observeSpawn();
    vi.stubEnv('TAKT_CONFIG_DIR', join(cwd, 'global'));
    invalidateGlobalConfigCache();
    try {
      await ensureManagerRun(cwd, 'turn-ended');
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toEqual([]);
      const server = createTaktMcpServer({}, { toolSet: 'all', allowedProjectRoot: cwd });
      const client = new Client({ name: 'unusable-host', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport); await client.connect(clientTransport);
        expect((await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } })).isError).not.toBe(true);
      } finally { await client.close(); await server.close(); }
      setMockScenario([{ persona: 'coder', status: 'done', content: 'ordinary result' }]);
      expect(await runPool()).toMatchObject({ success: 1, fail: 0 });
      expect(runner.listTaskStateItems()[0]).toMatchObject({ name: task.name, status: 'completed' });
      expect((await import('../infra/task/manager-run-state.js')).readManagerRunFailures(cwd).length).toBeGreaterThan(0);
    } finally { vi.stubEnv('TAKT_CONFIG_DIR', hostRoot); invalidateGlobalConfigCache(); }
  });

  it('shows healthy summaries, startup failures and corrupt goal diagnostics at startup and on the next message', async () => {
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{
      taskName: 'saved', runSlug: 'run', processed: true, summary: '保存された正常な要約', result: { success: true, interrupted: false },
    }] }));
    const corrupt = join(cwd, '.takt', 'goals', newId);
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'goal.json'), '{');
    writeManagerRunState(cwd, { requested: false, failures: [{ id: crypto.randomUUID(), message: '保存された起動失敗', at: new Date().toISOString() }] });
    const session = createManagerConversationSession({ cwd, plan: createManagerConversationPlan(cwd, {}), confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() } });
    const app = render(createElement(ManagerView, { cwd, lang: 'ja', session, initialDiagnostics: [], onExit: vi.fn() }));
    try {
      await vi.waitFor(() => {
        expect(app.lastFrame()).toContain('保存された正常な要約');
        expect(app.lastFrame()).toContain('保存された起動失敗');
        expect(app.lastFrame()).toContain(newId);
      });
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
      });
    } finally { app.unmount(); await session.close(); }
  });

  it.each(['success', 'persistent failure', 'temporary failure'] as const)('shows saved startup failures through runManager when goal listing has %s', async (condition) => {
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{
      taskName: 'saved', runSlug: 'run', processed: true, summary: '保存された正常な要約', result: { success: true, interrupted: false },
    }] }));
    writeManagerRunState(cwd, { requested: false, failures: [{ id: crypto.randomUUID(), message: '保存された起動失敗', at: new Date().toISOString() }] });
    const task = runner.addTask('unrequested ordinary work', { workflow: 'loop-fixture', worktree: false });
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
            const diagnosticLine = frame.slice(frame.indexOf(diagnostic!), frame.indexOf('保存された正常な要約'));
            expect(diagnosticLine).toContain('api_key=[REDACTED]');
            expect(diagnosticLine).not.toContain('fixture-secret');
            expect(diagnosticLine).not.toContain('\x1b');
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
    expect(readManagerRunState(cwd).reservation).toBeUndefined();
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
        await vi.waitFor(() => expect(runner.listTaskStateItems().find((task) => task.name !== 'previous')).toMatchObject({ status: 'completed', completion: { success: true, interrupted: false } }), { timeout: 15000 });
        await vi.waitFor(() => expect(savedGoal().events).toHaveLength(2), { timeout: 15000 });
        await vi.waitFor(() => expect(savedGoal().events[1]!.processed).toBe(true), { timeout: 15000 });
        await vi.waitFor(() => expect(isProcessAlive(childPid!)).toBe(false), { timeout: 15000 });
      } else {
        expect(tasks[0]!.status).toBe('pending');
        expect(existsSync(join(cwd, 'completion-child-entered'))).toBe(false);
        expect(readManagerRunState(cwd).reservation).toBeUndefined();
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

  it('serializes a conversation and a completion turn in independent processes', async () => {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), readFileSync(join(cwd, '.takt', 'config.yaml'), 'utf8') + '\nmanager:\n  auto_run: false\n');
    saveCompletedFixture('saved-task', 'saved-run');
    await new GoalStore(cwd).update(goalId, (goal) => ({ ...goal, events: [{ taskName: 'saved-task', runSlug: 'saved-run', processed: false, result: { success: true, interrupted: false } }] }));
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
if (role === 'completion') await processGoalCompletions(cwd, ${JSON.stringify(goalId)});
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
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(existsSync(join(cwd, 'completion-entered'))).toBe(false);
      expect((await new GoalStore(cwd).get(goalId)).events![0]!.processed).toBe(false);
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
    { pending: false, autoRun: undefined, owner: undefined },
    { pending: true, autoRun: false, owner: undefined },
    { pending: true, autoRun: undefined, owner: 'run' as const },
    { pending: true, autoRun: undefined, owner: 'watch' as const },
  ])('does not start an extra run when a conversation ends without a launch condition: %j', async ({ pending, autoRun, owner }) => {
    if (autoRun !== undefined) {
      writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\n');
    }
    if (pending) runner.addTask('pending task', { workflow: 'loop-fixture', worktree: false });
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
      taskName = runner.addTask('pending task', { workflow: 'loop-fixture', worktree: false }).name;
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
    const task = runner.addTask('pending after failed spawn', { workflow: 'loop-fixture', worktree: false });
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

  it('starts only one run when two conversation sessions finish concurrently', async () => {
    // ゴール単位の排他ではなく、プロジェクトの起動予約による重複防止を観測する。
    rmSync(join(cwd, '.takt', 'goals'), { recursive: true });
    const task = runner.addTask('ordinary pending task', { workflow: 'loop-fixture', worktree: false });
    const scenario = join(cwd, 'concurrent-scenario.json');
    writeFileSync(scenario, JSON.stringify([{ persona: 'coder', status: 'done', content: 'completed once', delay_ms: 300 }]));
    vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
    const spawn = observeSpawn();
    const sessions = Array.from({ length: 2 }, () => createManagerConversationSession({
      cwd, plan: createManagerConversationPlan(cwd, {}),
      confirmation: createGoalConfirmation(cwd), mcpClient: { callTool: vi.fn() },
    }));
    try {
      const turns = await Promise.all(sessions.map((session) => session.handleUserMessage({ text: '作業を進めてください' })));
      expect(turns.map(({ kind }) => kind)).toEqual(['reply', 'reply']);
      expect(spawn.mock.calls.filter(([, args]) => Array.isArray(args) && args.includes('run'))).toHaveLength(1);
      await vi.waitFor(() => {
        expect(new TaskRunner(cwd).listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([{ name: task.name, kind: 'completed' }]);
      }, { timeout: 15000 });
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await stopOwnedProcesses();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { crashBeforeAdoption: false, enqueueAfterDrain: false },
    { crashBeforeAdoption: true, enqueueAfterDrain: false },
    { crashBeforeAdoption: false, enqueueAfterDrain: true },
  ])('runs registration, MCP enqueue and task completions after the conversation parent exits: %j', async ({ crashBeforeAdoption, enqueueAfterDrain }) => {
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
if (process.argv.includes('run') && process.env.TAKT_TEST_HOLD_ADOPTION === '1') {
  writeProcessMarker(join(root, '.takt', 'before-adoption'));
  const deadline = Date.now() + 20000;
  while (!existsSync(join(root, '.takt', 'release-adoption'))) {
    if (Date.now() > deadline) throw new Error('Test did not release adoption');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
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
        TAKT_TEST_HOLD_ADOPTION: crashBeforeAdoption ? '1' : '0',
        TAKT_TEST_HOLD_DRAIN: enqueueAfterDrain ? '1' : '0',
        GIT_AUTHOR_NAME: 'Loop Test', GIT_AUTHOR_EMAIL: 'loop@example.test',
        GIT_COMMITTER_NAME: 'Loop Test', GIT_COMMITTER_EMAIL: 'loop@example.test',
      },
    };
    const parent = trackProcess(childProcess.spawn(process.execPath, ['--input-type=module', '--eval', parentSource], parentOptions));
    let recoveryParent: childProcess.ChildProcess | undefined;
    let stdout = '';
    let stderr = '';
    parent.stdout.on('data', (chunk) => { stdout += String(chunk); });
    parent.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exit = new Promise<number | null>((resolve, reject) => { parent.once('error', reject); parent.once('exit', resolve); });
    try {
      if (crashBeforeAdoption) {
        const beforeAdoption = join(cwd, '.takt', 'before-adoption');
        await vi.waitFor(() => expect(existsSync(beforeAdoption)).toBe(true), { timeout: 15000 });
        const child = readOwnedProcessMarker(readFileSync(beforeAdoption, 'utf8'));
        signalOwnedProcess((await children.get(parent)!.owned)!, 'SIGKILL', () => parent.exitCode !== null || parent.signalCode !== null);
        await exit;
        signalOwnedProcess(child, 'SIGKILL', () => false);
        recoveryParent = trackProcess(childProcess.spawn(process.execPath, ['--input-type=module', '--eval', parentSource], {
          ...parentOptions, env: { ...parentOptions.env, TAKT_TEST_HOLD_ADOPTION: '0', TAKT_TEST_RECOVER_ONLY: '1' },
        }));
        let recoveryError = '';
        recoveryParent.stderr!.on('data', (chunk) => { recoveryError += String(chunk); });
        await vi.waitFor(() => expect(recoveryParent!.exitCode, recoveryError).not.toBeNull(), { timeout: 15000 });
        expect(recoveryParent.exitCode, recoveryError).toBe(0);
      } else {
        await vi.waitFor(() => {
          const state = JSON.stringify(readManagerRunState(cwd));
          expect(parent.exitCode, `${stderr}\n${stdout}\n${state}`).not.toBeNull();
        }, { timeout: 15000 });
        expect(await exit, stderr).toBe(0);
        expect(stdout).toContain('parent-finished');
      }
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
      try { console.error('Saved loop state', { runState: readManagerRunState(cwd), tasks: new TaskStore(cwd).read().tasks }); }
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
      expect(JSON.parse(firstTextContent(detail.content))).toEqual({ goal: { ...created, sessions: [] } });
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
        'takt_enqueue_goal_task', 'takt_list_workflows', 'takt_record_goal_decision',
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
