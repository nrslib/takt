import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BuiltinProjectRuntime } from '../features/workerPool/builtinProjectRuntime.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { getProjectExecutionOwner } from '../infra/task/project-execution-lock.js';
import { readManagerEvents } from '../infra/goals/events.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { deferred } from './helpers/controlledDaemon.js';
import { BuiltinWorkerAdapter } from '../infra/worker-pool/builtinWorkerAdapter.js';
import { TaskDispatcher } from '../features/daemon/taskDispatcher.js';
import { TaskClaimLockAcquisitionError } from '../infra/task/taskLifecycleService.js';
import type { TaskInfo } from '../infra/task/types.js';
import { prepareTaskSpecDirectory } from '../infra/task/enqueueService.js';
import * as privateFiles from '../shared/utils/private-file.js';
import { parse as parseYaml } from 'yaml';
import { setGoalExecutionStatus } from '../infra/goals/execution.js';
import type { TaskRecord } from '../infra/task/schema.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const doubles = vi.hoisted(() => ({ execute: vi.fn(), preflight: vi.fn(), terminate: vi.fn(), cleanup: vi.fn() }));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({ executeRunTaskAndCompleteWithDetails: doubles.execute }));
vi.mock('../features/tasks/execute/providerPreflight.js', () => ({ checkQueuedTaskProviders: doubles.preflight }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync), writeFileSync: vi.fn(actual.writeFileSync), closeSync: vi.fn(actual.closeSync) };
});
vi.mock('../shared/utils/spawn.js', async (original) => ({
  ...await original<typeof import('../shared/utils/spawn.js')>(), terminateManagedProcesses: doubles.terminate,
}));
vi.mock('../infra/opencode/server-pool.js', async (original) => ({
  ...await original<typeof import('../infra/opencode/server-pool.js')>(), prepareSharedServerPoolForForcedShutdown: doubles.cleanup,
}));
let cwd: string;
let runtime: BuiltinProjectRuntime;
let runner: TaskRunner;
const finished = vi.fn();
const fatal = vi.fn();

async function enableRemote(origin = 'https://example.test/repo.git') {
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'test'], ['config', 'user.email', 'test@example.test'],
    ['commit', '--allow-empty', '-m', 'fixture'], ['branch', goalRecord().branch], ['remote', 'add', 'origin', origin]]) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }
  await runtime.close(); runtime = new BuiltinProjectRuntime(cwd, finished, fatal, true);
  return (taskName: string) => runtime.remote({ kind: 'claim', taskName, workerId: 'w1', registrationGeneration: randomUUID(),
    requestId: randomUUID(), leaseExpiresAt: Date.now() + 60_000 });
}

it.each(['task_dir', 'content_file'] as const)('fails unreadable remote %s input and then claims readable work', async (input) => {
  const claim = await enableRemote();
  const prepared = prepareTaskSpecDirectory(cwd, 'missing remote input');
  const missing = runner.addTask('missing remote input', { goal_id: goalRecord().id, task_dir: prepared.taskDirRelative });
  const file = join(prepared.taskDir, 'order.md'); rmSync(file);
  if (input === 'content_file') new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) => task.name === missing.name
    ? { ...task, task_dir: undefined, content_file: file } : task) }));
  const next = runner.addTask('readable remote input', { goal_id: goalRecord().id });
  await runtime.inspect();
  expect(await claim(missing.name)).toEqual({ kind: 'claim', assignment: null });
  const failed = new TaskStore(cwd).read().tasks.find((task) => task.name === missing.name)!;
  expect(failed).toMatchObject({ status: 'failed', failure: { error: expect.any(String) }, run_slug: expect.any(String),
    completion: { success: false, workflowResult: 'error' } });
  expect(readManagerEvents(cwd)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
    kind: 'completion', taskName: missing.name, runSlug: failed.run_slug, result: failed.completion,
  }) }));
  expect(await claim(next.name)).toMatchObject({ kind: 'claim', assignment: { taskName: next.name } });
  expect(doubles.preflight).not.toHaveBeenCalled();
});

it('keeps recovered remote input pending at recheck and claims it only on the next attempt', async () => {
  const claim = await enableRemote();
  const prepared = prepareTaskSpecDirectory(cwd, 'recovering remote input');
  const task = runner.addTask('recovering remote input', { goal_id: goalRecord().id, task_dir: prepared.taskDirRelative });
  const file = join(prepared.taskDir, 'order.md'); rmSync(file);
  const recheck = TaskRunner.prototype.failUnreadableGoalTask;
  vi.spyOn(TaskRunner.prototype, 'failUnreadableGoalTask').mockImplementation(function (this: TaskRunner, name) {
    writeFileSync(file, 'recovered remote input'); return recheck.call(this, name);
  });
  expect(await claim(task.name)).toEqual({ kind: 'claim', assignment: null });
  expect(new TaskStore(cwd).read().tasks[0]!.status).toBe('pending');
  expect(readManagerEvents(cwd)).toEqual([]);
  expect(await claim(task.name)).toMatchObject({ kind: 'claim', assignment: { taskName: task.name } });
  expect(doubles.preflight).not.toHaveBeenCalled();
});

