import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isProcessAlive, isStaleRunningTask } from '../infra/task/process.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('process alive utility', () => {
  it('returns true when process id exists', () => {
    const mockKill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = isProcessAlive(process.pid);

    expect(mockKill).toHaveBeenCalledWith(process.pid, 0);
    expect(result).toBe(true);
  });

  it('returns false when process does not exist', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('No such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    });

    expect(isProcessAlive(99999)).toBe(false);
  });

  it('treats permission errors as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });

    expect(isProcessAlive(99999)).toBe(true);
  });

  it('throws for unexpected process errors', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('Unknown') as NodeJS.ErrnoException;
      error.code = 'EINVAL';
      throw error;
    });

    expect(() => isProcessAlive(99999)).toThrow('Unknown');
  });

  it('returns true when stale check receives a live process id', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    expect(isStaleRunningTask(process.pid)).toBe(false);
  });

  it('returns true when stale check has no process id', () => {
    expect(isStaleRunningTask(undefined)).toBe(true);
  });
});
