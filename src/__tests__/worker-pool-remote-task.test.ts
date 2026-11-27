import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RemoteTaskLifecycle } from '../infra/task/remoteTaskLifecycle.js';
import { TaskStore } from '../infra/task/store.js';
import { TaskRetryService } from '../infra/task/taskRetryService.js';
import { TaskLifecycleService } from '../infra/task/taskLifecycleService.js';
import { TasksFileSchema, type TasksFileData } from '../infra/task/schema.js';
import { executionIdentity } from '../core/worker-pool/remoteProtocol.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { sanitizeRemoteFailureReason } from '../core/worker-pool/remoteFailure.js';
import { TaskStoppedError } from '../infra/task/taskStop.js';
import { deferred } from './helpers/controlledDaemon.js';

const doubles = vi.hoisted(() => ({ git: vi.fn(), text: vi.fn(), sequence: vi.fn(), sha: vi.fn(), goal: vi.fn(), event: vi.fn(), updateGoal: vi.fn() }));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.git, resolveGoalBranchSha: doubles.sha, goalGitText: doubles.text }));
vi.mock('../infra/task/remoteExecutionStore.js', () => ({ RemoteExecutionStore: class {
  constructor(_cwd: string, private readonly id: string) {}
  inputManifest() { return Promise.resolve({ version: 1, runSlug: `remote-${this.id}`, directories: [], files: [] }); }
  acknowledgedSequence = doubles.sequence;
  async assertFinalSequence(sequence: number) {
    if (sequence !== await doubles.sequence()) throw new Error('Remote final log sequence has not been saved');
  }
} }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.goal; update = doubles.updateGoal; } }));
vi.mock('../infra/goals/execution-lock.js', () => ({ withGoalExecutionLock: (_cwd: string, action: () => unknown) => action() }));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: doubles.event }));
vi.mock('../infra/workflow/live-intervention-store.js', () => ({ LiveInterventionFileStore: class {
  read() { return { issuedTotal: 0, instructions: [] }; }
} }));
beforeEach(() => {
  vi.clearAllMocks();
  doubles.git.mockResolvedValue({ output: Buffer.from('https://example.test/repo.git\n'), code: 0, truncated: false });
  doubles.sha.mockResolvedValue('a'.repeat(40));
  doubles.sequence.mockResolvedValue(2);
  doubles.text.mockResolvedValue('b'.repeat(40));
  doubles.goal.mockReturnValue(goalRecord());
  doubles.updateGoal.mockImplementation(async (_id, update) => update(goalRecord()));
});
afterEach(() => { vi.restoreAllMocks(); });

function fixture(previousGeneration = 0) {
  let state: TasksFileData = TasksFileSchema.parse({ tasks: [{ name: 'T', content: 'work', goal_id: goalRecord().id,
    status: 'pending', started_at: null, completed_at: null, created_at: '2026-11-13T00:00:00Z',
    ...(previousGeneration === 0 ? {} : { assignment_generation: previousGeneration }) }] });
  const store = new TaskStore('/project');
  vi.spyOn(store, 'read').mockImplementation(() => structuredClone(state));
  vi.spyOn(store, 'update').mockImplementation((mutate) => {
    const result = mutate(structuredClone(state));
    if (result !== undefined) state = TasksFileSchema.parse(result);
    return structuredClone(state);
  });
  const lifecycle = new RemoteTaskLifecycle('/project', store, vi.fn());
  const claim = { kind: 'claim' as const, taskName: 'T', workerId: 'w1', registrationGeneration: randomUUID(), requestId: 'r1', leaseExpiresAt: 60_000 };
  return { lifecycle, claim, store, state: () => state };
}

it('persists one retry deadline and clears checkpoint ownership when restarting from the original SHA', async () => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  const assignment = executionIdentity(claim.assignment);
  await f.lifecycle.request({ kind: 'fail', assignment, reason: 'lost' }, 1);
  new TaskRetryService('/project', '/project/.takt/tasks.yaml', f.store).requeueTask('T', ['failed'], { startStep: 'verify', sourceRunSlug: 'old-run' });
  await f.lifecycle.request({ kind: 'retry-state', assignment, waitUntil: 61000 }, 1);
  await f.lifecycle.request({ kind: 'retry-state', assignment, waitUntil: 62000 }, 1);
  expect(f.state().tasks[0]!.remote_assignment?.retryWaitUntil).toBe(61000);
  await f.lifecycle.request({ kind: 'retry-state', assignment, restartReason: 'Worker w1 registration was removed' }, 1);
  expect(f.state().tasks[0]).toMatchObject({ status: 'pending', remote_assignment: {
    retryReservation: false, workLocation: null, originalSha: 'a'.repeat(40), restartReason: 'Worker w1 registration was removed' } });
  expect(f.state().tasks[0]!.source_run_slug).toBeUndefined();
  expect(f.state().tasks[0]!.start_step).toBeUndefined();
  expect(doubles.updateGoal).toHaveBeenCalledOnce();
});

