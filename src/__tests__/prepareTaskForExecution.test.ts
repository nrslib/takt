import { describe, expect, it } from 'vitest';
import { prepareTaskForExecution } from '../features/tasks/list/prepareTaskForExecution.js';
import type { TaskInfo } from '../infra/task/types.js';

function createTaskInfo(data: TaskInfo['data']): TaskInfo {
  return {
    filePath: '/project/.takt/tasks.yaml',
    name: 'task-1',
    content: 'task content',
    createdAt: '2026-03-04T00:00:00.000Z',
    status: 'running',
    data,
  };
}

describe('prepareTaskForExecution', () => {
  it('returns copied task with selected piece', () => {
    const original = createTaskInfo({ task: 'task content', piece: 'original-piece' });

    const prepared = prepareTaskForExecution(original, 'selected-piece');

    expect(prepared).not.toBe(original);
    expect(prepared.data).not.toBe(original.data);
    expect(prepared.data?.piece).toBe('selected-piece');
    expect(original.data?.piece).toBe('original-piece');
  });

  it('throws when task data is missing', () => {
    const original = createTaskInfo(null);

    expect(() => prepareTaskForExecution(original, 'selected-piece')).toThrow(
      'Task "task-1" is missing required data.',
    );
  });
});
