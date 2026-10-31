import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { suppressMergeDrivers } from '../infra/task/git-merge-environment.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('suppressMergeDrivers', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('disables configured drivers while retaining existing Git safety settings', () => {
    vi.mocked(execFileSync).mockReturnValue('merge.audit.driver\0merge.audit.driver\0merge.other.driver\0');
    const environment = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' };
    expect(suppressMergeDrivers('/clone', environment)).toEqual({ ...environment,
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_1: 'merge.audit.driver', GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'merge.other.driver', GIT_CONFIG_VALUE_2: 'false' });
    expect(environment.GIT_CONFIG_COUNT).toBe('1');
  });

  it.each(['empty', 'no matches'])('preserves the environment when config reports %s', (result) => {
    if (result === 'empty') vi.mocked(execFileSync).mockReturnValue('');
    else vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error(), { status: 1 }); });
    expect(suppressMergeDrivers('/clone', { PATH: '/bin' })).toEqual({ PATH: '/bin' });
  });

  it('propagates configuration failures instead of enabling drivers', () => {
    const error = Object.assign(new Error('invalid Git config'), { status: 128 });
    vi.mocked(execFileSync).mockImplementation(() => { throw error; });
    expect(() => suppressMergeDrivers('/clone', {})).toThrow(error);
  });
});
