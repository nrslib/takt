import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { runHeadlessCli } from '../infra/claude-headless/headless-spawn.js';
import type { ClaudeHeadlessCallOptions } from '../infra/claude-headless/types.js';
import type { StreamEvent } from '../shared/types/provider.js';

const TEXT_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hello' }] },
});

type FakeChild = EventEmitter & Partial<ChildProcess>;

function stubSpawn(): { proc: FakeChild; stdout: PassThrough } {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as FakeChild;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = null;
  proc.kill = vi.fn(() => true) as unknown as ChildProcess['kill'];

  vi.mocked(spawn).mockImplementation(() => proc as ChildProcess);

  return { proc, stdout };
}

describe('runHeadlessCli onStream failure', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('rejects with the thrown error and terminates the child when onStream throws on a stdout chunk', async () => {
    const { proc, stdout } = stubSpawn();
    const failure = new Error('onStream exploded');
    const onStream = vi.fn((_event: StreamEvent) => {
      throw failure;
    });
    const options: ClaudeHeadlessCallOptions = { cwd: '/tmp', onStream };

    const promise = runHeadlessCli(['-p', '--', 'prompt'], options);
    stdout.write(`${TEXT_LINE}\n`);

    // The child never closes here: the rejection must come from the throw itself.
    await expect(promise).rejects.toBe(failure);
    expect(onStream).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not call onStream for stdout that arrives after the call has been rejected', async () => {
    const { proc, stdout } = stubSpawn();
    const failure = new Error('onStream exploded');
    const onStream = vi.fn((_event: StreamEvent) => {
      throw failure;
    });
    const options: ClaudeHeadlessCallOptions = { cwd: '/tmp', onStream };

    const promise = runHeadlessCli(['-p', '--', 'prompt'], options);
    stdout.write(`${TEXT_LINE}\n`);
    await expect(promise).rejects.toBe(failure);

    // The stdout listener stays attached until the child closes, so this late
    // chunk still reaches flushLines after the rejection.
    stdout.write(`${TEXT_LINE}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    proc.emit('close', null, 'SIGTERM');

    expect(onStream).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toBe(failure);
  });

  it('wraps a non-Error throwable into an Error', async () => {
    const { proc, stdout } = stubSpawn();
    const options: ClaudeHeadlessCallOptions = {
      cwd: '/tmp',
      onStream: () => {
        throw 'string failure';
      },
    };

    const promise = runHeadlessCli(['-p', '--', 'prompt'], options);
    stdout.write(`${TEXT_LINE}\n`);

    await expect(promise).rejects.toThrow('string failure');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects when onStream throws during the final flush on close', async () => {
    const { proc, stdout } = stubSpawn();
    const failure = new Error('onStream exploded on final flush');
    const onStream = vi.fn((_event: StreamEvent) => {
      throw failure;
    });
    const options: ClaudeHeadlessCallOptions = { cwd: '/tmp', onStream };

    const promise = runHeadlessCli(['-p', '--', 'prompt'], options);
    // No trailing newline: the line stays buffered until the close handler flushes it.
    stdout.write(TEXT_LINE);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onStream).not.toHaveBeenCalled();

    proc.emit('close', 0, null);

    await expect(promise).rejects.toBe(failure);
    expect(onStream).toHaveBeenCalledTimes(1);
  });

  it('resolves normally and forwards events when onStream does not throw', async () => {
    const { proc, stdout } = stubSpawn();
    const events: StreamEvent[] = [];
    const options: ClaudeHeadlessCallOptions = {
      cwd: '/tmp',
      onStream: (event) => {
        events.push(event);
      },
    };

    const promise = runHeadlessCli(['-p', '--', 'prompt'], options);
    stdout.write(`${TEXT_LINE}\n`);
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });

    proc.emit('close', 0, null);

    await expect(promise).resolves.toEqual({ stdout: `${TEXT_LINE}\n`, stderr: '' });
    expect(events).toEqual([{ type: 'text', data: { text: 'hello' } }]);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
