import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawnSync, mockWriteSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
  mockWriteSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawnSync: mockSpawnSync }));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  writeSync: mockWriteSync,
}));

import { checkForUpdates } from '../shared/utils/index.js';

describe('checkForUpdates', () => {
  const originalArgv = [...process.argv];
  let exitListeners: ReturnType<typeof process.rawListeners>;
  let originalExitListeners: Array<(code: number) => void>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitListeners = process.rawListeners('exit');
    originalExitListeners = process.listeners('exit');
    mockSpawnSync.mockReturnValue({ status: 0, signal: null, stderr: 'update notification\n' });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    for (const listener of process.listeners('exit')) {
      if (!originalExitListeners.includes(listener)) process.removeListener('exit', listener);
    }
  });

  it('should bound the notification worker while preserving its terminal output', () => {
    process.argv = ['node', 'takt'];
    expect(checkForUpdates()).toBeUndefined();
    expect(mockSpawnSync).toHaveBeenCalledWith(process.execPath,
      [expect.stringMatching(/shared\/utils\/updateNotifierWorker\.js$/)], {
        stdio: ['ignore', 'inherit', 'pipe'],
        encoding: 'utf8',
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      });
  });

  it('should transfer a notification only once at parent exit', () => {
    checkForUpdates();
    expect(mockWriteSync).not.toHaveBeenCalled();
    const listener = process.rawListeners('exit').find((candidate) => !exitListeners.includes(candidate));
    expect(listener).toBeDefined();
    listener!(0);
    expect(mockWriteSync).toHaveBeenCalledExactlyOnceWith(2, 'update notification\n');
    expect(process.rawListeners('exit')).toEqual(exitListeners);
  });

  it('should not register an exit notification for empty worker output', () => {
    mockSpawnSync.mockReturnValue({ status: 0, signal: null, stderr: '' });
    checkForUpdates();
    expect(process.rawListeners('exit')).toEqual(exitListeners);
    expect(mockWriteSync).not.toHaveBeenCalled();
  });

  it('should propagate the opt-out argument to the notification worker', () => {
    process.argv = ['node', 'takt', '--no-update-notifier'];
    checkForUpdates();
    expect(mockSpawnSync.mock.calls[0]?.[1]).toEqual([
      expect.stringMatching(/updateNotifierWorker\.js$/), '--no-update-notifier',
    ]);
  });

  it.each(['EAGAIN', 'ETIMEDOUT', 'ENOBUFS'])('should propagate %s without scheduling partial output', (code) => {
    const failure = Object.assign(new Error(code), { code });
    mockSpawnSync.mockReturnValue({ status: null, signal: 'SIGKILL', stderr: 'partial', error: failure });
    expect(() => checkForUpdates()).toThrow(failure);
    expect(process.rawListeners('exit')).toEqual(exitListeners);
  });

  it.each([
    { status: 1, signal: null },
    { status: null, signal: 'SIGTERM' },
  ])('should reject an unsuccessful worker exit: %j', (result) => {
    mockSpawnSync.mockReturnValue({ ...result, stderr: 'worker failed' });
    expect(() => checkForUpdates()).toThrow();
    expect(process.rawListeners('exit')).toEqual(exitListeners);
  });
});