it.each(['paused', 'aborted'] as const)('does not fail unreadable remote content when the goal becomes %s after inspection', async (executionStatus) => {
  const claim = await enableRemote();
  const prepared = prepareTaskSpecDirectory(cwd, 'ineligible remote input');
  const task = runner.addTask('ineligible remote input', { goal_id: goalRecord().id, task_dir: prepared.taskDirRelative });
  rmSync(join(prepared.taskDir, 'order.md'));
  expect(await runtime.inspect()).toMatchObject({ tasks: [{ taskName: task.name }] });
  await new GoalStore(cwd).update(goalRecord().id, (goal) => ({ ...goal, executionStatus }));
  expect(await claim(task.name)).toEqual({ kind: 'claim', assignment: null });
  expect(new TaskStore(cwd).read().tasks[0]!.status).toBe('pending');
  expect(readManagerEvents(cwd)).toEqual([]);
});

it('strips origin userinfo before the real project runtime exposes its candidate snapshot', async () => {
  await enableRemote('https://fixture:credential@example.test/repo.git');
  runner.addTask('origin snapshot', { goal_id: goalRecord().id });
  const snapshot = await runtime.inspect();
  expect(snapshot).toMatchObject({ tasks: [{ origin: 'https://example.test/repo.git' }] });
  expect(JSON.stringify(snapshot)).not.toMatch(/fixture:|credential/);
});
beforeEach(async () => {
  vi.clearAllMocks();
  doubles.preflight.mockResolvedValue(undefined);
  doubles.terminate.mockResolvedValue(undefined);
  doubles.cleanup.mockResolvedValue(undefined);
  cwd = mkdtempSync(join(getGlobalConfigDir(), 'builtin-runtime-'));
  mkdirSync(join(cwd, '.takt'));
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nconcurrency: 3\n');
  invalidateGlobalConfigCache();
  await new GoalStore(cwd).create(goalRecord());
  runner = new TaskRunner(cwd, { goalTasksOnly: true });
  runtime = new BuiltinProjectRuntime(cwd, finished, fatal);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.close();
  rmSync(cwd, { recursive: true, force: true });
});

