import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { GoalAbortMonitor, GoalAbortedError } from '../features/tasks/execute/goalAbortMonitor.js';
import { TaskStoppedError } from '../infra/task/taskStop.js';

const doubles = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn(), error: vi.fn() }));
vi.mock('../infra/task/store.js', () => ({ TaskStore: class { read = doubles.read; } }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.get; } }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: doubles.error }) }));

describe('GoalAbortMonitor', () => {
  let monitor: GoalAbortMonitor | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    doubles.get.mockReturnValue(goalRecord());
    doubles.read.mockReturnValue({ tasks: [] });
  });
  afterEach(() => { monitor?.stop(); monitor = undefined; vi.useRealTimers(); });

  it('observes active, paused and aborted in the same execution without aborting another task', () => {
    const target = new AbortController();
    const other = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, target, { taskName: 'task-a', executionId: 'run-a' });
    expect(doubles.get).toHaveBeenCalledWith(goalId);
    doubles.get.mockReturnValue({ ...goalRecord(), executionStatus: 'paused' });
    vi.advanceTimersByTime(500);
    expect(target.signal.aborted).toBe(false);
    doubles.get.mockReturnValue({ ...goalRecord(), executionStatus: 'aborted' });
    vi.advanceTimersByTime(500);
    expect(target.signal.reason).toBeInstanceOf(GoalAbortedError);
    expect(target.signal.reason.message).toContain(goalId);
    expect(other.signal.aborted).toBe(false);
  });

  it('aborts an already aborted goal at startup', () => {
    doubles.get.mockReturnValue({ ...goalRecord(), executionStatus: 'aborted' });
    const controller = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, controller, { taskName: 'task-a', executionId: 'run-a' });
    expect(controller.signal.reason).toBeInstanceOf(GoalAbortedError);
  });

  it('observes a later unowned task stop without reading goals and releases its timer', () => {
    const controller = new AbortController();
    monitor = new GoalAbortMonitor('/project', undefined, controller, { taskName: 'task-a', executionId: 'run-a' });
    vi.advanceTimersByTime(500);
    expect(controller.signal.aborted).toBe(false);
    doubles.read.mockReturnValue({ tasks: [{ name: 'task-a', status: 'running',
      execution_id: 'run-a', stop_request: { execution_id: 'run-a' } }] });
    vi.advanceTimersByTime(500);
    expect(controller.signal.reason).toBeInstanceOf(TaskStoppedError);
    expect(doubles.get).not.toHaveBeenCalled();
    monitor.stop();
    const reads = doubles.read.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(doubles.read).toHaveBeenCalledTimes(reads);
  });

  it('diagnoses a read failure and retries without treating it as an abort', () => {
    doubles.get.mockImplementationOnce(() => { throw new Error('read unavailable'); });
    const controller = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, controller, { taskName: 'task-a', executionId: 'run-a' });
    expect(controller.signal.aborted).toBe(false);
    expect(doubles.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ goalId, error: 'read unavailable' }));
    doubles.get.mockReturnValue({ ...goalRecord(), executionStatus: 'aborted' });
    vi.advanceTimersByTime(500);
    expect(controller.signal.reason).toBeInstanceOf(GoalAbortedError);
  });

  it('stops reading after the execution owner releases the monitor', () => {
    const controller = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, controller, { taskName: 'task-a', executionId: 'run-a' });
    monitor.stop();
    doubles.get.mockReturnValue({ ...goalRecord(), executionStatus: 'aborted' });
    vi.advanceTimersByTime(5000);
    expect(doubles.get).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(false);
  });

  it('observes a new task request in the same monitor and leaves a sibling running', () => {
    const controller = new AbortController();
    const sibling = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, controller, { taskName: 'task-a', executionId: 'run-a' });
    const other = new GoalAbortMonitor('/project', goalId, sibling, { taskName: 'task-b', executionId: 'run-b' });
    try {
      vi.advanceTimersByTime(500);
      expect(controller.signal.aborted).toBe(false);
      doubles.read.mockReturnValue({ tasks: [{ name: 'task-a', goal_id: goalId, status: 'running',
        execution_id: 'run-a', stop_request: { execution_id: 'run-a' } }] });
      vi.advanceTimersByTime(500);
      expect(controller.signal.reason).toBeInstanceOf(TaskStoppedError);
      expect(sibling.signal.aborted).toBe(false);
      const reads = doubles.read.mock.calls.length;
      monitor.stop(); other.stop();
      vi.advanceTimersByTime(1000);
      expect(doubles.read).toHaveBeenCalledTimes(reads);
    } finally { other.stop(); }
  });

  it.each([
    { goal_id: 'other-goal' }, { name: 'other-task' }, { execution_id: 'old-run' },
    { stop_request: { execution_id: 'old-run' } }, { status: 'failed' },
  ])('ignores a request outside its own running execution: %j', (changes) => {
    doubles.read.mockReturnValue({ tasks: [{ name: 'task-a', goal_id: goalId, status: 'running',
      execution_id: 'run-a', stop_request: { execution_id: 'run-a' }, ...changes }] });
    const controller = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, controller, { taskName: 'task-a', executionId: 'run-a' });
    vi.advanceTimersByTime(500);
    expect(controller.signal.aborted).toBe(false);
  });

  it('retries task reads and still observes a task request when goal reads fail', () => {
    doubles.read.mockImplementationOnce(() => { throw new Error('task read unavailable'); });
    doubles.get.mockImplementation(() => { throw new Error('goal read unavailable'); });
    const controller = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, controller, { taskName: 'task-a', executionId: 'run-a' });
    expect(controller.signal.aborted).toBe(false);
    expect(doubles.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: 'task read unavailable' }));
    doubles.read.mockReturnValue({ tasks: [{ name: 'task-a', goal_id: goalId, status: 'running',
      execution_id: 'run-a', stop_request: { execution_id: 'run-a' } }] });
    vi.advanceTimersByTime(500);
    expect(controller.signal.reason).toBeInstanceOf(TaskStoppedError);
  });
});
