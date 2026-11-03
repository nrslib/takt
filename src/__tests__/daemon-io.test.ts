import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncCommand } from '../infra/daemon/command.js';
import { AsyncProcess, observeProcess, readProcessOwner } from '../infra/daemon/process.js';
import { spawnManagedProcess, type ManagedProcessExit } from '../shared/utils/spawn.js';
import { readPrivateFile } from '../infra/daemon/privateFile.js';
import { deferred } from './helpers/controlledDaemon.js';

vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: vi.fn() }));
vi.mock('../infra/daemon/privateFile.js', () => ({
  readPrivateFile: vi.fn(), hasCode: (error: unknown, code: string) => error instanceof Error && 'code' in error && error.code === code,
}));
const request = { executable: '/tool', args: ['a b', '$(literal)'], cwd: '/repo', env: { LANG: 'C' }, maxOutputBytes: 8 };
function processDouble() {
  const close = deferred<ManagedProcessExit>();
  const exit = deferred<ManagedProcessExit>();
  const terminating = deferred<void>();
  const stopped = deferred<void>();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 123, stdout, stderr }) as unknown as ChildProcess;
  const terminate = vi.fn(async () => { terminating.resolve(); await stopped.promise; });
  vi.mocked(spawnManagedProcess).mockImplementation((_command, _args, _options, signal) => {
    const wait = async () => {
      const result = await close.promise;
      if (signal?.aborted) { await terminate(); throw signal.reason; }
      return result;
    };
    signal?.addEventListener('abort', () => { void terminate(); }, { once: true });
    return { child, wait, waitForExit: () => exit.promise, terminate };
  });
  return { child, close, exit, terminating, stopped, stdout, stderr, terminate };
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('bounded asynchronous commands', () => {
  it('passes argv and environment without a shell, and returns both bounded streams after close', async () => {
    const h = processDouble();
    const run = new AsyncCommand().run(request, { signal: new AbortController().signal, timeoutMs: 5000 });
    h.stdout.write('out'); h.stderr.write('err');
    h.close.resolve({ code: 7, signal: null });
    const result = await run;
    expect(Buffer.from(result.stdout).toString()).toBe('out');
    expect(Buffer.from(result.stderr).toString()).toBe('err');
    expect(result).toMatchObject({ code: 7, signal: null, truncated: false });
    expect(vi.mocked(spawnManagedProcess).mock.calls[0]?.slice(0, 3)).toEqual(['/tool', request.args,
      expect.objectContaining({ cwd: '/repo', env: { LANG: 'C' }, shell: false })]);
  });

  it('stops an overproducing command and waits for confirmed termination', async () => {
    const h = processDouble();
    const run = new AsyncCommand().run(request, { signal: new AbortController().signal, timeoutMs: 5000 });
    h.stdout.write('123456'); h.stderr.write('abcdef');
    await h.terminating.promise;
    h.close.resolve({ code: null, signal: 'SIGTERM' });
    h.stopped.resolve();
    const result = await run;
    expect(result.truncated).toBe(true);
    expect(result.stdout.byteLength + result.stderr.byteLength).toBe(8);
    expect(Buffer.from(result.stderr).toString()).toBe('ab');
  });

  it.each(['abort', 'deadline'] as const)('rejects %s only after the child has closed and termination completed', async (kind) => {
    vi.useFakeTimers();
    const h = processDouble();
    const abort = new AbortController();
    const run = new AsyncCommand().run(request, { signal: abort.signal, timeoutMs: 100 });
    let settled = false;
    const checked = run.catch((error: unknown) => { settled = true; return error; });
    if (kind === 'abort') abort.abort(new DOMException('cancel', 'AbortError'));
    else await vi.advanceTimersByTimeAsync(100);
    await h.terminating.promise;
    expect(settled).toBe(false);
    h.close.resolve({ code: null, signal: 'SIGTERM' });
    h.stopped.resolve();
    expect(await checked).toMatchObject({ name: kind === 'abort' ? 'AbortError' : 'TimeoutError' });
  });

  it('rejects invalid capacity and pre-cancellation before spawning', async () => {
    processDouble();
    await expect(new AsyncCommand().run({ ...request, maxOutputBytes: 0 }, { signal: new AbortController().signal, timeoutMs: 100 })).rejects.toThrow();
    const abort = new AbortController(); abort.abort();
    await expect(new AsyncCommand().run(request, { signal: abort.signal, timeoutMs: 100 })).rejects.toThrow();
    expect(spawnManagedProcess).not.toHaveBeenCalled();
  });
});