it.each(['preparation', 'execution'] as const)('retains resolved settings during %s and refreshes the next group', async (stage) => {
  const globalFile = join(getGlobalConfigDir(), 'config.yaml');
  writeFileSync(globalFile, 'provider: mock\nconcurrency: 3\nignore_exceed: false\n');
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\n');
  invalidateGlobalConfigCache();
  const tasks = ['first', 'second', 'next'].map((content) => runner.addTask(content, { goal_id: goalRecord().id }));
  const preparation = deferred<void>();
  const execution = deferred<void>();
  doubles.preflight.mockImplementation(async (_cwd, task: TaskInfo) => {
    if (stage === 'preparation' && task.name === tasks[0]!.name) await preparation.promise;
  });
  doubles.execute.mockImplementation(async (task: TaskInfo, executingRunner: TaskRunner) => {
    if (task.name !== tasks[2]!.name) await execution.promise;
    const completion = { success: true, interrupted: false, workflowResult: 'completed' as const };
    executingRunner.completeTask({ task, success: true, completion, response: 'done', executionLog: [],
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    return { completion, runSlug: `run-${task.name}` };
  });
  try {
    expect(await runtime.inspect()).toMatchObject({ concurrency: 3 });
    const starting = runtime.start(tasks[0]!.name, 'builtin');
    if (stage === 'preparation') await vi.waitFor(() => expect(doubles.preflight).toHaveBeenCalledOnce());
    else expect(await starting).toEqual({ kind: 'started' });
    writeFileSync(globalFile, 'provider: mock\nconcurrency: 1\nignore_exceed: true\n');
    expect(await runtime.inspect()).toMatchObject({ concurrency: 3 });
    preparation.resolve();
    expect(await starting).toEqual({ kind: 'started' });
    expect(await runtime.start(tasks[1]!.name, 'builtin')).toEqual({ kind: 'started' });
    expect(await runtime.inspect()).toMatchObject({ concurrency: 3 });
    expect(doubles.execute.mock.calls.slice(0, 2).map((args) => args[5])).toEqual([undefined, undefined]);
    execution.resolve();
    await vi.waitFor(() => {
      expect(finished).toHaveBeenCalledTimes(2);
      expect(getProjectExecutionOwner(cwd)).toBeUndefined();
    });
    expect(await runtime.inspect()).toMatchObject({ concurrency: 1 });
    expect(await runtime.start(tasks[2]!.name, 'builtin')).toEqual({ kind: 'started' });
    await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(3));
    expect(doubles.execute.mock.calls[2]![5]).toEqual({ ignoreIterationLimit: true });
    expect(runner.listTaskStateItems().map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
  } finally {
    preparation.resolve();
    execution.resolve();
  }
});

it.each(['success', 'preparation', 'preparation ENOSPC', 'claim lock', 'claim persistence ENOSPC'] as const)(
  'keeps A running and saves its result when B has %s', async (condition) => {
    const a = runner.addTask('A', { goal_id: goalRecord().id });
    const b = runner.addTask('B', { goal_id: goalRecord().id });
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    let executionId: string | undefined;
    doubles.execute.mockImplementation(async (task: TaskInfo, executingRunner: TaskRunner, _cwd, _options, options) => {
      if (task.name === a.name) {
        signal = options.abortSignal;
        executionId = task.executionId;
        await Promise.race([release.promise, new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))]);
      }
      const completion = { success: !options.abortSignal.aborted, interrupted: options.abortSignal.aborted,
        workflowResult: 'completed' as const };
      const result = { task, success: completion.success, completion, response: 'done', executionLog: [],
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
      if (completion.success) executingRunner.completeTask(result);
      else executingRunner.failTask(result);
      return { completion, runSlug: `run-${task.name}` };
    });
    doubles.preflight.mockImplementation(async (_cwd, task: TaskInfo) => {
      if (task.name === b.name) expect(signal).toBeDefined();
      if (condition.startsWith('preparation') && task.name === b.name) {
        throw Object.assign(new Error('provider preparation failed'), condition.endsWith('ENOSPC') ? { code: 'ENOSPC' } : {});
      }
    });
    const originalClaim = TaskRunner.prototype.claimTask;
    let diskFull = condition === 'claim lock';
    const claims = vi.spyOn(TaskRunner.prototype, 'claimTask').mockImplementation(function (this: TaskRunner, name, worker) {
      if (diskFull && name === b.name) throw new TaskClaimLockAcquisitionError('disk full');
      if (condition === 'claim persistence ENOSPC' && name === b.name) throw Object.assign(new Error('cannot persist claim'), { code: 'ENOSPC' });
      return originalClaim.call(this, name, worker);
    });
    await runtime.close();
    const errors = vi.fn();
    const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency: 2 })], projects: async () => [cwd], wake: vi.fn(), onError: errors,
      factory: { create(_cwd, done) {
        runtime = new BuiltinProjectRuntime(cwd, (name) => { finished(name); done(name); }, fatal);
        return { inspect: () => runtime.inspect(), setWaitingReasons: (reasons) => runtime.setWaitingReasons(reasons), start: (name, worker) => runtime.start(name, worker),
          close: async () => { await runtime.close(); done(); } };
      } },
    });
    try {
      await pool.dispatch();
      expect(signal).toBeDefined();
      expect(signal!.aborted).toBe(false);
      expect(executionId).toEqual(expect.any(String));
      expect(fatal).not.toHaveBeenCalled();
      expect(new TaskStore(cwd).read().tasks.find((task) => task.name === a.name)?.status).toBe('running');
      release.resolve();
      await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(a.name));
      expect(new TaskStore(cwd).read().tasks.find((task) => task.name === a.name)?.completion)
        .toMatchObject({ success: true, interrupted: false });
      expect(new TaskStore(cwd).read().tasks.find((task) => task.name === a.name)?.execution_id).toBe(executionId);
      expect(readManagerEvents(cwd)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ taskName: a.name }) }));
      if (condition !== 'success') expect(new TaskStore(cwd).read().tasks.find((task) => task.name === b.name)?.status).toBe('pending');
      expect(claims.mock.calls.filter(([name]) => name === a.name)).toHaveLength(1);
      if (condition === 'claim lock') {
        const attempted = claims.mock.calls.filter(([name]) => name === b.name).length;
        await pool.dispatch();
        expect(claims.mock.calls.filter(([name]) => name === b.name)).toHaveLength(attempted);
        diskFull = false;
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 5_001);
        await pool.dispatch();
        await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(b.name));
        expect(claims.mock.calls.filter(([name]) => name === b.name)).toHaveLength(attempted + 1);
        expect(new TaskStore(cwd).read().tasks.find((task) => task.name === b.name)?.completion)
          .toMatchObject({ success: true, interrupted: false });
      }
    } finally { release.resolve(); await pool.close(); }
  });

