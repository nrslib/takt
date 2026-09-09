import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openLiveRunDirectory } from '../features/tasks/list/liveInterventionOpen.js';

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function createChildProcessDouble(): EventEmitter & { readonly unref: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & { readonly unref: ReturnType<typeof vi.fn> };
  Object.defineProperty(child, 'unref', { value: vi.fn() });
  return child;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe('live intervention run-directory opener', () => {
  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
    ['win32', 'explorer.exe'],
  ] as const)('passes the validated directory to the host opener on %s', async (platform, command) => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const directory = '/project/.takt/worktrees/live-task/.takt/runs/live-run';

    await openLiveRunDirectory({
      platform,
      directory,
      execute,
    });

    expect(execute).toHaveBeenCalledWith(command, [directory]);
  });

  it('rejects an unsupported host without invoking a process', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    await expect(openLiveRunDirectory({
      platform: 'freebsd' as NodeJS.Platform,
      directory: '/project/.takt/worktrees/live-task/.takt/runs/live-run',
      execute,
    })).rejects.toThrow(/unsupported|platform/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolves the default opener only after the child emits spawn', async () => {
    const child = createChildProcessDouble();
    mockSpawn.mockReturnValue(child);
    const opening = openLiveRunDirectory({
      platform: 'linux',
      directory: '/project/.takt/worktrees/live-task/.takt/runs/live-run',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      'xdg-open',
      ['/project/.takt/worktrees/live-task/.takt/runs/live-run'],
      { detached: true, stdio: 'ignore' },
    );
    expect(child.unref).toHaveBeenCalledOnce();

    child.emit('spawn');

    await expect(opening).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('rejects an asynchronous default opener error instead of reporting success', async () => {
    const child = createChildProcessDouble();
    mockSpawn.mockReturnValue(child);
    const opening = openLiveRunDirectory({
      platform: 'linux',
      directory: '/project/.takt/worktrees/live-task/.takt/runs/live-run',
    });
    const error = new Error('xdg-open failed');

    child.emit('error', error);

    await expect(opening).rejects.toBe(error);
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
