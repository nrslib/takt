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

    expect(first).toMatch(/^run-\d{8}-\d{6}-\d{3}-\d{3}-[a-f0-9]{8}$/);
    expect(second).toMatch(/^run-\d{8}-\d{6}-\d{3}-\d{3}-[a-f0-9]{8}$/);
    expect(second).not.toBe(first);
  });

  it('should avoid collisions when module-local state starts from the same sequence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:39:44.123Z'));

    vi.resetModules();
    const firstModule = await import('../shared/utils/runId.js');
    const first = firstModule.generateRunId();

    vi.resetModules();
    vi.setSystemTime(new Date('2026-06-15T14:39:44.123Z'));
    const secondModule = await import('../shared/utils/runId.js');
    const second = secondModule.generateRunId();

    expect(first).toMatch(/^run-20260615-\d{6}-123-000-[a-f0-9]{8}$/);
    expect(second).toMatch(/^run-20260615-\d{6}-123-000-[a-f0-9]{8}$/);
    expect(second).not.toBe(first);
  });
});
