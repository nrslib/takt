import { beforeEach, expect, it, vi } from 'vitest';
import { stopTaktGoalTask } from '../features/mcp/goalTaskStopOperations.js';
import { stopGoalTaskInputSchema } from '../features/mcp/goalTaskStopSchemas.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const doubles = vi.hoisted(() => ({ get: vi.fn(), stop: vi.fn(), root: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; } }));
vi.mock('../infra/task/runner.js', () => ({ TaskRunner: class { requestTaskStop = doubles.stop; } }));
vi.mock('../features/manager/notifications.js', () => ({ resolveManagerNotificationOptions: () => ({ policy: {}, mainMerge: 'approve' }), sendSavedGoalNotifications: vi.fn() }));
vi.mock('../features/mcp/operations.js', async (original) => ({ ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.root }));
const input = { cwd: '/project', goalId: goalRecord().id, taskName: 'task-a', executionId: 'run-a' };
beforeEach(() => {
  vi.resetAllMocks();
  doubles.get.mockResolvedValue(goalRecord());
  doubles.stop.mockReturnValue({ execution_id: 'run-a', requested_at: '2026-10-21T00:00:00.000Z' });
});

it('validates the execution identity and delegates a stop without changing goal state', async () => {
  const result = await stopTaktGoalTask(input, {}, new AbortController().signal);
  expect(result.isError).toBeUndefined();
  expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ goalId: input.goalId,
    taskName: input.taskName, executionId: input.executionId,
    status: 'stop_requested', requestedAt: '2026-10-21T00:00:00.000Z' });
  expect(doubles.stop).toHaveBeenCalledExactlyOnceWith(input.goalId, input.taskName, input.executionId);
});

it.each(['goalId', 'taskName', 'executionId'] as const)('rejects missing %s before saving', async (key) => {
  const invalid = { ...input, [key]: '' };
  expect(stopGoalTaskInputSchema.safeParse(invalid).success).toBe(false);
  expect((await stopTaktGoalTask(invalid, {}, new AbortController().signal)).isError).toBe(true);
  expect(doubles.stop).not.toHaveBeenCalled();
});

it('returns the saved-state mismatch reason', async () => {
  doubles.stop.mockImplementation(() => { throw new Error('Task executionId does not match the saved execution'); });
  const result = await stopTaktGoalTask(input, {}, new AbortController().signal);
  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toContain('executionId does not match');
});

it('permits stopping existing work while its goal is paused', async () => {
  doubles.get.mockResolvedValue({ ...goalRecord(), executionStatus: 'paused' });
  expect((await stopTaktGoalTask(input, {}, new AbortController().signal)).isError).toBeUndefined();
  expect(doubles.stop).toHaveBeenCalledOnce();
});

it.each(['outside root', 'aborted request'] as const)('does not save when %s', async (condition) => {
  const controller = new AbortController();
  if (condition === 'outside root') doubles.root.mockImplementation(() => { throw new Error('Outside root'); });
  else controller.abort();
  expect((await stopTaktGoalTask(input, {}, controller.signal)).isError).toBe(true);
  expect(doubles.stop).not.toHaveBeenCalled();
});
