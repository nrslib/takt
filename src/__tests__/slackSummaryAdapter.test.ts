/**
 * Tests for slackSummaryAdapter
 */

import { describe, it, expect } from 'vitest';
import type { TaskListItem } from '../infra/task/index.js';
import { toSlackTaskDetail } from '../features/tasks/execute/slackSummaryAdapter.js';

function makeItem(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    kind: 'completed',
    name: 'task-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    filePath: '/tmp/task-1.yaml',
    content: 'Do something',
    ...overrides,
  };
}

describe('toSlackTaskDetail', () => {
  it('should throw when data.piece is undefined', () => {
    const item = makeItem({ data: undefined });
    expect(() => toSlackTaskDetail(item)).toThrow('Task data must include piece for Slack summary');
  });

  it('should throw when data exists but piece is missing', () => {
    const item = makeItem({
      data: { task: 'Do something', piece: undefined },
    });
    expect(() => toSlackTaskDetail(item)).toThrow('Task data must include piece for Slack summary');
  });

  it('should return SlackTaskDetail for a completed task', () => {
    const item = makeItem({
      kind: 'completed',
      data: { task: 'Do something', piece: 'default' },
      branch: 'takt/123/my-task',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
    });

    const detail = toSlackTaskDetail(item);

    expect(detail.name).toBe('task-1');
    expect(detail.success).toBe(true);
    expect(detail.piece).toBe('default');
    expect(detail.durationSec).toBe(60);
    expect(detail.branch).toBe('takt/123/my-task');
  });

  it('should return SlackTaskDetail for a failed task', () => {
    const item = makeItem({
      kind: 'failed',
      data: { task: 'Do something', piece: 'default' },
      failure: { movement: 'implement', error: 'Something went wrong', last_message: 'Last msg' },
    });

    const detail = toSlackTaskDetail(item);

    expect(detail.success).toBe(false);
    expect(detail.failureMovement).toBe('implement');
    expect(detail.failureError).toBe('Something went wrong');
    expect(detail.failureLastMessage).toBe('Last msg');
  });
});