it('requires the current cleanup ID before acknowledging removal of a failed workspace', async () => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  const assignment = executionIdentity(claim.assignment);
  await f.lifecycle.request({ kind: 'fail', assignment, reason: 'failed' }, 1);
  const cleanupId = randomUUID();
  f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task, deletion: { id: cleanupId, owner_pid: process.pid } })) }));
  expect(await f.lifecycle.request({ kind: 'cleanup', assignment, cleanupId: randomUUID() }, 1)).toEqual({ kind: 'updated', record: null });
  expect(f.state().tasks[0]!.remote_assignment?.retryReservation).toBe(true);
  await f.lifecycle.request({ kind: 'cleanup', assignment, cleanupId }, 1);
  expect(f.state().tasks[0]!.deletion?.remote_ack).toBe(true);
  expect(f.state().tasks[0]!.remote_assignment?.retryReservation).toBe(false);
});

it('keeps a queued remote retry out of local claims while preserving its reservation', async () => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  await f.lifecycle.request({ kind: 'fail', assignment: executionIdentity(claim.assignment), reason: 'failed' }, 1);
  new TaskRetryService('/project', '/project/.takt/tasks.yaml', f.store).requeueTask('T', ['failed']);
  const before = f.state();
  const local = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', f.store);
  expect(local.claimTask('T', 'builtin')).toEqual({ kind: 'declined' });
  expect(local.claimNextTasks(1)).toEqual([]);
  expect(f.state()).toEqual(before);
});

it('claims a remote task without a PID and persists the full assignment with running status', async () => {
  const f = fixture();
  const result = await f.lifecycle.request(f.claim, 1);
  expect(result.kind).toBe('claim');
  if (result.kind !== 'claim' || result.assignment === null) throw new Error('Expected remote claim');
  expect(f.state().tasks[0]).toMatchObject({ status: 'running', owner_pid: null, owner_start_time: null,
    execution_id: result.assignment.executionId, worker_name: 'w1', remote_assignment: result.assignment });
  expect(f.lifecycle.records()).toEqual([{ status: 'running', assignment: result.assignment }]);
  expect(result.assignment).toMatchObject({ originalSha: 'a'.repeat(40), origin: 'https://example.test/repo.git',
    assignmentGeneration: 1, leaseExpiresAt: 60_000, lastAcknowledgedLogSequence: 0, controlSequence: 0,
    workLocation: null, retryReservation: false });
});

it.each(['https://example.test/repo.git', 'https://fixture:credential@example.test/repo.git'])(
  'normalizes %s before exposing origin or persisting an assignment', async (origin) => {
    doubles.git.mockResolvedValue({ output: Buffer.from(origin), code: 0, truncated: false });
    const f = fixture();
    expect(await f.lifecycle.origin()).toBe('https://example.test/repo.git');
    const reply = await f.lifecycle.request(f.claim, 1);
    expect(reply).toMatchObject({ kind: 'claim', assignment: { origin: 'https://example.test/repo.git' } });
    expect(f.state().tasks[0]!.remote_assignment!.origin).toBe('https://example.test/repo.git');
    expect(JSON.stringify(reply)).not.toMatch(/fixture|credential/);
  });

it('rejects an unparseable HTTP origin without exposing its userinfo in the error', async () => {
  doubles.git.mockResolvedValue({ output: Buffer.from('https://fixture:credential@['), code: 0, truncated: false });
  const f = fixture();
  const result = await f.lifecycle.request(f.claim, 1).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).not.toMatch(/fixture|credential/);
  expect(f.state().tasks[0]!.status).toBe('pending');
});

