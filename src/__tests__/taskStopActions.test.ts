import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';
import { getLabel } from '../shared/i18n/index.js';

const doubles = vi.hoisted(() => ({ request: vi.fn(), confirm: vi.fn(), stale: vi.fn(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class { requestTaskStop = doubles.request; }, isStaleRunningTask: doubles.stale,
}));
vi.mock('../shared/prompt/index.js', () => ({ confirm: doubles.confirm }));
vi.mock('../shared/ui/index.js', () => ({ info: doubles.info, warn: doubles.warn, error: doubles.error }));

import { stopRunningTask } from '../features/tasks/list/taskStopActions.js';

const task: TaskListItem = { name: 'selected-task', executionId: 'selected-execution', kind: 'running',
  content: 'work', createdAt: '2026-10-21T00:00:00Z', filePath: '/project/.takt/tasks.yaml', ownerPid: 123 };

describe('stopRunningTask', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.stale.mockReturnValue(false);
    doubles.confirm.mockResolvedValue(true);
  });

  it.each(['en', 'ja'] as const)('confirms and requests the selected execution, then reports worker ownership (%s)', async (lang) => {
    expect(await stopRunningTask(task, '/project', lang)).toBe(true);
    expect(doubles.confirm).toHaveBeenCalledWith(getLabel('taskStop.confirm', lang, { name: task.name }), false);
    expect(doubles.request).toHaveBeenCalledExactlyOnceWith(undefined, task.name, task.executionId);
    expect(doubles.info).toHaveBeenCalledWith(getLabel('taskStop.requested', lang, { name: task.name }));
    expect(doubles.info.mock.calls[0]![0]).toMatch(/worker/);
  });

  it('passes the saved goal affiliation without replacing the selected execution', async () => {
    await stopRunningTask({ ...task, goalId: 'saved-goal' }, '/project', 'en');
    expect(doubles.request).toHaveBeenCalledWith('saved-goal', task.name, task.executionId);
  });

  it('does not save a declined request', async () => {
    doubles.confirm.mockResolvedValue(false);
    expect(await stopRunningTask(task, '/project', 'en')).toBe(false);
    expect(doubles.request).not.toHaveBeenCalled();
    expect(doubles.info).not.toHaveBeenCalled();
  });

  it('directs a stale owner to Mark as failed without requesting a stop', async () => {
    doubles.stale.mockReturnValue(true);
    expect(await stopRunningTask(task, '/project', 'en')).toBe(false);
    expect(doubles.warn).toHaveBeenCalledWith(getLabel('taskStop.staleOwner', 'en'));
    expect(doubles.confirm).not.toHaveBeenCalled();
    expect(doubles.request).not.toHaveBeenCalled();
  });

  it('rejects a missing execution ID before confirmation', async () => {
    expect(await stopRunningTask({ ...task, executionId: undefined }, '/project', 'ja')).toBe(false);
    expect(doubles.warn).toHaveBeenCalledWith(getLabel('taskStop.missingExecutionId', 'ja'));
    expect(doubles.confirm).not.toHaveBeenCalled();
    expect(doubles.request).not.toHaveBeenCalled();
  });

  it.each(['execution mismatch', 'not running', 'owner is not alive'])('displays the persistence rejection: %s', async (reason) => {
    doubles.request.mockImplementation(() => { throw new Error(reason); });
    expect(await stopRunningTask(task, '/project', 'en')).toBe(false);
    expect(doubles.error).toHaveBeenCalledWith(getLabel('taskStop.rejected', 'en', { reason }));
    expect(doubles.info).not.toHaveBeenCalled();
  });

  it('rejects a non-running task', async () => {
    await expect(stopRunningTask({ ...task, kind: 'failed' }, '/project', 'en')).rejects.toThrow(/requires running/);
    expect(doubles.request).not.toHaveBeenCalled();
  });
});
