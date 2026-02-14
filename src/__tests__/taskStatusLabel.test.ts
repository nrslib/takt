import { describe, expect, it } from 'vitest';
import { formatTaskStatusLabel } from '../features/tasks/list/taskStatusLabel.js';
import type { TaskListItem } from '../infra/task/types.js';

describe('formatTaskStatusLabel', () => {
  it("should format pending task as '[pending] name'", () => {
    // Given: pending タスク
    const task: TaskListItem = {
      kind: 'pending',
      name: 'implement test',
      createdAt: '2026-02-11T00:00:00.000Z',
      filePath: '/tmp/task.md',
      content: 'content',
    };

    // When: ステータスラベルを生成する
    const result = formatTaskStatusLabel(task);

    // Then: pending は pending 表示になる
    expect(result).toBe('[pending] implement test');
  });

  it("should format failed task as '[failed] name'", () => {
    // Given: failed タスク
    const task: TaskListItem = {
      kind: 'failed',
      name: 'retry payment',
      createdAt: '2026-02-11T00:00:00.000Z',
      filePath: '/tmp/task.md',
      content: 'content',
    };

    // When: ステータスラベルを生成する
    const result = formatTaskStatusLabel(task);

    // Then: failed は failed 表示になる
    expect(result).toBe('[failed] retry payment');
  });
});
