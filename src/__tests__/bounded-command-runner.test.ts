import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { buildCommandEnv, runBoundedCommand } from '../shared/utils/bounded-command-runner.js';

const doubles = vi.hoisted(() => ({
  spawn: vi.fn(),
  crossSpawn: vi.fn(),
  resolveSystem32ExecutablePath: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: doubles.spawn }));
vi.mock('cross-spawn', () => ({ default: doubles.crossSpawn }));
vi.mock('../shared/utils/executable-path.js', () => ({
  resolveSystem32ExecutablePath: doubles.resolveSystem32ExecutablePath,
}));

const originalPlatform = process.platform;

describe('bounded command runner', () => {
  let child: ReturnType<typeof createChild>;
  function createChild() {
    return Object.assign(new EventEmitter(), {
      pid: 190501, stdout: new PassThrough(), stderr: new PassThrough(),
    });
  }
  const options = { command: ' fixed command ', cwd: '/task', timeoutMs: 1000, env: {} };
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    child = createChild();
    doubles.spawn.mockReset().mockReturnValue(child);
    doubles.crossSpawn.mockReset();
    doubles.resolveSystem32ExecutablePath.mockReset();
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    child.stdout.destroy();
    child.stderr.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('copies only the base command environment allowlist', () => {
    expect(buildCommandEnv({ PATH: '/bin', TMPDIR: '/tmp', SECRET: 'private', OTEL_HEADERS: 'secret' }))
      .toEqual({ PATH: '/bin', TMPDIR: '/tmp' });
  });

  it('keeps the fixed command and captures both streams and a nonzero exit', async () => {
    const running = runBoundedCommand(options);
    expect(doubles.spawn).toHaveBeenCalledWith(options.command, {
      cwd: '/task', env: {}, shell: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.write('out');
    child.stderr.write('err');
    child.emit('close', 3);
    expect(await running).toEqual({
      exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false,
      aborted: false, outputLimitExceeded: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([65536, 65537])('bounds combined capture at %s bytes without changing the exit status', async (bytes) => {
    const running = runBoundedCommand(options);
    child.stdout.write('x'.repeat(32768));
    child.stderr.write('y'.repeat(bytes - 32768));
    child.emit('close', 0);
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.outputLimitExceeded).toBe(bytes > 65536);
    expect(result.stdout).toBe('x'.repeat(32768));
    expect(result.stderr).toBe(bytes === 65536
      ? 'y'.repeat(32768)
      : 'y'.repeat(32768) + '\n[OUTPUT TRUNCATED: exceeded 65536 bytes]');
  });

  it('retains complete UTF-8 characters when the byte limit splits a character', async () => {
    const running = runBoundedCommand(options);
    child.stdout.write('x'.repeat(65535) + '界');
    child.emit('close', 0);
    expect(await running).toMatchObject({
      stdout: 'x'.repeat(65535) + '\n[OUTPUT TRUNCATED: exceeded 65536 bytes]',
      outputLimitExceeded: true,
    });
  });

  it.each(['throw', 'event'])('reports a spawn %s and clears timers and the abort listener', async (failure) => {
    const signal = new AbortController();
    const remove = vi.spyOn(signal.signal, 'removeEventListener');
    const error = new Error('spawn unavailable');
    if (failure === 'throw') doubles.spawn.mockImplementationOnce(() => { throw error; });
    const running = runBoundedCommand({ ...options, signal: signal.signal });
    if (failure === 'throw') {
      await expect(running).rejects.toBe(error);
    } else {
      child.emit('error', error);
      expect(await running).toMatchObject({ error, exitCode: null, timedOut: false });
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not spawn when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runBoundedCommand({ ...options, signal: controller.signal })).toMatchObject({ aborted: true });
    expect(doubles.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'abort'])('sends TERM then KILL for %s and cleans up after close', async (reason) => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const running = runBoundedCommand({ ...options, signal: controller.signal });
    if (reason === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(1000);
    const pid = process.platform === 'win32' ? child.pid : -child.pid;
    expect(process.kill).toHaveBeenCalledWith(pid, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    expect(process.kill).toHaveBeenCalledWith(pid, 'SIGKILL');
    child.emit('close', null);
    expect(await running).toMatchObject({
      exitCode: null, timedOut: reason === 'timeout', aborted: reason === 'abort',
    });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'abort'])('kills the Windows process tree and waits for taskkill after %s', async (reason) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    const killer = new EventEmitter();
    const taskkillPath = 'C:\\Windows\\System32\\taskkill.exe';
    doubles.resolveSystem32ExecutablePath.mockReturnValue(taskkillPath);
    doubles.crossSpawn.mockReturnValue(killer);
    const controller = new AbortController();
    let settled = false;
    const running = runBoundedCommand({ ...options, signal: controller.signal }).then((result) => {
      settled = true;
      return result;
    });

    if (reason === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(1000);

    expect(doubles.resolveSystem32ExecutablePath).toHaveBeenCalledWith('taskkill.exe');
    expect(doubles.crossSpawn).toHaveBeenCalledWith(taskkillPath, [
      '/pid', String(child.pid), '/T', '/F',
    ], { stdio: 'ignore', windowsHide: true });
    expect(process.kill).not.toHaveBeenCalled();

    child.emit('close', null);
    await Promise.resolve();
    expect(settled).toBe(false);

    killer.emit('close', 0, null);
    expect(await running).toMatchObject({
      exitCode: null, timedOut: reason === 'timeout', aborted: reason === 'abort',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still sends KILL when the command leader closes after TERM', async () => {
    let settled = false;
    const running = runBoundedCommand(options).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(1000);
    child.emit('close', null);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(process.kill).toHaveBeenLastCalledWith(
      process.platform === 'win32' ? child.pid : -child.pid,
      'SIGKILL',
    );
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toMatchObject({ timedOut: true, exitCode: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps termination timers referenced when the command leader closes after TERM', async () => {
    vi.useRealTimers();
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const running = runBoundedCommand({ ...options, timeoutMs: 1 });

    await new Promise((resolve) => realSetTimeout(resolve, 10));
    const forceKillTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 100);
    expect(forceKillTimerIndex).toBeGreaterThanOrEqual(0);
    const forceKillTimer = setTimeoutSpy.mock.results[forceKillTimerIndex]?.value as NodeJS.Timeout;
    expect(forceKillTimer.hasRef()).toBe(true);

    child.emit('close', null);
    await new Promise((resolve) => realSetTimeout(resolve, 110));
    expect(process.kill).toHaveBeenLastCalledWith(
      process.platform === 'win32' ? child.pid : -child.pid,
      'SIGKILL',
    );

    const settleTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1000);
    expect(settleTimerIndex).toBeGreaterThanOrEqual(0);
    const settleTimer = setTimeoutSpy.mock.results[settleTimerIndex]?.value as NodeJS.Timeout;
    expect(settleTimer.hasRef()).toBe(true);

    child.emit('close', null);
    expect(await running).toMatchObject({ timedOut: true, exitCode: null });
  });

  it('settles after SIGKILL when close never arrives and destroys the output streams', async () => {
    let settled = false;
    const running = runBoundedCommand(options).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(process.kill).toHaveBeenLastCalledWith(
      process.platform === 'win32' ? child.pid : -child.pid,
      'SIGKILL',
    );
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await running).toMatchObject({ timedOut: true, exitCode: null });
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes cancellation after successful close', async () => {
    const controller = new AbortController();
    const running = runBoundedCommand({ ...options, signal: controller.signal });
    child.emit('close', 0);
    await running;
    controller.abort();
    expect(process.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