it.each([
  { operation: 'claim', stage: 'success', change: 'none' },
  ...['claim', 'waiting', 'recovery read', 'candidate read', 'start read'].flatMap((operation) =>
    ['create', 'metadata'].map((stage) => ({ operation, stage, change: 'none' }))),
  ...['removed', 'paused', 'aborted'].map((change) => ({ operation: 'claim', stage: 'create', change })),
])('preserves A through continuing $stage ENOSPC in $operation and rechecks $change on recovery', async ({ operation, stage, change }) => {
  const a = runner.addTask('A', { goal_id: goalRecord().id });
  const release = deferred<void>();
  let signal: AbortSignal | undefined;
  doubles.execute.mockImplementation(async (task: TaskInfo, executingRunner: TaskRunner, _cwd, _options, options) => {
    if (task.name === a.name) {
      signal = options.abortSignal;
      await Promise.race([release.promise, new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))]);
    }
    const completion = { success: !options.abortSignal.aborted, interrupted: options.abortSignal.aborted, workflowResult: 'completed' as const };
    if (!options.abortSignal.aborted) executingRunner.completeTask({ task, success: completion.success, completion, response: 'done', executionLog: [],
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    return { completion, runSlug: `run-${task.name}` };
  });
  await runtime.close();
  const closes = vi.fn();
  const creates = vi.fn();
  let armed = false;
  let full = false;
  let readCount = 0;
  const lockPath = `${runner.getTasksFilePath()}.lock`;
  const descriptors = new Set<number>();
  const failures: string[] = [];
  const responses: { operation: string; result: unknown }[] = [];
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.closeSync).mockImplementation((descriptor) => { descriptors.delete(descriptor); actualFs.closeSync(descriptor); });
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    if (path === lockPath && flags === 'wx') {
      readCount++;
      if (armed && (operation === 'recovery read' || operation === 'candidate read') && readCount === (operation === 'candidate read' ? 2 : 1)) full = true;
      if (full && stage === 'create') { failures.push(String(path)); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
      const descriptor = actualFs.openSync(path, flags, mode);
      descriptors.add(descriptor);
      return descriptor;
    }
    return actualFs.openSync(path, flags, mode);
  });
  vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
    if (typeof file === 'number' && descriptors.has(file) && full && stage === 'metadata') {
      failures.push(`${lockPath} fd=${file}`);
      actualFs.writeFileSync(file, '{');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return actualFs.writeFileSync(file, data, options);
  });
  const worker = { name: 'builtin', kind: 'builtin' as const, concurrency: operation === 'waiting' ? 1 : 2 };
  const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter(worker)], projects: async () => [cwd], wake: vi.fn(), onError: vi.fn(),
    factory: { create(_cwd, done) {
      creates();
      runtime = new BuiltinProjectRuntime(cwd, (name) => { finished(name); done(name); }, fatal);
      return {
        inspect: async () => {
          readCount = 0;
          const result = await runtime.inspect(); responses.push({ operation: 'inspect', result }); return result;
        },
        setWaitingReasons: async (reasons) => {
          if (armed && operation === 'waiting') full = true;
          const result = await runtime.setWaitingReasons(reasons); responses.push({ operation: 'waiting', result }); return result;
        },
        start: async (name, workerName) => {
          if (armed && operation === 'start read') full = true;
          const result = await runtime.start(name, workerName); responses.push({ operation: 'start', result }); return result;
        },
        close: async () => { closes(); await runtime.close(); done(); },
      };
    } },
  });
  try {
    await pool.dispatch();
    expect(signal?.aborted).toBe(false);
    const identity = new TaskStore(cwd).read().tasks[0]!.execution_id;
    const b = runner.addTask('B', { goal_id: goalRecord().id });
    armed = stage !== 'success';
    responses.length = 0;
    doubles.preflight.mockImplementation(async (_cwd, task: TaskInfo) => { if (armed && operation === 'claim' && task.name === b.name) full = true; });
    await pool.dispatch();
    expect(signal?.aborted).toBe(false);
    expect(closes).not.toHaveBeenCalled();
    if (armed) {
      expect(failures).toHaveLength(1);
      expect(responses).toContainEqual({ operation: operation.endsWith('read') && operation !== 'start read' ? 'inspect'
        : operation === 'waiting' ? 'waiting' : 'start', result: { kind: 'claim_retry', retryAt: expect.any(Number) } });
      expect(pool.activeTaskCount).toBe(1);
      const firstFailureCount = failures.length;
      await pool.dispatch();
      expect(failures).toHaveLength(firstFailureCount);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001);
      await pool.dispatch();
      expect(failures).toHaveLength(firstFailureCount + 1);
      expect(signal?.aborted).toBe(false);
      expect(pool.activeTaskCount).toBe(1);
      expect(closes).not.toHaveBeenCalled();
      const saved = parseYaml(actualFs.readFileSync(runner.getTasksFilePath(), 'utf8')) as { tasks: { name: string; status: string; execution_id?: string }[] };
      expect(saved.tasks).toContainEqual(expect.objectContaining({ name: a.name, status: 'running', execution_id: identity }));
      expect(saved.tasks).toContainEqual(expect.objectContaining({ name: b.name, status: 'pending' }));
      expect(getProjectExecutionOwner(cwd)?.pid).toBe(process.pid);
      expect(doubles.execute.mock.calls.map(([task]) => (task as TaskInfo).name)).toEqual([a.name]);
      expect(actualFs.existsSync(lockPath)).toBe(false);
      full = false;
      armed = false;
      clock.mockReturnValue(Date.now() + 5_001);
    }
    if (change === 'removed') runner.deleteTask(b.name, 'pending');
    else if (change === 'paused' || change === 'aborted') {
      await new GoalStore(cwd).update(goalRecord().id, (goal) => ({ ...goal, executionStatus: change }));
    }
    release.resolve();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(a.name));
    await pool.dispatch();
    if (change === 'none') await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(b.name));
    expect(doubles.execute.mock.calls.filter(([task]) => (task as TaskInfo).name === b.name)).toHaveLength(change === 'none' ? 1 : 0);
    expect(creates).toHaveBeenCalledOnce();
    const saved = new TaskStore(cwd).read().tasks;
    expect(saved).toContainEqual(expect.objectContaining({ name: a.name, execution_id: identity,
      status: 'completed', completion: expect.objectContaining({ success: true, interrupted: false }) }));
    if (change === 'removed') expect(saved.find((task) => task.name === b.name)).toBeUndefined();
    else expect(saved.find((task) => task.name === b.name)?.status).toBe(change === 'none' ? 'completed' : 'pending');
    expect(readManagerEvents(cwd)).toHaveLength(change === 'none' ? 2 : change === 'aborted' ? 0 : 1);
  } finally { full = false; armed = false; release.resolve(); await pool.close(); }
});