describe('asynchronous process identity observations', () => {
  it('distinguishes a missing PID from an unavailable inspector', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); });
    const options = { signal: new AbortController().signal, timeoutMs: 1000 };
    expect(await observeProcess({ pid: 123, startTime: 'darwin-start-v2:1' }, options)).toEqual({ kind: 'dead' });
    kill.mockReturnValue(true);
    vi.spyOn(AsyncCommand.prototype, 'run').mockRejectedValue(new Error('inspector denied'));
    vi.mocked(readPrivateFile).mockRejectedValue(new Error('inspector denied'));
    expect(await observeProcess({ pid: 123, startTime: 'darwin-start-v2:1' }, options)).toMatchObject({ kind: 'unknown' });
  });

  it('reads the existing ps identity, detects PID reuse, and preserves unknown legacy formats', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      vi.spyOn(AsyncCommand.prototype, 'run').mockResolvedValue({ code: 0, signal: null, stdout: Buffer.from('Tue Nov  3 00:00:00 2026\n'), stderr: Buffer.alloc(0), truncated: false });
      const options = { signal: new AbortController().signal, timeoutMs: 1000 };
      const current = await readProcessOwner(123, options);
      expect(current?.startTime).toMatch(/^darwin-start-v2:/);
      expect(await observeProcess(current!, options)).toEqual({ kind: 'alive', owner: current });
      expect(await observeProcess({ pid: 123, startTime: 'darwin-start-v2:1' }, options)).toEqual({ kind: 'dead' });
      expect(await observeProcess({ pid: 123, startTime: 'Tue Nov  3 00:00:00 2026' }, options)).toMatchObject({ kind: 'alive' });
      expect(await observeProcess({ pid: 123, startTime: 'old-start-time' }, options)).toMatchObject({ kind: 'unknown' });
    } finally { Object.defineProperty(process, 'platform', original); }
  });

  it('parses Linux proc identity without reading unbounded files', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    try {
      vi.mocked(readPrivateFile).mockImplementation(async (path: string) => path.includes('boot_id')
        ? Buffer.from('01234567-1234-1234-1234-0123456789ab\n')
        : Buffer.from(`123 (name with ) spaces) ${['S', ...Array<string>(18).fill('0'), '456'].join(' ')}`));
      expect(await readProcessOwner(123, { signal: new AbortController().signal, timeoutMs: 1000 }))
        .toEqual({ pid: 123, startTime: 'linux-start-v3:01234567-1234-1234-1234-0123456789ab:456' });
      expect(readPrivateFile).toHaveBeenCalledWith('/proc/123/stat', 16 * 1024);
    } finally { Object.defineProperty(process, 'platform', original); }
  });

  it('launches a process with a verified owner and keeps cancellation attached to its lifetime', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    try {
      const h = processDouble();
      vi.mocked(readPrivateFile).mockImplementation(async (path: string) => path.includes('boot_id')
        ? Buffer.from('01234567-1234-1234-1234-0123456789ab')
        : Buffer.from(`123 (node) ${['S', ...Array<string>(18).fill('0'), '456'].join(' ')}`));
      const abort = new AbortController();
      const launched = new AsyncProcess().launch(request, { signal: abort.signal, timeoutMs: 1000 });
      h.child.emit('spawn');
      const owner = await launched;
      expect(owner.owner).toEqual({ pid: 123, startTime: 'linux-start-v3:01234567-1234-1234-1234-0123456789ab:456' });
      abort.abort();
      await h.terminating.promise;
      h.stopped.resolve();
      h.close.resolve({ code: null, signal: 'SIGTERM' });
      await expect(owner.process.wait()).rejects.toThrow();
    } finally { Object.defineProperty(process, 'platform', original); }
  });

  it('confirms termination before rejecting a failed process launch', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    try {
      const h = processDouble();
      vi.mocked(readPrivateFile).mockResolvedValue(undefined);
      const launched = new AsyncProcess().launch(request, { signal: new AbortController().signal, timeoutMs: 1000 });
      const rejected = expect(launched).rejects.toThrow();
      h.child.emit('spawn');
      await h.terminating.promise;
      h.stopped.resolve();
      h.close.resolve({ code: null, signal: 'SIGTERM' });
      await rejected;
    } finally { Object.defineProperty(process, 'platform', original); }
  });

  it('propagates pre-cancellation rather than reporting a dead process', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(observeProcess({ pid: 123, startTime: 'time' }, { signal: abort.signal, timeoutMs: 1000 })).rejects.toThrow();
  });
});