it('rejects an old execution without changing the current assignment', async () => {
  const f = fixture(1);
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  const identity = executionIdentity(claim.assignment);
  const original = structuredClone(f.state());
  expect(identity.assignmentGeneration).toBe(2);
  for (const changed of [{ executionId: randomUUID() }, { assignmentGeneration: 1 }, { registrationGeneration: randomUUID() },
    { workerId: 'other' }, { projectId: '/other' }, { taskName: 'other' }]) {
    expect(await f.lifecycle.request({ kind: 'finish', assignment: { ...identity, ...changed }, success: true, now: 1 }, 1))
      .toEqual({ kind: 'updated', record: null });
    expect(f.state()).toEqual(original);
  }
  expect(doubles.event).not.toHaveBeenCalled();
});

it('does not complete a remote task from a success flag without received artifacts', async () => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  await f.lifecycle.request({ kind: 'finish', assignment: executionIdentity(claim.assignment), success: true, now: 1 }, 1)
    .catch((error: unknown) => { expect(error).toBeInstanceOf(Error); });
  expect(f.state().tasks[0]!.status).not.toBe('completed');
  expect(f.state().tasks[0]!.completion?.success).not.toBe(true);
  expect(doubles.event.mock.calls.some(([, event]) => event.result.success === true)).toBe(false);
});

it('receives a verified result branch before saving completion and notifying the manager', async () => {
  const f = fixture();
  const claimed = await f.lifecycle.request(f.claim, 1);
  if (claimed.kind !== 'claim' || claimed.assignment === null) throw new Error('Expected claim');
  const artifacts = { branch: claimed.assignment.branch, sha: 'b'.repeat(40), runSlug: `remote-${claimed.assignment.executionId}`, finalLogSequence: 2 };
  doubles.git.mockResolvedValue({ code: 1, output: Buffer.alloc(0), truncated: false });
  doubles.text.mockImplementation(async (_cwd: string, args: string[]) => {
    expect(f.state().tasks[0]!.status).toBe('running');
    return args[0] === 'rev-parse' ? artifacts.sha : '';
  });
  const request = { kind: 'finish' as const, assignment: executionIdentity(claimed.assignment), now: 1, success: true, artifacts };
  await f.lifecycle.request(request, 1);
  expect(f.state().tasks[0]).toMatchObject({ status: 'completed', remote_artifacts: artifacts,
    completion: { success: true, branch: artifacts.branch, sha: artifacts.sha } });
  expect(doubles.text.mock.calls.map(([, args]) => args[0])).toEqual(['fetch', 'rev-parse', 'update-ref']);
  expect(doubles.event).toHaveBeenCalledOnce();
  expect(doubles.event.mock.calls[0]![1]).toMatchObject({ runSlug: artifacts.runSlug, result: { sha: artifacts.sha } });
  await f.lifecycle.request(request, 1);
  expect(doubles.event).toHaveBeenCalledOnce();
});

it.each(['fetch', 'sha', 'sequence'] as const)('saves a reason without mergeable artifacts when remote receipt fails at %s', async (failure) => {
  const f = fixture(); const claimed = await f.lifecycle.request(f.claim, 1);
  if (claimed.kind !== 'claim' || claimed.assignment === null) throw new Error('Expected claim');
  if (failure === 'fetch') doubles.text.mockRejectedValue(new Error('Fetch failed'));
  if (failure === 'sha') doubles.text.mockResolvedValue('c'.repeat(40));
  if (failure === 'sequence') doubles.sequence.mockResolvedValue(1);
  await f.lifecycle.request({ kind: 'finish', assignment: executionIdentity(claimed.assignment), now: 1, success: true, prUrl: 'https://example.test/pr/1',
    artifacts: { branch: claimed.assignment.branch, sha: 'b'.repeat(40), runSlug: `remote-${claimed.assignment.executionId}`, finalLogSequence: 2 } }, 1);
  expect(f.state().tasks[0]).toMatchObject({ status: 'failed', completion: { success: false } });
  expect(f.state().tasks[0]!.failure?.error).toMatch(failure === 'fetch' ? /fetch/i : failure === 'sha' ? /SHA/ : /sequence/);
  expect(f.state().tasks[0]!.remote_artifacts).toBeUndefined();
  expect(f.state().tasks[0]!.completion?.sha).toBeUndefined();
});