it.each([
  { operation: 'unreadable', stage: 'success', restore: false },
  { operation: 'goal claim', stage: 'success', restore: false },
  { operation: 'paused claim', stage: 'success', restore: false },
  { operation: 'failed claim', stage: 'success', restore: false },
  ...['unreadable', 'goal claim'].flatMap((operation) => ['create', 'metadata'].map((stage) => ({ operation, stage, restore: false }))),
  { operation: 'unreadable', stage: 'create', restore: true },
  { operation: 'paused claim', stage: 'create', restore: false },
  { operation: 'failed claim', stage: 'create', restore: false },
])('preserves A and delivers the saved result through $operation with $stage ENOSPC, restore=$restore', async ({ operation, stage, restore }) => {
  const otherGoal = { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' };
  await new GoalStore(cwd).create(otherGoal);
  const a = runner.addTask('A', { goal_id: goalRecord().id });
  const release = deferred<void>();
  const prepared = deferred<void>();
  const preparing = deferred<void>();
  let signal: AbortSignal | undefined;
  doubles.execute.mockImplementation(async (task: TaskInfo, executingRunner: TaskRunner, _cwd, _options, options) => {
    if (task.name === a.name) {
      signal = options.abortSignal;
      await Promise.race([release.promise, new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))]);
    }
    const completion = { success: !options.abortSignal.aborted, interrupted: options.abortSignal.aborted, workflowResult: 'completed' as const };
    if (completion.success) executingRunner.completeTask({ task, success: true, completion, response: 'done', executionLog: [],
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    return { completion, runSlug: `run-${task.name}` };
  });
  await runtime.close();
  const closes = vi.fn();
  const creates = vi.fn();
  const responses: unknown[] = [];
  const pool = new TaskDispatcher({ workers: [new BuiltinWorkerAdapter({ name: 'builtin', kind: 'builtin', concurrency: 2 })],
    projects: async () => [cwd], wake: vi.fn(), onError: vi.fn(), factory: { create(_cwd, done) {
      creates();
      runtime = new BuiltinProjectRuntime(cwd, (name) => { finished(name); done(name); }, fatal);
      return { inspect: () => runtime.inspect(), setWaitingReasons: (reasons) => runtime.setWaitingReasons(reasons),
        start: async (name, worker) => { const result = await runtime.start(name, worker); responses.push(result); return result; },
        close: async () => { closes(); await runtime.close(); done(); } };
    } },
  });
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const taskLock = `${runner.getTasksFilePath()}.lock`;
  const goalLock = join(cwd, '.takt', 'goal-execution.lock');
  const descriptors = new Set<number>();
  const failures: string[] = [];
  let full = false;
  const goalFailure = operation === 'unreadable' || operation === 'goal claim';
  vi.mocked(fs.closeSync).mockImplementation((descriptor) => { descriptors.delete(descriptor); actual.closeSync(descriptor); });
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    const target = flags === 'wx' && (goalFailure ? String(path).startsWith(join(cwd, '.takt', '.goal-execution.lock.')) : path === taskLock);
    if (target && full && stage === 'create') {
      failures.push(String(path)); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    const descriptor = actual.openSync(path, flags, mode);
    if (target) descriptors.add(descriptor);
    return descriptor;
  });
  vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
    if (typeof file === 'number' && descriptors.has(file) && full && stage === 'metadata') {
      failures.push(`${goalLock} fd=${file}`); actual.writeFileSync(file, '{');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return actual.writeFileSync(file, data, options);
  });
  const saved = () => (parseYaml(actual.readFileSync(runner.getTasksFilePath(), 'utf8')) as { tasks: TaskRecord[] }).tasks;
  try {
    await pool.dispatch();
    expect(signal?.aborted).toBe(false);
    const identity = saved().find((task) => task.name === a.name)!.execution_id;
    const spec = prepareTaskSpecDirectory(cwd, 'B');
    const b = runner.addTask('B', { goal_id: otherGoal.id, task_dir: spec.taskDirRelative });
    const file = join(spec.taskDir, 'order.md');
    if (operation === 'unreadable') { rmSync(file); full = stage !== 'success'; }
    else {
      doubles.preflight.mockImplementation(async (_cwd, task: TaskInfo) => {
        if (task.name === b.name) { preparing.resolve(); await prepared.promise; }
      });
      const originalClaim = TaskRunner.prototype.claimTask;
      vi.spyOn(TaskRunner.prototype, 'claimTask').mockImplementation(function (this: TaskRunner, name, worker) {
        const result = originalClaim.call(this, name, worker);
        if (name === b.name && !goalFailure) full = stage !== 'success';
        return result;
      });
    }
    const dispatch = pool.dispatch();
    if (operation !== 'unreadable') {
      await preparing.promise;
      if (operation === 'paused claim') await setGoalExecutionStatus(cwd, otherGoal.id, 'paused', new AbortController().signal, 'manager');
      if (operation === 'failed claim') rmSync(file);
      if (operation === 'goal claim') full = stage !== 'success';
      prepared.resolve();
    }
    await dispatch;
    expect(signal?.aborted).toBe(false);
    expect(closes).not.toHaveBeenCalled();
    expect(getProjectExecutionOwner(cwd)?.pid).toBe(process.pid);
    expect(saved()).toContainEqual(expect.objectContaining({ name: a.name, status: 'running', execution_id: identity }));
    if (goalFailure && full) {
      expect(pool.activeTaskCount).toBe(1);
      expect(failures).toHaveLength(1);
      expect(responses).toContainEqual({ kind: 'claim_retry', retryAt: expect.any(Number) });
      expect(saved().find((task) => task.name === b.name)?.status).toBe('pending');
      expect(readManagerEvents(cwd)).toEqual([]);
      expect(actual.existsSync(goalLock)).toBe(false);
      expect(actual.readdirSync(join(cwd, '.takt')).filter((name) => name.startsWith('.goal-execution.lock.'))).toEqual([]);
      await pool.dispatch();
      expect(failures).toHaveLength(1);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001);
      await pool.dispatch();
      expect(failures).toHaveLength(2);
      expect(signal?.aborted).toBe(false);
      expect(pool.activeTaskCount).toBe(1);
      expect(closes).not.toHaveBeenCalled();
      full = false;
      if (restore) writeFileSync(file, 'restored B');
      clock.mockReturnValue(Date.now() + 5_001);
      await pool.dispatch();
      if (restore) {
        await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(b.name));
        expect(doubles.preflight.mock.calls.filter(([, task]) => task.name === b.name)).toHaveLength(1);
      }
    }
    const failedB = operation === 'failed claim' || operation === 'unreadable' && !restore;
    if (failedB) {
      const terminal = saved().find((task) => task.name === b.name)!;
      expect(terminal).toMatchObject({ status: 'failed', failure: { error: expect.stringContaining(file) },
        run_slug: expect.stringMatching(/^setup-/), completion: { success: false, interrupted: false, workflowResult: 'error' } });
      const events = readManagerEvents(cwd).filter(({ event }) => event.kind === 'completion' && event.taskName === b.name);
      expect(events).toMatchObject([{ event: { runSlug: terminal.run_slug, result: terminal.completion } }]);
      await pool.dispatch();
      expect(saved().find((task) => task.name === b.name)).toEqual(terminal);
      expect(readManagerEvents(cwd).filter(({ event }) => event.kind === 'completion' && event.taskName === b.name)).toHaveLength(1);
    } else if (operation === 'paused claim') {
      expect(saved().find((task) => task.name === b.name)?.status).toBe('pending');
      expect(readManagerEvents(cwd)).toEqual([]);
      await pool.dispatch();
      expect(signal?.aborted).toBe(false);
    } else await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(b.name));
    expect(doubles.execute.mock.calls.filter(([task]) => task.name === b.name)).toHaveLength(failedB || operation === 'paused claim' ? 0 : 1);
    full = false;
    release.resolve();
    await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(a.name));
    expect(saved().find((task) => task.name === a.name)).toMatchObject({ status: 'completed', execution_id: identity,
      completion: { success: true, interrupted: false } });
    expect(creates).toHaveBeenCalledOnce();
  } finally { full = false; prepared.resolve(); release.resolve(); await pool.close(); }
});

