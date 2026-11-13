import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RemoteTaskLifecycle } from '../infra/task/remoteTaskLifecycle.js';
import { TaskStore } from '../infra/task/store.js';
import { TaskRetryService } from '../infra/task/taskRetryService.js';
import { TaskLifecycleService } from '../infra/task/taskLifecycleService.js';
import { TasksFileSchema, type TasksFileData } from '../infra/task/schema.js';
import { executionIdentity } from '../core/worker-pool/remoteProtocol.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ git: vi.fn(), text: vi.fn(), sequence: vi.fn(), sha: vi.fn(), goal: vi.fn(), event: vi.fn() }));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.git, resolveGoalBranchSha: doubles.sha, goalGitText: doubles.text }));
vi.mock('../infra/task/remoteExecutionStore.js', () => ({ RemoteExecutionStore: class {
  constructor(_cwd: string, private readonly id: string) {}
  inputManifest() { return Promise.resolve({ version: 1, runSlug: `remote-${this.id}`, directories: [], files: [] }); }
  acknowledgedSequence = doubles.sequence;
  async assertFinalSequence(sequence: number) {
    if (sequence !== await doubles.sequence()) throw new Error('Remote final log sequence has not been saved');
  }
} }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.goal; } }));
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

it.each(['requeue', 'retry'] as const)('refuses remote %s before changing the failed task or its assignment', async (operation) => {
  const f = fixture();
  const claim = await f.lifecycle.request(f.claim, 1);
  if (claim.kind !== 'claim' || claim.assignment === null) throw new Error('Expected claim');
  await f.lifecycle.request({ kind: 'fail', assignment: executionIdentity(claim.assignment), reason: 'Connection lost' }, 1);
  const before = structuredClone(f.state());
  const service = new TaskRetryService('/project', '/project/.takt/tasks.yaml', f.store);
  const retry = () => operation === 'requeue' ? service.requeueFailedTask('T')
    : service.startReExecution('T', ['failed'], 'retry');
  expect(retry).toThrow(/remote/i);
  expect(f.state()).toEqual(before);
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
