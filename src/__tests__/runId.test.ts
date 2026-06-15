import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRunId } from '../shared/utils/runId.js';

describe('generateRunId', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should generate unique ids for repeated calls in the same millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:39:44.123Z'));

    const first = generateRunId();
    const second = generateRunId();

    expect(first).toMatch(/^run-\d{8}-\d{6}-\d{3}-\d{3}$/);
    expect(second).toMatch(/^run-\d{8}-\d{6}-\d{3}-\d{3}$/);
    expect(second).not.toBe(first);
  });
});
