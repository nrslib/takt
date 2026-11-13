import { beforeEach, expect, it, vi } from 'vitest';
import { BuiltinProjectRuntime } from '../features/workerPool/builtinProjectRuntime.js';
import { toTaskInfo, toTaskState } from '../infra/task/mapper.js';
import { GoalSchema } from '../infra/goals/schema.js';
import { deferred } from './helpers/controlledDaemon.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { PrivateFileLockAcquisitionError } from '../shared/utils/private-file-lock.js';
import { ProjectExecutionAlreadyRunningError } from '../infra/task/project-execution-lock.js';

const doubles = vi.hoisted(() => ({
  records: vi.fn(), claim: vi.fn(), recheck: vi.fn(), waiting: vi.fn(), goal: vi.fn(), config: vi.fn(),
  owner: vi.fn(), acquire: vi.fn(), release: vi.fn(), state: vi.fn(), preflight: vi.fn(), execute: vi.fn(), event: vi.fn(),
  terminate: vi.fn(), cleanup: vi.fn(),
  remoteOrigin: vi.fn(), remoteRecords: vi.fn(), remoteRequest: vi.fn(),
}));
vi.mock('../infra/task/remoteTaskLifecycle.js', () => ({ RemoteTaskLifecycle: class {
  origin = doubles.remoteOrigin; records = doubles.remoteRecords; request = doubles.remoteRequest;
} }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class {
  claimTask = doubles.claim;
  failUnreadableGoalTask = doubles.recheck;
  setPendingWaitingReason = doubles.waiting;
  getTasksFilePath() { return '/project/.takt/tasks.yaml'; }
} }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { read() { return { tasks: doubles.records() }; } } }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.goal; } }));
vi.mock('../infra/config/index.js', () => ({ invalidateGlobalConfigCache: vi.fn(), resolveWorkflowConfigValues: () => ({ concurrency: 3, ignoreExceed: false }) }));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/task/project-execution-lock.js', () => ({ acquireProjectExecutionLock: doubles.acquire,
  getProjectExecutionOwner: doubles.owner, ProjectExecutionAlreadyRunningError: class extends Error {},
}));
vi.mock('../features/tasks/execute/claimTasks.js', () => ({ CLAIM_RETRY_INTERVAL_MS: 5000, failInterruptedTasksWithGoalEvents: vi.fn() }));
vi.mock('../features/tasks/execute/providerPreflight.js', () => ({ checkQueuedTaskProviders: doubles.preflight }));
vi.mock('../features/tasks/execute/runTaskExecution.js', () => ({ executeRunTaskAndCompleteWithDetails: doubles.execute }));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: doubles.event }));
vi.mock('../shared/utils/spawn.js', async (original) => ({
  ...await original<typeof import('../shared/utils/spawn.js')>(), terminateManagedProcesses: doubles.terminate,
}));
vi.mock('../infra/opencode/server-pool.js', async (original) => ({
  ...await original<typeof import('../infra/opencode/server-pool.js')>(), prepareSharedServerPoolForForcedShutdown: doubles.cleanup,
}));

beforeEach(() => {
  vi.resetAllMocks();
  doubles.preflight.mockResolvedValue(undefined);
  doubles.terminate.mockResolvedValue(undefined);
  doubles.cleanup.mockResolvedValue(undefined);
  doubles.config.mockReturnValue({ autoRun: true });
  doubles.goal.mockReturnValue(GoalSchema.parse(goalRecord()));
  doubles.records.mockReturnValue([{ name: 'a', status: 'pending', content: 'work', goal_id: goalRecord().id,
    created_at: new Date().toISOString(), started_at: null, completed_at: null, worktree: false }]);
  doubles.acquire.mockReturnValue({ release: doubles.release, updateState: doubles.state });
  doubles.remoteOrigin.mockResolvedValue('https://example.test/repo.git');
  doubles.remoteRecords.mockReturnValue([]);
});

