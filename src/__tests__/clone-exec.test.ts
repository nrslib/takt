import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { runGitCommandAbortable } from '../infra/task/clone-exec.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

class FakeChildProcess extends EventEmitter {
  readonly pid = 4321;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('terminates a Git process group when its command timeout expires', async () => {
  vi.useFakeTimers();
  const child = new FakeChildProcess();
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const killProcessGroup = vi.spyOn(process, 'kill').mockReturnValue(true);
  const timeoutMs = 25;
  const pending = runGitCommandAbortable('/project', ['ls-remote'], undefined, {}, timeoutMs);
  const rejection = expect(pending).rejects.toThrow(`git ls-remote timed out after ${timeoutMs} ms`);

  await vi.advanceTimersByTimeAsync(timeoutMs);
  await rejection;
  expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGTERM');

  await vi.advanceTimersByTimeAsync(500);
  expect(killProcessGroup).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
});
