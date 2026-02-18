import { describe, expect, it } from 'vitest';
import { formatTaskStatusLabel, formatShortDate } from '../features/tasks/list/taskStatusLabel.js';
import type { TaskListItem } from '../infra/task/types.js';

function makeTask(overrides: Partial<TaskListItem>): TaskListItem {
  return {
    kind: 'pending',
    name: 'test-task',
    createdAt: '2026-02-11T00:00:00.000Z',
    filePath: '/tmp/task.md',
    content: 'content',
    ...overrides,
  };
}

describe('formatTaskStatusLabel', () => {
  it("should format pending task as '[pending] name'", () => {
    const task = makeTask({ kind: 'pending', name: 'implement-test' });
    expect(formatTaskStatusLabel(task)).toBe('[pending] implement-test');
  });

  it("should format failed task as '[failed] name'", () => {
    const task = makeTask({ kind: 'failed', name: 'retry-payment' });
    expect(formatTaskStatusLabel(task)).toBe('[failed] retry-payment');
  });

  it('should include branch when present', () => {
    const task = makeTask({
      kind: 'completed',
      name: 'fix-login-bug',
      branch: 'takt/284/fix-login-bug',
    });
    expect(formatTaskStatusLabel(task)).toBe('[completed] fix-login-bug (takt/284/fix-login-bug)');
  });

  it('should not include branch when absent', () => {
    const task = makeTask({ kind: 'running', name: 'my-task' });
    expect(formatTaskStatusLabel(task)).toBe('[running] my-task');
  });
});

describe('formatShortDate', () => {
  it('should format ISO string to MM/DD HH:mm', () => {
    expect(formatShortDate('2025-02-18T14:30:00.000Z')).toBe('02/18 14:30');
  });

  it('should zero-pad single digit values', () => {
    expect(formatShortDate('2025-01-05T03:07:00.000Z')).toBe('01/05 03:07');
  });
});