it.each([false, true])('preserves received PR results and completion replay after reload with PR failure=%s', async (prFailed) => {
  const f = fixture();
  const claimed = await f.lifecycle.request(f.claim, 1);
  if (claimed.kind !== 'claim' || claimed.assignment === null) throw new Error('Expected claim');
  const artifacts = { branch: claimed.assignment.branch, sha: 'b'.repeat(40), runSlug: `remote-${claimed.assignment.executionId}`, finalLogSequence: 2 };
  doubles.git.mockResolvedValue({ code: 1, output: Buffer.alloc(0), truncated: false });
  doubles.text.mockImplementation(async (_cwd: string, args: string[]) => args[0] === 'rev-parse' ? artifacts.sha : '');
  const request = { kind: 'finish' as const, assignment: executionIdentity(claimed.assignment), now: 1, success: true,
    workflowResult: 'completed' as const, artifacts, prUrl: prFailed ? undefined : 'https://example.test/pr/17',
    prFailed, prError: prFailed ? 'Failed to update pull request comment.' : undefined };
  await f.lifecycle.request(request, 1);
  expect(f.state().tasks[0]).toMatchObject({ status: prFailed ? 'pr_failed' : 'completed', remote_artifacts: artifacts,
    completion: { success: !prFailed, workflowResult: 'completed', sha: artifacts.sha } });
  expect(doubles.event.mock.calls[0]![1]).toMatchObject({ result: { success: !prFailed, sha: artifacts.sha } });
  if (prFailed) expect(f.state().tasks[0]!.failure?.error).toBe('PR creation failed: Failed to update pull request comment.');
  else expect(f.state().tasks[0]!.pr_url).toBe('https://example.test/pr/17');
  const restored = new RemoteTaskLifecycle('/project', f.store, () => {});
  expect(restored.records()[0]?.status).toBe(prFailed ? 'pr_failed' : 'completed');
  const reply = await restored.request(request, 1);
  expect(reply).toMatchObject({ kind: 'updated', record: { status: prFailed ? 'pr_failed' : 'completed' } });
  expect(doubles.event).toHaveBeenCalledOnce();
});

it('refuses a result when the assignment becomes invalid during fetch', async () => {
  const f = fixture(); const claimed = await f.lifecycle.request(f.claim, 1);
  if (claimed.kind !== 'claim' || claimed.assignment === null) throw new Error('Expected claim');
  doubles.git.mockResolvedValue({ code: 1, output: Buffer.alloc(0), truncated: false });
  doubles.text.mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === 'fetch') f.store.update((current) => ({ tasks: current.tasks.map((task) => ({ ...task,
      status: 'failed', completed_at: new Date().toISOString(), failure: { error: 'Lease expired' } })) }));
    return args[0] === 'rev-parse' ? 'b'.repeat(40) : '';
  });
  expect(await f.lifecycle.request({ kind: 'finish', assignment: executionIdentity(claimed.assignment), now: 1, success: true,
    artifacts: { branch: claimed.assignment.branch, sha: 'b'.repeat(40), runSlug: `remote-${claimed.assignment.executionId}`, finalLogSequence: 2 } }, 1))
    .toEqual({ kind: 'updated', record: null });
  expect(f.state().tasks[0]!.failure?.error).toBe('Lease expired');
  expect(f.state().tasks[0]!.remote_artifacts).toBeUndefined();
  expect(doubles.event).not.toHaveBeenCalled();
});

it('publishes the fixed base SHA before making a remote assignment running', async () => {
  const f = fixture();
  const pushed: string[][] = [];
  doubles.git.mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === 'push') {
      expect(f.state().tasks[0]!.status).toBe('pending');
      pushed.push(args);
    }
    return { output: Buffer.from(args[0] === 'config' ? 'https://example.test/repo.git\n' : ''), code: 0, truncated: false };
  });
  const reply = await f.lifecycle.request(f.claim, 1);
  expect(reply).toMatchObject({ kind: 'claim', assignment: { originalSha: 'a'.repeat(40) } });
  expect(pushed.some((args) => args.includes('origin') && args.some((arg) => arg === goalRecord().branch
    || arg.endsWith(`:refs/heads/${goalRecord().branch}`) || arg.endsWith(`:${goalRecord().branch}`)))).toBe(true);
});

it('keeps a task pending when publishing its base branch fails', async () => {
  const f = fixture();
  const before = structuredClone(f.state());
  doubles.git.mockImplementation(async (_cwd: string, args: string[]) => {
    if (args[0] === 'push') throw new Error('Origin rejected the base branch');
    return { output: Buffer.from('https://example.test/repo.git\n'), code: 0, truncated: false };
  });
  await expect(f.lifecycle.request(f.claim, 1)).rejects.toThrow();
  expect(f.state()).toEqual(before);
  expect(doubles.event).not.toHaveBeenCalled();
});

