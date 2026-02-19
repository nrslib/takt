/**
 * Unit tests for report directory name generation
 *
 * Tests timestamp formatting and task summary slugification.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateReportDir } from '../shared/utils/reportDir.js';

describe('generateReportDir', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should generate directory name with timestamp and task summary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T10:30:45.000Z'));

    const result = generateReportDir('Add login feature');
    expect(result).toBe('20250115-103045-add-login-feature');

    vi.useRealTimers();
  });

  it('should truncate long task descriptions to 30 characters', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const longTask = 'This is a very long task description that should be truncated';
    const result = generateReportDir(longTask);
    // Timestamp is fixed, summary is truncated from first 30 chars
    expect(result).toMatch(/^20250101-000000-/);
    // The slug part should be derived from the first 30 chars
    const slug = result.replace(/^20250101-000000-/, '');
    expect(slug.length).toBeLessThanOrEqual(30);

    vi.useRealTimers();
  });

  it('should strip CJK characters from summary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-01T12:00:00.000Z'));

    const result = generateReportDir('タスク指示書の実装');
    // CJK characters are removed by slugify, leaving empty → falls back to 'task'
    expect(result).toBe('20250601-120000-task');

    vi.useRealTimers();
  });

  it('should replace special characters with hyphens', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const result = generateReportDir('Fix: bug (#42)');
    const slug = result.replace(/^20250101-000000-/, '');
    expect(slug).not.toMatch(/[^a-z0-9-]/);

    vi.useRealTimers();
  });

  it('should default to "task" when summary is empty after cleanup', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const result = generateReportDir('!@#$%^&*()');
    expect(result).toBe('20250101-000000-task');

    vi.useRealTimers();
  });
});
