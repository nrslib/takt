import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureDaemon, stopDaemon } from '../features/daemon/lifecycle.js';
import type { DaemonOwner } from '../infra/daemon/owner.js';
import { packageVersion } from '../shared/package-info.js';

const doubles = vi.hoisted(() => ({
  read: vi.fn(), running: vi.fn(), remove: vi.fn(), spawn: vi.fn(),
  open: vi.fn(), close: vi.fn(), delay: vi.fn(), directory: vi.fn(),
}));
vi.mock('../infra/daemon/owner.js', () => ({
  readDaemonOwner: doubles.read, isDaemonOwnerRunning: doubles.running, removeDaemonOwner: doubles.remove,
}));
vi.mock('node:child_process', () => ({ spawn: doubles.spawn }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), openSync: doubles.open, closeSync: doubles.close }));
vi.mock('node:timers/promises', () => ({ setTimeout: doubles.delay }));
vi.mock('../shared/utils/private-file.js', () => ({ ensurePrivateDirectory: doubles.directory }));
vi.mock('../shared/utils/cli-invocation.js', () => ({ resolveCliInvocation: () => ({ cliPath: '/test/cli.js', args: ['/test/cli.js', 'daemon'] }) }));

const owner: DaemonOwner = {
  pid: 4321, identity: { startTime: 'darwin-start-v2:12345' }, version: packageVersion, cliPath: '/test/cli.js',
};
afterEach(() => { vi.restoreAllMocks(); });
let child: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; unref: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  doubles.read.mockReset().mockReturnValue(undefined);
  doubles.running.mockReset().mockReturnValue(true);
  doubles.open.mockReturnValue(42);
  doubles.delay.mockReset().mockResolvedValue(undefined);
  child = Object.assign(new EventEmitter(), { pid: owner.pid, exitCode: null, signalCode: null, unref: vi.fn() });
  doubles.spawn.mockReset().mockImplementation(() => {
    queueMicrotask(() => { doubles.read.mockReturnValue(owner); child.emit('spawn'); });
    return child;
  });
});

it('reuses the running daemon with the current version and CLI path', async () => {
  doubles.read.mockReturnValue(owner);
  await ensureDaemon();
  expect(doubles.spawn).not.toHaveBeenCalled();
});

it('starts detached and confirms its own owner record before returning', async () => {
  let recorded = false;
  doubles.read.mockImplementation(() => recorded ? owner : undefined);
  doubles.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  doubles.delay.mockImplementation(async () => { recorded = true; });
  await ensureDaemon();
  expect(doubles.spawn).toHaveBeenCalledWith(process.execPath, ['/test/cli.js', 'daemon'], {
    cwd: process.env.TAKT_CONFIG_DIR,
    detached: true, shell: false, stdio: ['ignore', 42, 42],
    env: expect.objectContaining({ TAKT_CONFIG_DIR: process.env.TAKT_CONFIG_DIR }),
  });
  expect(doubles.delay).toHaveBeenCalled();
  expect(doubles.running).toHaveBeenCalledWith(owner);
  expect(child.unref).toHaveBeenCalledOnce();
  expect(doubles.close).toHaveBeenCalledWith(42);
});

it.each([{ version: 'old-version' }, { cliPath: '/old/cli.js' }])('stops the old daemon before replacing a differing owner: %j', async (difference) => {
  const old = { ...owner, ...difference, pid: 1234 };
  doubles.read.mockReturnValue(old);
  let oldRunning = true;
  doubles.running.mockImplementation((candidate: DaemonOwner) => candidate.pid !== old.pid || oldRunning);
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { oldRunning = false; return true; });
  await ensureDaemon();
  expect(kill).toHaveBeenCalledExactlyOnceWith(old.pid, 'SIGTERM');
  expect(kill.mock.invocationCallOrder[0]).toBeLessThan(doubles.spawn.mock.invocationCallOrder[0]!);
  expect(doubles.remove).toHaveBeenCalledWith(process.env.TAKT_CONFIG_DIR, old.pid);
  expect(doubles.spawn).toHaveBeenCalledOnce();
});

it('waits for process exit before removing the stopped owner record', async () => {
  doubles.read.mockReturnValue(owner);
  doubles.running.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  doubles.delay.mockImplementation(async () => { expect(doubles.remove).not.toHaveBeenCalled(); });
  await stopDaemon();
  expect(kill).toHaveBeenCalledExactlyOnceWith(owner.pid, 'SIGTERM');
  expect(doubles.delay).toHaveBeenCalledOnce();
  expect(doubles.remove).toHaveBeenCalledOnce();
});

it('does not signal an absent or dead owner', async () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await stopDaemon();
  expect(doubles.remove).not.toHaveBeenCalled();
  doubles.read.mockReturnValue(owner);
  doubles.running.mockReturnValue(false);
  await stopDaemon();
  expect(kill).not.toHaveBeenCalled();
  expect(doubles.remove).toHaveBeenCalledOnce();
});

it('propagates spawn failure and closes the log descriptor', async () => {
  const failure = new Error('spawn failed');
  doubles.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('error', failure));
    return child;
  });
  await expect(ensureDaemon()).rejects.toBe(failure);
  expect(doubles.close).toHaveBeenCalledWith(42);
});

it('rejects startup when the child exits without an owner record', async () => {
  doubles.spawn.mockImplementation(() => {
    queueMicrotask(() => { child.exitCode = 1; child.emit('spawn'); });
    return child;
  });
  await expect(ensureDaemon()).rejects.toThrow();
  expect(doubles.close).toHaveBeenCalledWith(42);
});

it.each(['start', 'stop'] as const)('keeps waiting bounded when %s cannot be confirmed', async (operation) => {
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  doubles.delay.mockImplementation(async (ms: number) => { now += ms; });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  if (operation === 'start') {
    doubles.spawn.mockImplementation(() => { queueMicrotask(() => child.emit('spawn')); return child; });
    await expect(ensureDaemon()).rejects.toThrow();
    expect(doubles.close).toHaveBeenCalledWith(42);
  } else {
    doubles.read.mockReturnValue(owner);
    await expect(stopDaemon()).rejects.toThrow();
    expect(kill).toHaveBeenCalledOnce();
    expect(doubles.remove).not.toHaveBeenCalled();
  }
  expect(now).toBe(5_000);
});
