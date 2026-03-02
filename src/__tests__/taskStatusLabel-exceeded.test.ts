/**
 * Unit tests for formatTaskStatusLabel with exceeded status
 *
 * Covers:
 * - exceeded kind formats as '[exceeded] name'
 * - exceeded with branch
 * - exceeded with issue number
 */

import { describe, it, expect } from 'vitest';
import { formatTaskStatusLabel } from '../features/tasks/list/taskStatusLabel.js';
import type { TaskListItem } from '../infra/task/types.js';

function makeExceededTask(overrides: Partial<TaskListItem>): TaskListItem {
  return {
    kind: 'exceeded',
    name: 'test-task',
    createdAt: '2026-02-11T00:00:00.000Z',
    filePath: '/tmp/task.md',
    content: 'content',
    ...overrides,
  };
}

describe('formatTaskStatusLabel - exceeded', () => {
  it("should format exceeded task as '[exceeded] name'", () => {
    // Given: an exceeded task
    const task = makeExceededTask({ name: 'implement-feature' });

    // When: formatTaskStatusLabel is called
    const label = formatTaskStatusLabel(task);

    // Then: label shows exceeded status
    expect(label).toBe('[exceeded] implement-feature');
  });

  it('should include branch when present', () => {
    // Given: an exceeded task with a branch
    const task = makeExceededTask({
      name: 'fix-login-bug',
      branch: 'takt/366/fix-login-bug',
    });

    // When: formatTaskStatusLabel is called
    const label = formatTaskStatusLabel(task);

    // Then: label includes branch
    expect(label).toBe('[exceeded] fix-login-bug (takt/366/fix-login-bug)');
  });

  it('should not include branch when absent', () => {
    // Given: an exceeded task without branch
    const task = makeExceededTask({ name: 'my-task' });

    // When: formatTaskStatusLabel is called
    const label = formatTaskStatusLabel(task);

    // Then: no branch in label
    expect(label).toBe('[exceeded] my-task');
  });

  it('should include issue number when present', () => {
    // Given: an exceeded task with issue number
    const task = makeExceededTask({
      name: 'implement-feature',
      issueNumber: 42,
    });

    // When: formatTaskStatusLabel is called
    const label = formatTaskStatusLabel(task);

    // Then: label includes issue number
    expect(label).toBe('[exceeded] implement-feature #42');
  });

  it('should include both issue number and branch when both present', () => {
    // Given: an exceeded task with both issue and branch
    const task = makeExceededTask({
      name: 'fix-bug',
      issueNumber: 366,
      branch: 'takt/366/fix-bug',
    });

    // When: formatTaskStatusLabel is called
    const label = formatTaskStatusLabel(task);

    // Then: label includes both
    expect(label).toBe('[exceeded] fix-bug #366 (takt/366/fix-bug)');
  });
});