it.each(['recheck', 'claim'] as const)('does not notify an unreadable failure when its %s body was not saved', async (operation) => {
  const spec = prepareTaskSpecDirectory(cwd, 'missing input');
  const task = runner.addTask('missing input', { goal_id: goalRecord().id, task_dir: spec.taskDirRelative });
  const file = join(spec.taskDir, 'order.md');
  if (operation === 'recheck') rmSync(file);
  else doubles.preflight.mockImplementation(async () => { rmSync(file); });
  const failure = Object.assign(new Error('cannot persist failed task'), { code: 'ENOSPC' });
  vi.spyOn(privateFiles, 'writePrivateFileWithMode').mockImplementation(() => { throw failure; });
  if (operation === 'recheck') await expect(runtime.start(task.name, 'builtin')).rejects.toBe(failure);
  else expect(await runtime.start(task.name, 'builtin')).toMatchObject({ kind: 'preparation_failed' });
  expect(runner.listTaskStateItems()[0]).toMatchObject({ status: 'pending', name: task.name });
  expect(runner.listTaskStateItems()[0]?.completion).toBeUndefined();
  expect(readManagerEvents(cwd)).toEqual([]);
  expect(doubles.execute).not.toHaveBeenCalled();
});

it('keeps operation-specific acquisition handlers and native errors for stores without a handler', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  const converted = new TaskClaimLockAcquisitionError('acquisition', { cause: failure });
  const handler = vi.fn((_error: unknown): never => { throw converted; });
  const operationFailure = new Error('operation-specific failure');
  const operationHandler = vi.fn((_error: unknown): never => { throw operationFailure; });
  const store = new TaskStore(cwd, handler);
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    if (path === `${runner.getTasksFilePath()}.lock` && flags === 'wx') throw failure;
    return actualFs.openSync(path, flags, mode);
  });
  expect(() => store.read()).toThrow(converted);
  expect(() => store.update(() => undefined)).toThrow(converted);
  expect(handler).toHaveBeenCalledTimes(2);
  expect(() => store.update(() => undefined, { onAcquisitionError: operationHandler })).toThrow(operationFailure);
  expect(operationHandler).toHaveBeenCalledExactlyOnceWith(failure);
  expect(handler).toHaveBeenCalledTimes(2);
  expect(() => new TaskStore(cwd).read()).toThrow(failure);
  vi.mocked(fs.openSync).mockImplementation(actualFs.openSync);
  expect(store.read()).toEqual({ tasks: [] });
});