it('saves a remote stop request without a local PID and keeps the same execution running', async () => {
  const f = fixture();
  const claim = await f.lifecycle.request({ ...f.claim, leaseExpiresAt: Date.now() + 60_000 }, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  const service = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', f.store);
  const requested = service.requestTaskStop(goalRecord().id, 'T', claim.assignment.executionId);
  expect(requested).toMatchObject({ execution_id: claim.assignment.executionId });
  expect(f.state().tasks[0]).toMatchObject({ status: 'running', owner_pid: null,
    remote_assignment: claim.assignment, stop_request: requested });
  expect(service.requestTaskStop(goalRecord().id, 'T', claim.assignment.executionId)).toEqual(requested);
  expect(() => service.requestTaskStop(goalRecord().id, 'T', randomUUID())).toThrow();
  expect(f.state().tasks[0]!.stop_request).toEqual(requested);
  expect(doubles.event).not.toHaveBeenCalled();
});

it.each(['before finish', 'during fetch', 'after finish'] as const)(
  'honors a stop accepted %s while preserving completion without a stop', async (timing) => {
    for (const stop of [false, true]) {
      doubles.event.mockClear();
      doubles.git.mockResolvedValue({ output: Buffer.from('https://example.test/repo.git\n'), code: 0, truncated: false });
      const f = fixture();
      const claimed = await f.lifecycle.request({ ...f.claim, leaseExpiresAt: Date.now() + 60_000 }, 1);
      if (claimed.kind !== 'claim' || claimed.assignment === null) throw new Error('Expected claim');
      const assignment = executionIdentity(claimed.assignment);
      const service = new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', f.store);
      const artifacts = { branch: claimed.assignment.branch, sha: 'b'.repeat(40),
        runSlug: `remote-${assignment.executionId}`, finalLogSequence: 2 };
      const fetchStarted = deferred<void>();
      const releaseFetch = deferred<void>();
      doubles.git.mockResolvedValue({ code: 1, output: Buffer.alloc(0), truncated: false });
      doubles.text.mockImplementation(async (_cwd: string, args: string[]) => {
        if (args[0] === 'fetch') { fetchStarted.resolve(); await releaseFetch.promise; }
        return args[0] === 'rev-parse' ? artifacts.sha : '';
      });
      const requestStop = () => {
        service.requestTaskStop(goalRecord().id, 'T', assignment.executionId);
        expect(f.state().tasks[0]!.status).toBe('running');
        expect(doubles.event).not.toHaveBeenCalled();
      };
      if (stop && timing === 'before finish') requestStop();
      const request = { kind: 'finish' as const, assignment, now: Date.now(), success: true, artifacts };
      const finish = f.lifecycle.request(request, 1);
      try {
        await fetchStarted.promise;
        if (stop && timing === 'during fetch') requestStop();
      } finally { releaseFetch.resolve(); }
      await finish;
      if (stop && timing === 'after finish') {
        expect(() => service.requestTaskStop(goalRecord().id, 'T', assignment.executionId)).toThrow();
      }
      const stopped = stop && timing !== 'after finish';
      const task = f.state().tasks[0]!;
      expect(task).toMatchObject({ status: stopped ? 'failed' : 'completed', remote_artifacts: artifacts,
        completion: { success: !stopped, interrupted: stopped, workflowResult: stopped ? 'aborted' : 'completed',
          branch: artifacts.branch, sha: artifacts.sha } });
      if (stopped) {
        const reason = new TaskStoppedError('T', assignment.executionId).message;
        expect(task.failure?.error).toContain(reason);
        expect(task.completion?.failureReason).toBe(task.failure?.error);
        expect(task.failure?.retryable).not.toBe(true);
      }
      expect(doubles.event).toHaveBeenCalledExactlyOnceWith('/project', expect.objectContaining({ result: task.completion }));
      const saved = structuredClone(f.state());
      await f.lifecycle.request(request, 1);
      expect(f.state()).toEqual(saved);
      expect(doubles.event).toHaveBeenCalledOnce();
    }
  });

it.each(['PR', 'workflow', 'forced failure'] as const)(
  'resolves stop requests against %s and preserves failure without a stop', async (failure) => {
    for (const stop of [false, true]) {
      doubles.event.mockClear();
      doubles.git.mockResolvedValue({ output: Buffer.from('https://example.test/repo.git\n'), code: 0, truncated: false });
      const f = fixture();
      const claimed = await f.lifecycle.request({ ...f.claim, leaseExpiresAt: Date.now() + 60_000 }, 1);
      if (claimed.kind !== 'claim' || claimed.assignment === null) throw new Error('Expected claim');
      const assignment = executionIdentity(claimed.assignment);
      if (stop) new TaskLifecycleService('/project', '/project/.takt/tasks.yaml', f.store)
        .requestTaskStop(goalRecord().id, 'T', assignment.executionId);
      const reason = `${failure} failed`;
      const artifacts = { branch: claimed.assignment.branch, sha: 'b'.repeat(40),
        runSlug: `remote-${assignment.executionId}`, finalLogSequence: 2 };
      doubles.git.mockResolvedValue({ code: 1, output: Buffer.alloc(0), truncated: false });
      doubles.text.mockImplementation(async (_cwd: string, args: string[]) => args[0] === 'rev-parse' ? artifacts.sha : '');
      await f.lifecycle.request(failure === 'forced failure'
        ? { kind: 'fail', assignment, reason }
        : { kind: 'finish', assignment, now: Date.now(), success: failure === 'PR',
          workflowResult: failure === 'PR' ? 'completed' : 'error', reason, retryable: true,
          ...(failure === 'PR' ? { prFailed: true, prError: reason, artifacts } : {}) }, 1);
      const stopped = stop && failure !== 'forced failure';
      const task = f.state().tasks[0]!;
      expect(task.status).toBe(!stopped && failure === 'PR' ? 'pr_failed' : 'failed');
      expect(task.completion).toMatchObject({ success: false,
        interrupted: stopped || failure === 'forced failure',
        workflowResult: stopped ? 'aborted' : failure === 'PR' ? 'completed' : 'error' });
      expect(task.failure?.error).toContain(stopped ? new TaskStoppedError('T', assignment.executionId).message : reason);
      if (stopped) {
        expect(task.completion?.failureReason).toBe(task.failure?.error);
        expect(task.failure?.retryable).not.toBe(true);
      }
      expect(doubles.event).toHaveBeenCalledExactlyOnceWith('/project', expect.objectContaining({ result: task.completion }));
    }
  });

it.each(['fail', 'finish'] as const)('reserves the original worker after a remote %s and restores the reservation', async (kind) => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  const identity = executionIdentity(claim.assignment);
  await f.lifecycle.request(kind === 'fail'
    ? { kind, assignment: identity, reason: 'Connection lost' }
    : { kind, assignment: identity, success: false, reason: 'Provider failed', now: 1 }, 1);
  expect(f.state().tasks[0]).toMatchObject({ status: 'failed', remote_assignment: {
    executionId: identity.executionId, workerName: 'w1', retryReservation: true,
  } });
  const restored = new RemoteTaskLifecycle('/project', f.store, vi.fn());
  expect(restored.records()).toEqual([expect.objectContaining({ status: 'failed', assignment: expect.objectContaining({
    executionId: identity.executionId, retryReservation: true,
  }) })]);
});

