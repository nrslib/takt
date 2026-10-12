import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { GoalAbortMonitor, GoalAbortedError } from '../features/tasks/execute/goalAbortMonitor.js';

const doubles = vi.hoisted(() => ({ get: vi.fn(), error: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { getSync = doubles.get; } }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ error: doubles.error }) }));

describe('GoalAbortMonitor', () => {
  let monitor: GoalAbortMonitor | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    doubles.get.mockReturnValue(goalRecord());
  });
  afterEach(() => { monitor?.stop(); monitor = undefined; vi.useRealTimers(); });

  it('observes active, paused and aborted in the same execution without aborting another task', () => {
    const target = new AbortController();
    const other = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, target);
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
    monitor = new GoalAbortMonitor('/project', goalId, controller);
    expect(controller.signal.reason).toBeInstanceOf(GoalAbortedError);
  });

  it('diagnoses a read failure and retries without treating it as an abort', () => {
    doubles.get.mockImplementationOnce(() => { throw new Error('read unavailable'); });
    const controller = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, controller);
    expect(controller.signal.aborted).toBe(false);
    expect(doubles.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ goalId, error: 'read unavailable' }));
    doubles.get.mockReturnValue({ ...goalRecord(), executionStatus: 'aborted' });
    vi.advanceTimersByTime(500);
    expect(controller.signal.reason).toBeInstanceOf(GoalAbortedError);
  });

  it('stops reading after the execution owner releases the monitor', () => {
    const controller = new AbortController();
    monitor = new GoalAbortMonitor('/project', goalId, controller);
    monitor.stop();
    doubles.get.mockReturnValue({ ...goalRecord(), executionStatus: 'aborted' });
    vi.advanceTimersByTime(5000);
    expect(doubles.get).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(false);
  });
});
