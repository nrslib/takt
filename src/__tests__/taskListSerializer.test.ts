import { describe, expect, it } from 'vitest';
import { serializeTaskListItemForJson, type TaskListItem } from '../infra/task/index.js';

describe('serializeTaskListItemForJson', () => {
  it('should expose an explicit public DTO for list json output', () => {
    const task: TaskListItem = {
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2026-02-09T00:00:00.000Z',
      filePath: '/tmp/.takt/tasks.yaml',
      content: 'Failed content',
      summary: 'summary',
      branch: 'feature/test',
      worktreePath: '/tmp/worktree',
      prUrl: 'https://example.com/pr/1',
      startedAt: '2026-02-09T00:01:00.000Z',
      completedAt: '2026-02-09T00:02:00.000Z',
      ownerPid: 1234,
      issueNumber: 42,
      exceededMaxSteps: 8,
      exceededCurrentIteration: 3,
      data: {
        task: 'task body',
        piece: 'workflow-alpha',
        start_movement: 'implement',
        retry_note: 'retry',
      },
      failure: {
        movement: 'review',
        error: 'Boom',
        last_message: 'last',
      },
    };

    const serialized = serializeTaskListItemForJson(task) as Record<string, unknown>;
    const serializedData = serialized.data as Record<string, unknown>;
    const serializedFailure = serialized.failure as Record<string, unknown>;

    expect(serialized).toEqual({
      kind: 'failed',
      name: 'failed-task',
      createdAt: '2026-02-09T00:00:00.000Z',
      filePath: '/tmp/.takt/tasks.yaml',
      content: 'Failed content',
      summary: 'summary',
      branch: 'feature/test',
      worktreePath: '/tmp/worktree',
      prUrl: 'https://example.com/pr/1',
      startedAt: '2026-02-09T00:01:00.000Z',
      completedAt: '2026-02-09T00:02:00.000Z',
      ownerPid: 1234,
      issueNumber: 42,
      exceededMaxSteps: 8,
      exceededCurrentIteration: 3,
      data: {
        task: 'task body',
        workflow: 'workflow-alpha',
        start_step: 'implement',
        retry_note: 'retry',
      },
      failure: {
        step: 'review',
        error: 'Boom',
        last_message: 'last',
      },
    });
    expect(serializedData).not.toHaveProperty('piece');
    expect(serializedData).not.toHaveProperty('start_movement');
    expect(serializedFailure).not.toHaveProperty('movement');
  });
});