it.each([undefined, 'verify'])('queues a remote retry with startStep=%s while retaining its worker and source run', async (startStep) => {
  const f = fixture(6);
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  await f.lifecycle.request({ kind: 'fail', assignment: executionIdentity(claim.assignment), reason: 'Provider failed' }, 1);
  const failed = structuredClone(f.state().tasks[0]!);
  const service = new TaskRetryService('/project', '/project/.takt/tasks.yaml', f.store);
  expect(service.requeueTask('T', ['failed'], { startStep, sourceRunSlug: failed.run_slug,
    retryNote: 'Use the corrected instructions' })).toBe('/project/.takt/tasks.yaml');
  expect(f.state().tasks[0]).toMatchObject({ status: 'pending', assignment_generation: 7,
    source_run_slug: failed.run_slug, start_step: startStep, retry_note: 'Use the corrected instructions',
    remote_assignment: { executionId: claim.assignment.executionId, originalSha: claim.assignment.originalSha,
      workerId: 'w1', registrationGeneration: claim.assignment.registrationGeneration, retryReservation: true } });
  expect(f.state().tasks[0]!.owner_pid).toBeNull();
  expect(f.lifecycle.records()).toEqual([expect.objectContaining({ status: 'pending',
    assignment: expect.objectContaining({ retryReservation: true, workerName: 'w1' }) })]);
});

