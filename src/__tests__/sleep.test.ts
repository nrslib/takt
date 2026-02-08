import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';

// Mock modules before importing the module under test
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:os', () => ({
  platform: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// Mock the debug logger
vi.mock('../shared/utils/debug.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  }),
}));

// Import after mocks are set up
const { spawn } = await import('node:child_process');
const { platform } = await import('node:os');
const { existsSync } = await import('node:fs');
const { preventSleep, resetPreventSleepState } = await import('../shared/utils/sleep.js');

describe('preventSleep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPreventSleepState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should do nothing on non-darwin platforms', () => {
    vi.mocked(platform).mockReturnValue('linux');

    preventSleep();

    expect(spawn).not.toHaveBeenCalled();
  });

  it('should do nothing on Windows', () => {
    vi.mocked(platform).mockReturnValue('win32');

    preventSleep();

    expect(spawn).not.toHaveBeenCalled();
  });

  it('should spawn caffeinate on macOS when available', () => {
    vi.mocked(platform).mockReturnValue('darwin');
    vi.mocked(existsSync).mockReturnValue(true);

    const mockChild = {
      unref: vi.fn(),
      pid: 12345,
    } as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(mockChild);

    preventSleep();

    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/caffeinate',
      ['-di', '-w', String(process.pid)],
      { stdio: 'ignore', detached: true }
    );
    expect(mockChild.unref).toHaveBeenCalled();
  });

  it('should not spawn caffeinate if not found', () => {
    vi.mocked(platform).mockReturnValue('darwin');
    vi.mocked(existsSync).mockReturnValue(false);

    preventSleep();

    expect(spawn).not.toHaveBeenCalled();
  });

  it('should check for caffeinate at /usr/bin/caffeinate', () => {
    vi.mocked(platform).mockReturnValue('darwin');
    vi.mocked(existsSync).mockReturnValue(false);

    preventSleep();

    expect(existsSync).toHaveBeenCalledWith('/usr/bin/caffeinate');
  });

  it('should only spawn caffeinate once even when called multiple times', () => {
    vi.mocked(platform).mockReturnValue('darwin');
    vi.mocked(existsSync).mockReturnValue(true);

    const mockChild = {
      unref: vi.fn(),
      pid: 12345,
    } as unknown as ChildProcess;
    vi.mocked(spawn).mockReturnValue(mockChild);

    preventSleep();
    preventSleep();
    preventSleep();

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
