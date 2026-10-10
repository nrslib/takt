import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { inspect } = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: inspect,
}));

beforeEach(() => {
  vi.resetModules();
  inspect.mockReset().mockReturnValue('Mon Oct  5 12:00:00 2026\n');
  vi.stubGlobal('process', { ...process, platform: 'linux' });
  vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ordinary task owner process identity', () => {
  it('normalizes the inspector locale and timezone', async () => {
    const { getTaskProcessIdentity } = await import('../infra/task/taskProcessIdentity.js');
    expect(getTaskProcessIdentity(12345)).toEqual({ startTime: 'Mon Oct  5 12:00:00 2026' });
    expect(inspect).toHaveBeenCalledWith('ps', ['-o', 'lstart=', '-p', '12345'],
      expect.objectContaining({
        shell: false, timeout: 1_000,
        env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }),
      }));
  });

  it('keeps the existing central lock inspector and its cache separate', async () => {
    inspect.mockReturnValueOnce('existing lock identity').mockReturnValueOnce('task identity');
    const { getSelfProcessIdentity } = await import('../infra/task/process.js');
    const { getSelfTaskProcessIdentity } = await import('../infra/task/taskProcessIdentity.js');
    expect(getSelfProcessIdentity()).toEqual({ startTime: 'existing lock identity' });
    expect(getSelfTaskProcessIdentity()).toEqual({ startTime: 'task identity' });
    expect(getSelfProcessIdentity()).toEqual({ startTime: 'existing lock identity' });
    expect(getSelfTaskProcessIdentity()).toEqual({ startTime: 'task identity' });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect.mock.calls[0]?.[2].env).toBeUndefined();
  });

  it('preserves a live owner with the same recorded birth time', async () => {
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'Mon Oct  5 12:00:00 2026')).toBe(false);
  });

  it('recovers an interrupted task when the live PID has a different birth time', async () => {
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'Thu Jan  1 00:00:00 1970')).toBe(true);
  });

  it('preserves a live legacy owner without a recorded identity', async () => {
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(['empty', 'error'])('preserves a live owner when inspection returns %s', async (result) => {
    if (result === 'empty') inspect.mockReturnValue('');
    else inspect.mockImplementation(() => { throw new Error('ps unavailable'); });
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'stored birth')).toBe(false);
  });

  it('preserves a live owner on an unsupported platform', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'stored birth')).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('recovers a dead owner without inspecting its birth time', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    });
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(12345, 'stored birth')).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('recovers an owner with no PID', async () => {
    const { isStaleRunningTask } = await import('../infra/task/process.js');
    expect(isStaleRunningTask(undefined, 'stored birth')).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid inspector PID %s', async (pid) => {
    const { getTaskProcessIdentity } = await import('../infra/task/taskProcessIdentity.js');
    expect(getTaskProcessIdentity(pid)).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });
});