it('reports provider authentication failure with the worker name to the manager', async () => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  await f.lifecycle.request({ kind: 'finish', assignment: executionIdentity(claim.assignment), success: false,
    reason: 'OpenAI authentication failed: missing API key', now: 1 }, 1);
  const failure = f.state().tasks[0]!.failure!.error;
  expect(failure).toContain('OpenAI authentication failed');
  expect(failure).toContain('w1');
  expect(doubles.event).toHaveBeenCalledWith('/project', expect.objectContaining({
    result: expect.objectContaining({ success: false, failureReason: failure }),
  }));
});

it.each(['a', 'ordinary-distributed-key'])('keeps one worker prefix in manager failures after redacting %s', async (secret) => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  const reason = sanitizeRemoteFailureReason('w1', `OpenAI authentication failed: supplied value ${secret}9`, [secret]);
  await f.lifecycle.request({ kind: 'finish', assignment: executionIdentity(claim.assignment), success: false, reason, now: 1 }, 1);
  const failure = f.state().tasks[0]!.failure!.error;
  expect(failure).toBe(reason);
  expect(failure.match(/Worker w1:/g)).toHaveLength(1);
  expect(failure).toContain('OpenAI');
  expect(failure).toContain('[REDACTED]9');
  expect(failure.includes(secret)).toBe(false);
  expect(doubles.event).toHaveBeenCalledWith('/project', expect.objectContaining({
    result: expect.objectContaining({ success: false, failureReason: reason }),
  }));
});

it('rejects completion from the failed attempt after the same task starts a new execution', async () => {
  const f = fixture(6);
  const first = await f.lifecycle.request(f.claim, 1);
  if (first.kind !== 'claim' || first.assignment === null) throw new Error('Expected claim');
  await f.lifecycle.request({ kind: 'fail', assignment: executionIdentity(first.assignment), reason: 'Provider failed' }, 1);
  new TaskRetryService('/project', '/project/.takt/tasks.yaml', f.store).requeueFailedTask('T');
  const next = await f.lifecycle.request({ ...f.claim, requestId: 'second-pull' }, 1);
  if (next.kind !== 'claim' || next.assignment === null) throw new Error('Expected second claim');
  expect(next.assignment.assignmentGeneration).toBe(8);
  expect(next.assignment.executionId).not.toBe(first.assignment.executionId);
  const running = structuredClone(f.state());
  doubles.event.mockClear();
  doubles.text.mockClear();
  expect(await f.lifecycle.request({ kind: 'finish', assignment: executionIdentity(first.assignment), success: true, now: 1,
    artifacts: { branch: first.assignment.branch, sha: 'b'.repeat(40),
      runSlug: `remote-${first.assignment.executionId}`, finalLogSequence: 2 } }, 1)).toEqual({ kind: 'updated', record: null });
  expect(f.state()).toEqual(running);
  expect(doubles.text).not.toHaveBeenCalled();
  expect(doubles.event).not.toHaveBeenCalled();
});

it('preserves the failure after expiry and refuses a delayed completion', async () => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  const identity = executionIdentity(claim.assignment);
  expect(await f.lifecycle.request({ kind: 'renew', assignment: identity, now: 60_000, leaseExpiresAt: 120_000 }, 1))
    .toEqual({ kind: 'updated', record: null });
  await f.lifecycle.request({ kind: 'fail', assignment: identity, reason: 'Connection to worker w1 was lost' }, 1);
  expect(await f.lifecycle.request({ kind: 'finish', assignment: identity, success: true, now: 60_001 }, 1))
    .toEqual({ kind: 'updated', record: null });
  expect(f.state().tasks[0]).toMatchObject({ status: 'failed', failure: { error: 'Connection to worker w1 was lost' },
    completion: { success: false, failureReason: 'Connection to worker w1 was lost' } });
});

it('declines work when origin is absent or the goal was paused before the claim', async () => {
  const f = fixture();
  doubles.git.mockResolvedValueOnce({ output: Buffer.alloc(0), code: 1, truncated: false });
  expect(await f.lifecycle.request(f.claim, 1)).toEqual({ kind: 'claim', assignment: null });
  doubles.goal.mockReturnValue({ ...goalRecord(), executionStatus: 'paused' });
  expect(await f.lifecycle.request(f.claim, 1)).toEqual({ kind: 'claim', assignment: null });
  expect(f.state().tasks[0]!.status).toBe('pending');
});
