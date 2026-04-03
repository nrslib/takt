/**
 * Unit tests for `exceeded` status schema validation
 *
 * Covers:
 * - TaskRecordSchema cross-field validation for `exceeded` status
 * - TaskExecutionConfigSchema new fields: exceeded_max_movements, exceeded_current_iteration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TaskRecordSchema,
  TaskExecutionConfigSchema,
  TaskStatusSchema,
} from '../infra/task/schema.js';

function makeExceededRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-task',
    status: 'exceeded',
    content: 'task content',
    created_at: '2025-01-01T00:00:00.000Z',
    started_at: '2025-01-01T01:00:00.000Z',
    completed_at: '2025-01-01T02:00:00.000Z',
    start_step: 'plan',
    exceeded_max_steps: 60,
    exceeded_current_iteration: 30,
    ...overrides,
  };
}

describe('TaskStatusSchema', () => {
  it('should accept exceeded as a valid status', () => {
    expect(() => TaskStatusSchema.parse('exceeded')).not.toThrow();
  });

  it('should still accept all existing statuses', () => {
    expect(() => TaskStatusSchema.parse('pending')).not.toThrow();
    expect(() => TaskStatusSchema.parse('running')).not.toThrow();
    expect(() => TaskStatusSchema.parse('completed')).not.toThrow();
    expect(() => TaskStatusSchema.parse('failed')).not.toThrow();
  });

  it('should reject unknown status', () => {
    expect(() => TaskStatusSchema.parse('unknown')).toThrow();
  });
});

describe('TaskExecutionConfigSchema - exceeded fields', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should accept exceeded_max_movements as a positive integer', () => {
    expect(() => TaskExecutionConfigSchema.parse({ exceeded_max_movements: 60 })).not.toThrow();
  });

  it('should accept exceeded_current_iteration as a non-negative integer', () => {
    expect(() => TaskExecutionConfigSchema.parse({ exceeded_current_iteration: 30 })).not.toThrow();
  });

  it('should accept exceeded_current_iteration as zero', () => {
    expect(() => TaskExecutionConfigSchema.parse({ exceeded_current_iteration: 0 })).not.toThrow();
  });

  it('should accept both fields together', () => {
    expect(() => TaskExecutionConfigSchema.parse({
      exceeded_max_movements: 60,
      exceeded_current_iteration: 30,
    })).not.toThrow();
  });

  it('should accept config without exceeded fields (optional)', () => {
    expect(() => TaskExecutionConfigSchema.parse({})).not.toThrow();
  });

  it('should reject exceeded_max_movements as zero', () => {
    expect(() => TaskExecutionConfigSchema.parse({ exceeded_max_movements: 0 })).toThrow();
  });

  it('should reject exceeded_max_movements as negative', () => {
    expect(() => TaskExecutionConfigSchema.parse({ exceeded_max_movements: -1 })).toThrow();
  });

  it('should reject exceeded_max_movements as non-integer', () => {
    expect(() => TaskExecutionConfigSchema.parse({ exceeded_max_movements: 1.5 })).toThrow();
  });

  it('should accept exceeded_max_steps as alias and strip it from output (#581)', () => {
    const parsed = TaskExecutionConfigSchema.parse({ exceeded_max_steps: 60 });
    expect(parsed.exceeded_max_movements).toBe(60);
    expect('exceeded_max_steps' in parsed).toBe(false);
  });

  it('should reject when exceeded_max_steps and exceeded_max_movements disagree (#581)', () => {
    expect(() =>
      TaskExecutionConfigSchema.parse({
        exceeded_max_steps: 10,
        exceeded_max_movements: 20,
      }),
    ).toThrow(/exceeded_max_steps.*exceeded_max_movements/);
  });

  it('should reject exceeded_current_iteration as negative', () => {
    expect(() => TaskExecutionConfigSchema.parse({ exceeded_current_iteration: -1 })).toThrow();
  });

  it('should reject exceeded_current_iteration as non-integer', () => {
    expect(() => TaskExecutionConfigSchema.parse({ exceeded_current_iteration: 0.5 })).toThrow();
  });
});

describe('TaskRecordSchema - exceeded status', () => {
  describe('valid exceeded record', () => {
    it('should accept a valid exceeded record with all required fields', () => {
      expect(() => TaskRecordSchema.parse(makeExceededRecord())).not.toThrow();
    });

    it('should accept exceeded record without start_step (optional)', () => {
      const record = makeExceededRecord({ start_step: undefined });
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });

    it('should reject exceeded record with only exceeded_current_iteration set (exceeded max missing)', () => {
      const record = makeExceededRecord({ exceeded_max_steps: undefined });
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should reject exceeded record with only exceeded max set (exceeded_current_iteration missing)', () => {
      const record = makeExceededRecord({ exceeded_current_iteration: undefined });
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should accept exceeded record when both exceeded fields are absent (neither field set)', () => {
      const record = makeExceededRecord({ exceeded_max_steps: undefined, exceeded_current_iteration: undefined });
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });
  });

  describe('started_at requirement', () => {
    it('should reject exceeded record without started_at (null)', () => {
      const record = makeExceededRecord({ started_at: null });
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('completed_at requirement', () => {
    it('should reject exceeded record without completed_at (null)', () => {
      const record = makeExceededRecord({ completed_at: null });
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('failure prohibition', () => {
    it('should reject exceeded record with failure field', () => {
      const record = makeExceededRecord({ failure: { error: 'something' } });
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });
  });

  describe('owner_pid prohibition', () => {
    it('should reject exceeded record with owner_pid set to a process ID', () => {
      const record = makeExceededRecord({ owner_pid: 12345 });
      expect(() => TaskRecordSchema.parse(record)).toThrow();
    });

    it('should accept exceeded record with owner_pid explicitly null', () => {
      const record = makeExceededRecord({ owner_pid: null });
      expect(() => TaskRecordSchema.parse(record)).not.toThrow();
    });
  });

  describe('independence from other statuses', () => {
    it('should not affect pending status validation', () => {
      // pending: started_at must be null
      expect(() => TaskRecordSchema.parse({
        name: 'test-task',
        status: 'pending',
        content: 'task content',
        created_at: '2025-01-01T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      })).not.toThrow();
    });

    it('should not affect failed status validation', () => {
      // failed: requires failure field
      expect(() => TaskRecordSchema.parse({
        name: 'test-task',
        status: 'failed',
        content: 'task content',
        created_at: '2025-01-01T00:00:00.000Z',
        started_at: '2025-01-01T01:00:00.000Z',
        completed_at: '2025-01-01T02:00:00.000Z',
        failure: { error: 'something went wrong' },
      })).not.toThrow();
    });
  });
});