it('reports eligible tasks without claiming them and preserves project concurrency', async () => {
  const runtime = new BuiltinProjectRuntime('/project', vi.fn(), vi.fn());
  try {
    expect(await runtime.inspect()).toEqual({ concurrency: 3, available: true,
      tasks: [{ taskName: 'a', mergeTask: false }] });
    expect(doubles.claim).not.toHaveBeenCalled();
    expect(doubles.waiting).not.toHaveBeenCalled();
    await runtime.setWaitingReasons([{ taskName: 'a', reason: 'waiting' }]);
    expect(doubles.waiting).toHaveBeenCalledExactlyOnceWith(['a'], 'waiting');
    doubles.owner.mockReturnValue({ pid: process.pid + 1 });
    expect(await runtime.inspect()).toMatchObject({ available: false });
    doubles.config.mockReturnValue({ autoRun: false });
    expect(await runtime.inspect()).toEqual({ concurrency: 3, available: false, tasks: [] });
  } finally { await runtime.close(); }
});

it('uses the project lock for a remote claim without preparing a provider or executing a local workflow', async () => {
  const runtime = new BuiltinProjectRuntime('/project', vi.fn(), vi.fn(), true);
  const request = { kind: 'claim' as const, taskName: 'a', workerId: 'w1', registrationGeneration: 'generation',
    requestId: 'r1', leaseExpiresAt: 60_000 };
  doubles.remoteRequest.mockResolvedValue({ kind: 'claim', assignment: null });
  try {
    expect(await runtime.remote(request)).toEqual({ kind: 'claim', assignment: null });
    expect(doubles.acquire).toHaveBeenCalledExactlyOnceWith('/project', 'run');
    expect(doubles.remoteRequest).toHaveBeenCalledExactlyOnceWith(request, 3);
    expect(doubles.preflight).not.toHaveBeenCalled();
    expect(doubles.execute).not.toHaveBeenCalled();
    expect(doubles.release).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it.each(['renew', 'finish'] as const)('refuses remote %s when another manual owner holds the project lock', async (kind) => {
  const runtime = new BuiltinProjectRuntime('/project', vi.fn(), vi.fn(), true);
  const assignment = { projectId: '/project', taskName: 'a', workerId: 'w1', registrationGeneration: 'generation',
    executionId: 'execution', assignmentGeneration: 1 };
  const owner = { ownerId: 'manual', pid: process.pid + 1, processIdentity: { startTime: 'start' }, kind: 'watch' as const, state: 'running' as const };
  doubles.acquire.mockImplementation(() => { throw new ProjectExecutionAlreadyRunningError(owner); });
  try {
    expect(await runtime.remote({ kind, assignment, now: 1, leaseExpiresAt: 60_001, success: true }))
      .toEqual({ kind: 'updated', record: null });
    expect(doubles.remoteRequest).not.toHaveBeenCalled();
    doubles.remoteRequest.mockResolvedValue({ kind: 'updated', record: null });
    expect(await runtime.remote({ kind: 'fail', assignment, reason: 'Connection lost' })).toEqual({ kind: 'updated', record: null });
    expect(doubles.remoteRequest).toHaveBeenCalledOnce();
  } finally { await runtime.close(); }
});

it('rechecks unreadable remote input after the claim and publishes the saved terminal result', async () => {
  const record = doubles.records()[0];
  const saved = toTaskState('/project/.takt/tasks.yaml', { ...record, status: 'failed', run_slug: 'setup-remote',
    completion: { success: false, interrupted: false, workflowResult: 'error' } });
  doubles.remoteRequest.mockResolvedValue({ kind: 'unreadable', taskName: 'a' });
  doubles.recheck.mockReturnValue(saved);
  const runtime = new BuiltinProjectRuntime('/project', vi.fn(), vi.fn(), true);
  try {
    const claim = { kind: 'claim' as const, taskName: 'a', workerId: 'w1', registrationGeneration: 'generation', requestId: 'r1', leaseExpiresAt: 60_000 };
    expect(await runtime.remote(claim)).toEqual({ kind: 'claim', assignment: null });
    expect(doubles.recheck).toHaveBeenCalledExactlyOnceWith('a');
    expect(doubles.event).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'completion', goalId: saved.goalId,
      taskName: saved.name, runSlug: saved.runSlug, result: saved.completion });
    const failure = new Error('Cannot notify manager');
    doubles.event.mockImplementation(() => { throw failure; });
    await expect(runtime.remote(claim)).rejects.toBe(failure);
    doubles.recheck.mockClear(); doubles.remoteRequest.mockRejectedValueOnce(new Error('Git or storage failed'));
    await expect(runtime.remote(claim)).rejects.toThrow('Git or storage failed');
    expect(doubles.recheck).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('passes only a confirmed assignment to execution and saves completion before releasing it', async () => {
  const finished = vi.fn();
  const runtime = new BuiltinProjectRuntime('/project', finished, vi.fn());
  const claimed = toTaskInfo('/project', '/project/.takt/tasks.yaml', {
    ...doubles.records()[0], status: 'running', execution_id: 'execution-a',
  });
  doubles.claim.mockReturnValue({ kind: 'claimed', task: claimed });
  const result = deferred<{ runSlug: string; completion: { success: boolean; interrupted: boolean } }>();
  doubles.execute.mockReturnValue(result.promise);
  expect(await runtime.start('a', 'builtin')).toEqual({ kind: 'started' });
  expect(doubles.claim).toHaveBeenCalledExactlyOnceWith('a', 'builtin');
  expect(doubles.execute).toHaveBeenCalledWith(claimed, expect.anything(), '/project', undefined,
    { abortSignal: expect.any(AbortSignal), outputMode: 'silent' }, undefined);
  expect(doubles.release).not.toHaveBeenCalled();
  result.resolve({ runSlug: 'run-a', completion: { success: true, interrupted: false } });
  await vi.waitFor(() => expect(finished).toHaveBeenCalledExactlyOnceWith('a'));
  expect(doubles.event.mock.invocationCallOrder[0]).toBeLessThan(finished.mock.invocationCallOrder[0]!);
  expect(doubles.release).toHaveBeenCalledOnce();
  await runtime.close();
  expect(doubles.terminate).toHaveBeenCalledOnce();
  expect(doubles.cleanup).toHaveBeenCalledOnce();
});

it.each(['recheck', 'claim'] as const)('propagates %s completion notification failures outside acquisition retry', async (operation) => {
  const record = doubles.records()[0];
  const saved = toTaskState('/project/.takt/tasks.yaml', { ...record, status: 'failed', run_slug: 'setup-b',
    completion: { success: false, interrupted: false, workflowResult: 'error' } });
  if (operation === 'recheck') {
    doubles.records.mockReturnValue([{ ...record, content: undefined }]);
    doubles.recheck.mockReturnValue(saved);
  } else doubles.claim.mockReturnValue({ kind: 'failed', task: saved });
  const failure = new PrivateFileLockAcquisitionError('notification failed', 'ENOSPC', undefined, { cause: new Error('disk full') });
  doubles.event.mockImplementation(() => { throw failure; });
  const finished = vi.fn();
  const runtime = new BuiltinProjectRuntime('/project', finished, vi.fn());
  try {
    await expect(runtime.start('a', 'builtin')).rejects.toBe(failure);
    expect(doubles.event).toHaveBeenCalledExactlyOnceWith('/project', {
      kind: 'completion', goalId: saved.goalId, taskName: saved.name, runSlug: saved.runSlug, result: saved.completion,
    });
    expect(doubles.execute).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});

it('does not execute an assignment removed before starting and releases project ownership', async () => {
  const finished = vi.fn();
  const runtime = new BuiltinProjectRuntime('/project', finished, vi.fn());
  doubles.records.mockReturnValue([]);
  expect(await runtime.start('a', 'builtin')).toEqual({ kind: 'declined' });
  expect(doubles.execute).not.toHaveBeenCalled();
  expect(doubles.release).toHaveBeenCalledOnce();
  expect(finished).not.toHaveBeenCalled();
  await runtime.close();
});

it('cleans managed resources even if saving the stopping state fails', async () => {
  const result = deferred<{ runSlug: string; completion: { success: boolean; interrupted: boolean } }>();
  doubles.claim.mockReturnValue({ kind: 'claimed', task: toTaskInfo('/project', '/project/.takt/tasks.yaml', {
    ...doubles.records()[0], status: 'running', execution_id: 'execution-a',
  }) });
  doubles.execute.mockReturnValue(result.promise);
  const runtime = new BuiltinProjectRuntime('/project', vi.fn(), vi.fn());
  await runtime.start('a', 'builtin');
  doubles.state.mockImplementation(() => { throw new Error('disk full'); });
  const closed = expect(runtime.close()).rejects.toThrow('shutdown failed');
  expect(doubles.terminate).toHaveBeenCalledOnce();
  expect(doubles.cleanup).toHaveBeenCalledOnce();
  result.resolve({ runSlug: 'run-a', completion: { success: false, interrupted: true } });
  await closed;
  expect(doubles.release).toHaveBeenCalledOnce();
});

it('retains project ownership until task settlement and provider cleanup have both finished', async () => {
  const result = deferred<{ runSlug: string; completion: { success: boolean; interrupted: boolean } }>();
  const cleaned = deferred<void>();
  doubles.claim.mockReturnValue({ kind: 'claimed', task: toTaskInfo('/project', '/project/.takt/tasks.yaml', {
    ...doubles.records()[0], status: 'running', execution_id: 'execution-a',
  }) });
  doubles.execute.mockReturnValue(result.promise);
  doubles.cleanup.mockReturnValue(cleaned.promise);
  const finished = vi.fn();
  const runtime = new BuiltinProjectRuntime('/project', finished, vi.fn());
  await runtime.start('a', 'builtin');
  const closed = runtime.close();
  result.resolve({ runSlug: 'run-a', completion: { success: false, interrupted: true } });
  await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
  expect(doubles.release).not.toHaveBeenCalled();
  cleaned.resolve();
  await closed;
  expect(doubles.release).toHaveBeenCalledOnce();
});

it.each(['execution', 'completion notification'] as const)('retains project ownership after an unsaved %s failure until cleanup finishes', async (stage) => {
  const result = deferred<{ runSlug: string; completion: { success: boolean; interrupted: boolean } }>();
  const cleaned = deferred<void>();
  doubles.claim.mockReturnValue({ kind: 'claimed', task: toTaskInfo('/project', '/project/.takt/tasks.yaml', {
    ...doubles.records()[0], status: 'running', execution_id: 'execution-a',
  }) });
  doubles.execute.mockReturnValue(result.promise);
  doubles.cleanup.mockReturnValue(cleaned.promise);
  const fatal = vi.fn();
  const finished = vi.fn();
  const runtime = new BuiltinProjectRuntime('/project', finished, fatal);
  const failure = stage === 'execution' ? new Error('cannot save terminal result')
    : new PrivateFileLockAcquisitionError('cannot notify completion', 'ENOSPC', undefined, { cause: new Error('disk full') });
  if (stage === 'completion notification') doubles.event.mockImplementation(() => { throw failure; });
  await runtime.start('a', 'builtin');
  if (stage === 'execution') result.reject(failure);
  else result.resolve({ runSlug: 'run-a', completion: { success: true, interrupted: false } });
  await vi.waitFor(() => expect(fatal).toHaveBeenCalledExactlyOnceWith(failure));
  const closed = runtime.close();
  try {
    expect(finished).not.toHaveBeenCalled();
    expect(doubles.release).not.toHaveBeenCalled();
  } finally {
    cleaned.resolve();
    await closed;
  }
  expect(doubles.release).toHaveBeenCalledOnce();
});
