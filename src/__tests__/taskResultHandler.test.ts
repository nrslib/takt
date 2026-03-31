import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

import { info } from '../shared/ui/index.js';
import { persistExceededTaskResult } from '../features/tasks/execute/taskResultHandler.js';
import type { TaskInfo } from '../infra/task/index.js';

const mockInfo = vi.mocked(info);

describe('persistExceededTaskResult', () => {
  const taskRunner = {
    exceedTask: vi.fn(),
  };

  const task: TaskInfo = {
    name: 'task-a',
    content: 'Implement feature',
    filePath: '/tmp/task-a.yaml',
    createdAt: '2026-03-31T00:00:00.000Z',
    status: 'running',
    data: {
      task: 'Implement feature',
      piece: 'default',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should record exceeded metadata and log the current step with canonical wording', () => {
    persistExceededTaskResult(taskRunner as never, task, {
      currentMovement: 'reviewers',
      newMaxMovements: 60,
      currentIteration: 30,
    });

    expect(taskRunner.exceedTask).toHaveBeenCalledWith('task-a', {
      currentMovement: 'reviewers',
      newMaxMovements: 60,
      currentIteration: 30,
    });
    expect(mockInfo).toHaveBeenCalledWith(
      'Task "task-a" exceeded iteration limit at step "reviewers"',
    );
  });
});