it('propagates waiting-reason body persistence ENOSPC instead of reporting acquisition retry', async () => {
  const task = runner.addTask('pending', { goal_id: goalRecord().id });
  const failure = Object.assign(new Error('cannot persist task body'), { code: 'ENOSPC' });
  vi.spyOn(privateFiles, 'writePrivateFileWithMode').mockImplementation((file) => {
    expect(file).toBe(runner.getTasksFilePath());
    throw failure;
  });
  await expect(runtime.setWaitingReasons([{ taskName: task.name, reason: 'waiting' }])).rejects.toBe(failure);
  expect(runner.listTaskStateItems()[0]?.waitingReason).toBeUndefined();
});

it.each(['task_dir', 'content_file'] as const)('saves unreadable %s goal input and still executes readable work', async (input) => {
  const prepared = prepareTaskSpecDirectory(cwd, 'unreadable work');
  const file = input === 'task_dir' ? join(prepared.taskDir, 'order.md') : join(cwd, 'external-order.md');
  writeFileSync(file, 'unreadable work');
  const unreadable = runner.addTask('unreadable work', { goal_id: goalRecord().id,
    ...(input === 'task_dir' ? { task_dir: prepared.taskDirRelative } : {}) });
  if (input === 'content_file') new TaskStore(cwd).update((state) => ({ tasks: state.tasks.map((task) =>
    task.name === unreadable.name ? { ...task, content: undefined, content_file: file } : task) }));
  rmSync(file);
  const readable = runner.addTask('readable work', { goal_id: goalRecord().id });
  doubles.execute.mockImplementation(async (task: TaskInfo, executingRunner: TaskRunner) => {
    const completion = { success: true, interrupted: false, workflowResult: 'completed' as const };
    executingRunner.completeTask({ task, success: true, completion, response: 'done', executionLog: [],
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    return { completion, runSlug: 'readable-run' };
  });
  expect(await runtime.inspect()).toMatchObject({ tasks: [
    { taskName: unreadable.name }, { taskName: readable.name },
  ] });
  expect(await runtime.start(unreadable.name, 'builtin')).toEqual({ kind: 'declined' });
  const failed = new TaskStore(cwd).read().tasks.find((task) => task.name === unreadable.name)!;
  expect(failed).toMatchObject({ status: 'failed', failure: { error: expect.stringContaining(file) },
    run_slug: expect.stringMatching(/^setup-/), completion: { success: false, interrupted: false, workflowResult: 'error' } });
  expect(doubles.preflight).not.toHaveBeenCalled();
  expect(readManagerEvents(cwd)).toContainEqual(expect.objectContaining({ event: expect.objectContaining({
    kind: 'completion', taskName: unreadable.name, runSlug: failed.run_slug, result: failed.completion,
  }) }));
  expect(await runtime.start(readable.name, 'builtin')).toEqual({ kind: 'started' });
  await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(readable.name));
  expect(new TaskStore(cwd).read().tasks.find((task) => task.name === readable.name)?.status).toBe('completed');
  expect(doubles.preflight).toHaveBeenCalledOnce();
});

it('leaves restored content pending for normal preparation instead of claiming it without preflight', async () => {
  const spec = prepareTaskSpecDirectory(cwd, 'temporarily missing');
  const task = runner.addTask('temporarily missing', { goal_id: goalRecord().id, task_dir: spec.taskDirRelative });
  const file = join(spec.taskDir, 'order.md');
  rmSync(file);
  const recheck = TaskRunner.prototype.failUnreadableGoalTask;
  vi.spyOn(TaskRunner.prototype, 'failUnreadableGoalTask').mockImplementation(function (this: TaskRunner, name) {
    writeFileSync(file, 'restored input');
    return recheck.call(this, name);
  });
  expect(await runtime.start(task.name, 'builtin')).toEqual({ kind: 'declined' });
  expect(runner.listTaskStateItems()[0]?.status).toBe('pending');
  expect(doubles.preflight).not.toHaveBeenCalled();
  expect(doubles.execute).not.toHaveBeenCalled();
  doubles.execute.mockResolvedValue({ completion: { success: true, interrupted: false }, runSlug: 'restored-run' });
  expect(await runtime.start(task.name, 'builtin')).toEqual({ kind: 'started' });
  await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(task.name));
  expect(doubles.preflight).toHaveBeenCalledOnce();
  expect(readManagerEvents(cwd)).toHaveLength(1);
});

