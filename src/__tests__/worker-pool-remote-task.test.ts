import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RemoteTaskLifecycle } from '../infra/task/remoteTaskLifecycle.js';
import { TaskStore } from '../infra/task/store.js';
import { TasksFileSchema, type TasksFileData } from '../infra/task/schema.js';
import { executionIdentity } from '../core/worker-pool/remoteProtocol.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ git: vi.fn(), sha: vi.fn(), goal: vi.fn(), event: vi.fn() }));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.git, resolveGoalBranchSha: doubles.sha }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.goal; } }));
vi.mock('../infra/goals/execution-lock.js', () => ({ withGoalExecutionLock: (_cwd: string, action: () => unknown) => action() }));
vi.mock('../infra/goals/events.js', () => ({ saveManagerEvent: doubles.event }));
beforeEach(() => {
  vi.clearAllMocks();
  doubles.git.mockResolvedValue({ output: Buffer.from('https://example.test/repo.git\n'), code: 0, truncated: false });
  doubles.sha.mockResolvedValue('a'.repeat(40));
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
  const lifecycle = new RemoteTaskLifecycle('/project', store);
  const claim = { kind: 'claim' as const, taskName: 'T', workerId: 'w1', registrationGeneration: randomUUID(), requestId: 'r1', leaseExpiresAt: 60_000 };
  return { lifecycle, claim, state: () => state };
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

it('rejects an old execution and accepts only the current execution completion', async () => {
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
  const completed = await f.lifecycle.request({ kind: 'finish', assignment: identity, success: true, now: 1 }, 1);
  expect(completed).toMatchObject({ kind: 'updated', record: { status: 'completed' } });
  expect(f.state().tasks[0]).toMatchObject({ status: 'completed', completion: { success: true } });
  expect(f.state().tasks[0]!.completion).not.toHaveProperty('branch');
  expect(f.state().tasks[0]!.completion).not.toHaveProperty('sha');
  expect(doubles.event).toHaveBeenCalledOnce();
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
