import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ queue: vi.fn(), owner: vi.fn(), acquire: vi.fn(), spawn: vi.fn(), enqueue: vi.fn(), config: vi.fn() }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { read() { return { tasks: doubles.queue() }; } } }));
vi.mock('../infra/task/mapper.js', () => ({ resolveTaskContent: () => 'work' }));
vi.mock('../infra/task/project-execution-lock.js', async (original) => ({
  ...await original<typeof import('../infra/task/project-execution-lock.js')>(),
  getProjectExecutionOwner: doubles.owner, acquireProjectExecutionLock: doubles.acquire,
}));
vi.mock('../infra/config/managerConfig.js', () => ({ resolveManagerConfig: doubles.config }));
vi.mock('../infra/task/manager-run-state.js', () => ({ recordManagerRunFailure: vi.fn() }));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: vi.fn() }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: () => true, openSync: () => 99, closeSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: doubles.spawn }));
vi.mock('../infra/task/enqueueService.js', () => ({ enqueueTask: doubles.enqueue }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = async () => goalRecord(); update = vi.fn(); } }));
vi.mock('../infra/goals/reconcile.js', () => ({ reconcileGoalTasks: vi.fn() }));
vi.mock('../infra/goals/operations.js', async (original) => ({
  ...await original<typeof import('../infra/goals/operations.js')>(),
  withGoalWrites: async (_cwd: string, _id: string, action: () => Promise<unknown>) => action(),
}));
vi.mock('../features/manager/notifications.js', () => ({
  resolveManagerNotificationOptions: () => ({ policy: {}, mainMerge: 'approve' }),
  sendSavedGoalNotifications: vi.fn(),
}));
vi.mock('../infra/goals/turn-lock.js', () => ({
  GOAL_TURN_OWNERS_ENV: 'TAKT_MANAGER_GOAL_OWNERS',
  withGoalTurns: async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action(),
}));
vi.mock('../features/mcp/goalWorkflowValidation.js', () => ({ validateGoalWorkflow: vi.fn() }));
import { enqueueTaktGoalTask } from '../features/mcp/goalOperations.js';
import { withProjectExecution } from '../features/tasks/execute/projectExecution.js';
import { ProjectExecutionAlreadyRunningError } from '../infra/task/project-execution-lock.js';
let owned: boolean;
let pending: boolean;
let order: string[];
beforeEach(() => {
  vi.resetAllMocks();
  owned = false;
  pending = false;
  order = [];
  doubles.config.mockReturnValue({ autoRun: true, mainMerge: 'approve' });
  doubles.queue.mockImplementation(() => {
    order.push(pending ? 'read-pending' : 'read-empty');
    return pending ? [{ name: 'saved-task', status: 'pending', content: 'work', goal_id: goalRecord().id }] : [];
  });
  doubles.owner.mockImplementation(() => { order.push(owned ? 'owner-alive' : 'no-owner'); return owned ? { kind: 'run' } : undefined; });
  doubles.acquire.mockImplementation(() => {
    owned = true;
    return { updateState: vi.fn(), release: () => { owned = false; order.push('released'); } };
  });
  doubles.enqueue.mockImplementation(async () => { pending = true; order.push('saved'); return { taskName: 'saved-task' }; });
  doubles.spawn.mockImplementation(() => {
    order.push('spawn');
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
});
const input = { cwd: '/project', goalId: goalRecord().id, purpose: '検証する', task: 'work', workflow: 'safe' };
it.each([false, true])('starts late saved work after a run that claimed tasks releases, automatic=%s', async (automatic) => {
  let finish!: () => void;
  const run = withProjectExecution('/project', 'run', (context) => {
    context.onTasksClaimed();
    return new Promise<void>((resolve) => { finish = resolve; });
  }, automatic);
  try {
    expect((await enqueueTaktGoalTask(input, {}, new AbortController().signal)).isError).toBeUndefined();
    expect(doubles.spawn).not.toHaveBeenCalled();
    expect(order).toEqual(['saved', 'read-pending', 'owner-alive']);
  } finally { finish(); await run; }
  expect(order).toEqual(['saved', 'read-pending', 'owner-alive', 'released', 'read-pending', 'no-owner', 'spawn']);
  expect(doubles.spawn).toHaveBeenCalledOnce();
});
it.each([false, true])('starts work saved after a run that claimed tasks releases and rereads an empty queue, automatic=%s', async (automatic) => {
  let save!: () => void;
  doubles.enqueue.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { save = resolve; });
    pending = true;
    order.push('saved');
    return { taskName: 'saved-task' };
  });
  const enqueue = enqueueTaktGoalTask(input, {}, new AbortController().signal);
  await vi.waitFor(() => expect(doubles.enqueue).toHaveBeenCalledOnce());
  try {
    await withProjectExecution('/project', 'run', async (context) => { context.onTasksClaimed(); }, automatic);
    expect(order).toEqual(['released', 'read-empty']);
    expect(doubles.spawn).not.toHaveBeenCalled();
  } finally { save(); }
  expect((await enqueue).isError).toBeUndefined();
  expect(order).toEqual(['released', 'read-empty', 'saved', 'read-pending', 'no-owner', 'spawn']);
  expect(doubles.spawn).toHaveBeenCalledOnce();
});
it('returns immediately for an automatic run when another live run owns the project lock', async () => {
  const error = new ProjectExecutionAlreadyRunningError({ ownerId: 'owner', pid: 123,
    processIdentity: { startTime: 'start' }, kind: 'run', state: 'running' });
  doubles.acquire.mockImplementation(() => { throw error; });
  const execute = vi.fn();
  await expect(withProjectExecution('/project', 'run', execute, true)).resolves.toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(doubles.queue).not.toHaveBeenCalled();
  expect(doubles.spawn).not.toHaveBeenCalled();
});
it('does not relaunch ordinary pending work after releasing the execution lock', async () => {
  doubles.queue.mockReturnValue([{ name: 'ordinary', status: 'pending', content: 'work' }]);
  await withProjectExecution('/project', 'run', async () => {});
  expect(order).toEqual(['released']);
  expect(doubles.spawn).not.toHaveBeenCalled();
});