it.each(['paused', 'aborted', 'unreadable goal'] as const)('keeps %s distinct from unreadable task content', async (condition) => {
  const task = runner.addTask('work', { goal_id: goalRecord().id });
  if (condition === 'unreadable goal') {
    vi.spyOn(GoalStore.prototype, 'getSync').mockImplementation(() => { throw new Error('cannot read goal'); });
  } else await new GoalStore(cwd).update(goalRecord().id, (goal) => ({ ...goal, executionStatus: condition }));
  expect(await runtime.inspect()).toMatchObject({ tasks: [] });
  expect(runner.failUnreadableGoalTask(task.name)).toBeUndefined();
  expect(runner.listTaskStateItems()[0]?.status).toBe('pending');
  expect(doubles.preflight).not.toHaveBeenCalled();
  expect(readManagerEvents(cwd)).toEqual([]);
});

it('only claims the selected task and saves the worker with the execution identity', async () => {
  const first = runner.addTask('first', { goal_id: goalRecord().id });
  const selected = runner.addTask('selected', { goal_id: goalRecord().id });
  runner.setPendingWaitingReason([selected.name], 'waiting');
  const execution = deferred<{ completion: { success: boolean; interrupted: boolean; workflowResult: 'completed' }; runSlug: string }>();
  doubles.execute.mockReturnValue(execution.promise);
  expect(await runtime.start(selected.name, 'builtin')).toEqual({ kind: 'started' });
  const saved = new TaskStore(cwd).read().tasks;
  expect(saved.find((task) => task.name === first.name)!.status).toBe('pending');
  expect(saved.find((task) => task.name === selected.name)).toMatchObject({
    status: 'running', worker_name: 'builtin', execution_id: expect.any(String), owner_pid: process.pid,
  });
  expect(saved.find((task) => task.name === selected.name)!.waiting_reason).toBeUndefined();
  expect(getProjectExecutionOwner(cwd)?.pid).toBe(process.pid);
  execution.resolve({ completion: { success: true, interrupted: false, workflowResult: 'completed' }, runSlug: 'saved-run' });
  await vi.waitFor(() => expect(finished).toHaveBeenCalledExactlyOnceWith(selected.name));
  expect(readManagerEvents(cwd)).toMatchObject([{ event: { kind: 'completion', taskName: selected.name, runSlug: 'saved-run' } }]);
  expect(getProjectExecutionOwner(cwd)).toBeUndefined();
});

it.each(['removed', 'paused', 'aborted'] as const)('rechecks %s work after provider preparation in the same runtime', async (change) => {
  const task = runner.addTask('selected', { goal_id: goalRecord().id });
  const preparation = deferred<void>();
  doubles.preflight.mockReturnValue(preparation.promise);
  const started = runtime.start(task.name, 'builtin');
  await vi.waitFor(() => expect(doubles.preflight).toHaveBeenCalledOnce());
  expect(getProjectExecutionOwner(cwd)?.pid).toBe(process.pid);
  if (change === 'removed') runner.deleteTask(task.name, 'pending');
  else await new GoalStore(cwd).update(goalRecord().id, (goal) => ({ ...goal, executionStatus: change }));
  preparation.resolve();
  expect(await started).toEqual({ kind: 'declined' });
  expect(doubles.execute).not.toHaveBeenCalled();
  expect(getProjectExecutionOwner(cwd)).toBeUndefined();
});

it('keeps preparation ownership until shutdown has settled the start request', async () => {
  const task = runner.addTask('selected', { goal_id: goalRecord().id });
  const preparation = deferred<void>();
  doubles.preflight.mockReturnValue(preparation.promise);
  const started = runtime.start(task.name, 'builtin');
  const closed = runtime.close();
  expect(getProjectExecutionOwner(cwd)?.state).toBe('stopping');
  preparation.resolve();
  expect(await started).toEqual({ kind: 'declined' });
  await closed;
  expect(getProjectExecutionOwner(cwd)).toBeUndefined();
  expect(runner.listTaskStateItems()[0]!.status).toBe('pending');
});

it('stops accepting work on an unsaved execution error without reporting a successful release', async () => {
  const task = runner.addTask('selected', { goal_id: goalRecord().id });
  const failure = new Error('cannot persist terminal task');
  doubles.execute.mockRejectedValue(failure);
  expect(await runtime.start(task.name, 'builtin')).toEqual({ kind: 'started' });
  await vi.waitFor(() => expect(fatal).toHaveBeenCalledExactlyOnceWith(failure));
  expect(finished).not.toHaveBeenCalled();
  await expect(runtime.start(task.name, 'builtin')).resolves.toEqual({ kind: 'declined' });
});

it('clears a pending waiting reason when the goal is aborted before execution', async () => {
  const task = runner.addTask('selected', { goal_id: goalRecord().id });
  await runtime.setWaitingReasons([{ taskName: task.name, reason: 'No executable worker is available' }]);
  expect(runner.listTaskStateItems()[0]!.waitingReason).toContain('No executable worker');
  runner.invalidatePendingGoalTasks(goalRecord().id);
  expect(runner.listTaskStateItems()[0]).toMatchObject({ status: 'failed', name: task.name });
  expect(runner.listTaskStateItems()[0]!.waitingReason).toBeUndefined();
});
