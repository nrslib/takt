/**
 * Tests for source / pr_number fields in task schema and mapper
 *
 * Verifies that:
 * - TaskExecutionConfigSchema accepts source and pr_number
 * - TaskFileSchema accepts source and pr_number
 * - toBaseTaskListItem maps source → source, pr_number → prNumber
 * - buildTaskFileData (via toTaskData) passes source/pr_number through
 */

import { describe, it, expect } from 'vitest';

import {
  TaskExecutionConfigSchema,
  TaskFileSchema,
  TaskRecordSchema,
} from '../infra/task/schema.js';

import { toTaskListItem, toTaskData } from '../infra/task/mapper.js';

// ---- Helpers ----

function makePendingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-task',
    status: 'pending',
    content: 'do the thing',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

// ---- Schema: TaskExecutionConfigSchema ----

describe('TaskExecutionConfigSchema — source field', () => {
  it('accepts source: "pr_review" with pr_number', () => {
    const result = TaskExecutionConfigSchema.safeParse({ source: 'pr_review', pr_number: 123 });
    expect(result.success).toBe(true);
  });

  it('rejects source: "pr_review" without pr_number', () => {
    const result = TaskExecutionConfigSchema.safeParse({ source: 'pr_review' });
    expect(result.success).toBe(false);
  });

  it('accepts source: "issue"', () => {
    const result = TaskExecutionConfigSchema.safeParse({ source: 'issue' });
    expect(result.success).toBe(true);
  });

  it('accepts source: "manual"', () => {
    const result = TaskExecutionConfigSchema.safeParse({ source: 'manual' });
    expect(result.success).toBe(true);
  });

  it('rejects unknown source value', () => {
    const result = TaskExecutionConfigSchema.safeParse({ source: 'unknown_source' });
    expect(result.success).toBe(false);
  });

  it('accepts source omitted (optional field)', () => {
    const result = TaskExecutionConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('TaskExecutionConfigSchema — pr_number field', () => {
  it('accepts a positive integer pr_number', () => {
    const result = TaskExecutionConfigSchema.safeParse({ pr_number: 456 });
    expect(result.success).toBe(true);
  });

  it('rejects pr_number: 0', () => {
    const result = TaskExecutionConfigSchema.safeParse({ pr_number: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects negative pr_number', () => {
    const result = TaskExecutionConfigSchema.safeParse({ pr_number: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer pr_number', () => {
    const result = TaskExecutionConfigSchema.safeParse({ pr_number: 1.5 });
    expect(result.success).toBe(false);
  });

  it('accepts pr_number omitted (optional field)', () => {
    const result = TaskExecutionConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe('TaskExecutionConfigSchema — source and pr_number together', () => {
  it('accepts source: "pr_review" with pr_number', () => {
    const result = TaskExecutionConfigSchema.safeParse({
      source: 'pr_review',
      pr_number: 456,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('pr_review');
      expect(result.data.pr_number).toBe(456);
    }
  });
});

// ---- Schema: TaskFileSchema ----

describe('TaskFileSchema — source and pr_number', () => {
  it('accepts task file with source: "pr_review" and pr_number', () => {
    const result = TaskFileSchema.safeParse({
      task: 'Fix the auth bug',
      source: 'pr_review',
      pr_number: 456,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('pr_review');
      expect(result.data.pr_number).toBe(456);
    }
  });

  it('accepts task file without source (backward compat)', () => {
    const result = TaskFileSchema.safeParse({ task: 'Do something' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBeUndefined();
      expect(result.data.pr_number).toBeUndefined();
    }
  });
});

// ---- Schema: TaskRecordSchema ----

describe('TaskRecordSchema — source and pr_number', () => {
  it('parses a record with source: "pr_review" and pr_number', () => {
    const raw = makePendingRecord({ source: 'pr_review', pr_number: 456 });
    const result = TaskRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('pr_review');
      expect(result.data.pr_number).toBe(456);
    }
  });

  it('parses a record without source (backward compat)', () => {
    const raw = makePendingRecord();
    const result = TaskRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBeUndefined();
      expect(result.data.pr_number).toBeUndefined();
    }
  });
});

// ---- Mapper: toTaskListItem ----

describe('toTaskListItem — source and prNumber mapping', () => {
  it('maps source and pr_number from task record to TaskListItem', () => {
    // Given: a pending task record with PR source metadata
    const raw = makePendingRecord({ source: 'pr_review', pr_number: 456 });
    const task = TaskRecordSchema.parse(raw);

    // When
    const item = toTaskListItem('/project', '/project/.takt/tasks.yaml', task);

    // Then: fields are mapped to camelCase on the list item
    expect(item.source).toBe('pr_review');
    expect(item.prNumber).toBe(456);
  });

  it('source and prNumber are undefined when not set on the record', () => {
    // Given: a record without source
    const raw = makePendingRecord();
    const task = TaskRecordSchema.parse(raw);

    // When
    const item = toTaskListItem('/project', '/project/.takt/tasks.yaml', task);

    // Then
    expect(item.source).toBeUndefined();
    expect(item.prNumber).toBeUndefined();
  });
});

// ---- Mapper: toTaskData (buildTaskFileData) ----

describe('toTaskData — source and pr_number pass-through', () => {
  it('includes source and pr_number in the task file data', () => {
    // Given: a task record with PR metadata
    const raw = makePendingRecord({ source: 'pr_review', pr_number: 456 });
    const task = TaskRecordSchema.parse(raw);

    // When
    const data = toTaskData('/project', task);

    // Then: source and pr_number are present in the serialized file data
    expect(data.source).toBe('pr_review');
    expect(data.pr_number).toBe(456);
  });

  it('source and pr_number absent in task file data when not set', () => {
    // Given
    const raw = makePendingRecord();
    const task = TaskRecordSchema.parse(raw);

    // When
    const data = toTaskData('/project', task);

    // Then
    expect(data.source).toBeUndefined();
    expect(data.pr_number).toBeUndefined();
  });
});
