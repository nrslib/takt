import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockUnref, mockCheckForUpdates } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockUnref: vi.fn(),
  mockCheckForUpdates: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock('../shared/utils/updateNotifier.js', () => ({
  checkForUpdates: () => mockCheckForUpdates(),
}));

function createWorkerDouble(): EventEmitter & { unref: () => void } {
  return Object.assign(new EventEmitter(), { unref: mockUnref });
}

function writeUpdateCache(configHome: string, latest: string): void {
  const dir = join(configHome, 'configstore');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'update-notifier-takt.json'),
    JSON.stringify({ update: { latest, current: '0.0.1' } }),
  );
}

describe('CLI update check', () => {
  const originalArgv = [...process.argv];
  const originalIsTTY = process.stdout.isTTY;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const originalNoUpdateNotifier = process.env.NO_UPDATE_NOTIFIER;
  let configHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NO_UPDATE_NOTIFIER;
    mockSpawn.mockImplementation(() => createWorkerDouble());
    configHome = mkdtempSync(join(tmpdir(), 'takt-update-check-'));
    process.env.XDG_CONFIG_HOME = configHome;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalNoUpdateNotifier === undefined) {
      delete process.env.NO_UPDATE_NOTIFIER;
    } else {
      process.env.NO_UPDATE_NOTIFIER = originalNoUpdateNotifier;
    }
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    });
    rmSync(configHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should refresh the cache in a silent detached worker', async () => {
    process.argv = ['node', 'takt', '--help'];
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await runUpdateCheck('1.0.0');

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/shared\/utils\/updateNotifierWorker\.js$/)],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('should preserve the update-notifier opt-out argument in the worker', async () => {
    process.argv = ['node', 'takt', '--no-update-notifier'];
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await runUpdateCheck('1.0.0');

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/shared\/utils\/updateNotifierWorker\.js$/), '--no-update-notifier'],
      expect.any(Object),
    );
  });

  it('should notify a cached pending update from the parent process', async () => {
    process.argv = ['node', 'takt', 'list'];
    writeUpdateCache(configHome, '99.0.0');
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await runUpdateCheck('1.0.0');

    expect(mockCheckForUpdates).toHaveBeenCalledTimes(1);
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('should not notify when the cached version equals the current version', async () => {
    process.argv = ['node', 'takt', 'list'];
    writeUpdateCache(configHome, '1.0.0');
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await runUpdateCheck('1.0.0');

    expect(mockCheckForUpdates).not.toHaveBeenCalled();
  });

  it('should not notify when there is no cached update', async () => {
    process.argv = ['node', 'takt', 'list'];
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await runUpdateCheck('1.0.0');

    expect(mockCheckForUpdates).not.toHaveBeenCalled();
  });

  it('should not notify when the CLI output is not a terminal', async () => {
    process.argv = ['node', 'takt', 'list'];
    writeUpdateCache(configHome, '99.0.0');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await runUpdateCheck('1.0.0');

    expect(mockCheckForUpdates).not.toHaveBeenCalled();
  });

  it('should not notify when the update notifier is opted out', async () => {
    process.argv = ['node', 'takt', 'list', '--no-update-notifier'];
    writeUpdateCache(configHome, '99.0.0');
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await runUpdateCheck('1.0.0');

    expect(mockCheckForUpdates).not.toHaveBeenCalled();
  });

  it('should log a warning and still start the worker when the notification throws', async () => {
    process.argv = ['node', 'takt', 'list'];
    writeUpdateCache(configHome, '99.0.0');
    mockCheckForUpdates.mockImplementation(() => {
      throw new Error('corrupt update cache');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await expect(runUpdateCheck('1.0.0')).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('update check skipped (corrupt update cache)'),
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });

  it('should log a sanitized warning and keep the CLI alive when the worker fails to spawn', async () => {
    process.argv = ['node', 'takt', '--version'];
    const worker = createWorkerDouble();
    mockSpawn.mockImplementation(() => worker);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runUpdateCheck } = await import('../app/cli/updateCheck.js');

    await runUpdateCheck('1.0.0');
    // Without an 'error' listener this emit would throw as an unhandled
    // 'error' event and crash the CLI process.
    expect(() =>
      worker.emit('error', new Error('spawn \u001B]0;evil\u0007/bin\u009Bnode EAGAIN')),
    ).not.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = consoleErrorSpy.mock.calls[0]?.[0] as string;
    expect(logged).toContain('update check skipped');
    expect(logged).not.toMatch(/[\u001B\u0007\u009B]/);
    expect(mockUnref).toHaveBeenCalledTimes(1);
  });
});
