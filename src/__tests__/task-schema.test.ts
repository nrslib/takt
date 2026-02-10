/**
 * Unit tests for task schema validation
 *
 * Tests TaskRecordSchema cross-field validation rules (status-dependent constraints).
 */

import { describe, it, expect } from 'vitest';
import {
  TaskRecordSchema,
  TaskFileSchema,
  TaskExecutionConfigSchema,
} from '../infra/task/schema.js';

function makePendingRecord() {
  return {
    name: 'test-task',
    status: 'pending' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
  };
}

function makeRunningRecord() {
  return {
    name: 'test-task',
    status: 'running' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: '2025-01-01T01:00:00.000Z',
    completed_at: null,
  };
}

function makeCompletedRecord() {
  return {
    name: 'test-task',
    status: 'completed' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: '2025-01-01T01:00:00.000Z',
    completed_at: '2025-01-01T02:00:00.000Z',
  };
}

function makeFailedRecord() {
  return {
    name: 'test-task',
    status: 'failed' as const,
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: '2025-01-01T01:00:00.000Z',
    completed_at: '2025-01-01T02:00:00.000Z',
    failure: { error: 'something went wrong' },
  };
}

describe('TaskExecutionConfigSchema', () => {
  it('should accept valid config with all optional fields', () => {
    const config = {
      worktree: true,
      branch: 'feature/test',
      piece: 'unit-test',
      issue: 42,
      start_movement: 'plan',
      retry_note: 'retry after fix',
      auto_pr: true,
    };
    expect(() => TaskExecutionConfigSchema.parse(config)).not.toThrow();
  });

  it('should accept empty config (all fields optional)', () => {
    expect(() => TaskExecutionConfigSchema.parse({})).not.toThrow();
  });

  it('should accept worktree as string', () => {
    expect(() => TaskExecutionConfigSchema.parse({ worktree: '/custom/path' })).not.toThrow();
  });

  it('should reject negative issue number', () => {
    expect(() => TaskExecutionConfigSchema.parse({ issue: -1 })).toThrow();
  });

  it('should reject non-integer issue number', () => {
    expect(() => TaskExecutionConfigSchema.parse({ issue: 1.5 })).toThrow();
  });
});

describe('TaskFileSchema', () => {
  it('should accept valid task with required fields', () => {
    expect(() => TaskFileSchema.parse({ task: 'do something' })).not.toThrow();
  });

  it('should reject empty task string', () => {
    expect(() => TaskFileSchema.parse({ task: '' })).toThrow();
  });

  it('should reject missing task field', () => {
    expect(() => TaskFileSchema.parse({})).toThrow();
  });
});

describe('TaskRecordSchema', () => {
  describe('pending status', () => {
    it('should accept valid pending record', () => {
      expect(() => TaskRecordSchema.parse(makePendingRecord())).not.toThrow();
    });

    it('should reject pending record with started_at', () => {
      const record = { ...makePendingRecord(), started_at: '2025-01-01T01:00:00.000Z' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject pending record with completed_at', () => {
      const record = { ...makePendingRecord(), completed_at: '2025-01-01T02:00:00.000Z' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject pending record with failure', () => {
      const record = { ...makePendingRecord(), failure: { error: 'fail' } };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject pending record with owner_pid', () => {
      const record = { ...makePendingRecord(), owner_pid: 1234 };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('running status', () => {
    it('should accept valid running record', () => {
      expect(() => TaskRecordSchema.parse(makeRunningRecord())).not.toThrow();
    });

    it('should reject running record without started_at', () => {
      const record = { ...makeRunningRecord(), started_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject running record with completed_at', () => {
      const record = { ...makeRunningRecord(), completed_at: '2025-01-01T02:00:00.000Z' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject running record with failure', () => {
      const record = { ...makeRunningRecord(), failure: { error: 'fail' } };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should accept running record with owner_pid', () => {
      const record = { ...makeRunningRecord(), owner_pid: 5678 };
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });
  });

  describe('completed status', () => {
    it('should accept valid completed record', () => {
      expect(() => TaskRecordSchema.parse(makeCompletedRecord())).not.toThrow();
    });

    it('should reject completed record without started_at', () => {
      const record = { ...makeCompletedRecord(), started_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject completed record without completed_at', () => {
      const record = { ...makeCompletedRecord(), completed_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject completed record with failure', () => {
      const record = { ...makeCompletedRecord(), failure: { error: 'fail' } };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject completed record with owner_pid', () => {
      const record = { ...makeCompletedRecord(), owner_pid: 1234 };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('failed status', () => {
    it('should accept valid failed record', () => {
      expect(() => TaskRecordSchema.parse(makeFailedRecord())).not.toThrow();
    });

    it('should reject failed record without started_at', () => {
      const record = { ...makeFailedRecord(), started_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject failed record without completed_at', () => {
      const record = { ...makeFailedRecord(), completed_at: null };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject failed record without failure', () => {
      const record = { ...makeFailedRecord(), failure: undefined };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject failed record with owner_pid', () => {
      const record = { ...makeFailedRecord(), owner_pid: 1234 };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('content requirement', () => {
    it('should accept record with content', () => {
      expect(() => TaskRecordSchema.parse(makePendingRecord())).not.toThrow();
    });

    it('should accept record with content_file', () => {
      const record = { ...makePendingRecord(), content: undefined, content_file: './task.md' };
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });

    it('should accept record with task_dir', () => {
      const record = { ...makePendingRecord(), content: undefined, task_dir: '.takt/tasks/20260201-000000-task' };
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });

    it('should reject record with neither content, content_file, nor task_dir', () => {
      const record = { ...makePendingRecord(), content: undefined };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with both content and task_dir', () => {
      const record = { ...makePendingRecord(), task_dir: '.takt/tasks/20260201-000000-task' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with invalid task_dir format', () => {
      const record = { ...makePendingRecord(), content: undefined, task_dir: '.takt/reports/invalid' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with parent-directory task_dir', () => {
      const record = { ...makePendingRecord(), content: undefined, task_dir: '.takt/tasks/..' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with empty content', () => {
      const record = { ...makePendingRecord(), content: '' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject record with empty content_file', () => {
      const record = { ...makePendingRecord(), content: undefined, content_file: '' };
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });
});
