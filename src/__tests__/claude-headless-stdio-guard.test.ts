import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { runHeadlessCli } from '../infra/claude-headless/headless-spawn.js';
import type { ClaudeHeadlessCallOptions } from '../infra/claude-headless/types.js';

function stubSpawn(opts: {
  stdoutError?: Error;
  stderrError?: Error;
  stdinError?: Error;
  closeCode?: number | null;
}): void {
  vi.mocked(spawn).mockImplementation(() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
    proc.stdout = stdout as NodeJS.ReadableStream;
    proc.stderr = stderr as NodeJS.ReadableStream;
    proc.stdin = new EventEmitter() as NodeJS.WritableStream;
    proc.kill = vi.fn() as unknown as ChildProcess['kill'];

    queueMicrotask(() => {
      if (opts.stdinError) {
        (proc.stdin as EventEmitter).emit('error', opts.stdinError);
      }
      if (opts.stdoutError) {
        stdout.emit('error', opts.stdoutError);
      }
      if (opts.stderrError) {
        stderr.emit('error', opts.stderrError);
      }
      proc.emit('close', opts.closeCode ?? 1, null);
    });

    return proc as ChildProcess;
  });
}

describe('runHeadlessCli stdio guard', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('rejects with a failure without crashing the parent process when stdout emits a stream error', async () => {
    stubSpawn({
      stdoutError: new Error('stdout pipe closed'),
      closeCode: null,
    });

    const options: ClaudeHeadlessCallOptions = { cwd: '/tmp' };

    await expect(runHeadlessCli(['-p', '--', 'prompt'], options)).rejects.toThrow(
      /stdout stream error: stdout pipe closed/u,
    );
  });

  it('rejects with a failure when stderr emits a stream error', async () => {
    stubSpawn({
      stderrError: new Error('stderr pipe closed'),
      closeCode: 1,
    });

    const options: ClaudeHeadlessCallOptions = { cwd: '/tmp' };

    await expect(runHeadlessCli(['-p', '--', 'prompt'], options)).rejects.toThrow(
      /stderr stream error: stderr pipe closed/u,
    );
  });

  it('rejects with a failure when stdin emits a stream error', async () => {
    stubSpawn({
      stdinError: new Error('stdin pipe closed'),
      closeCode: 1,
    });

    const options: ClaudeHeadlessCallOptions = { cwd: '/tmp' };

    await expect(runHeadlessCli(['-p', '--', 'prompt'], options)).rejects.toThrow(
      /stdin stream error: stdin pipe closed/u,
    );
  });
});
