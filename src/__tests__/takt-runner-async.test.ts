import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTaktAsync, type TaktRunOptions } from '../../e2e/helpers/takt-runner.js';

type Completion = (error: ExecFileException | null, stdout: string, stderr: string) => void;

const { execFileMock, execFileSyncMock, endMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<(
    file: string,
    args: string[],
    options: ExecFileOptionsWithStringEncoding,
    callback: Completion,
  ) => { stdin: { end: (input?: string) => void } }>(),
  execFileSyncMock: vi.fn(),
  endMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

describe('runTaktAsync', () => {
  const options: TaktRunOptions = {
    args: ['run'],
    cwd: '/test/project',
    env: { TAKT_CONFIG_DIR: '/test/config', NODE_OPTIONS: '--require=preload.cjs' },
  };
  let complete: Completion;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('TAKT_E2E_PROVIDER', 'mock');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      complete = callback;
      return { stdin: { end: endMock } };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a pending promise without synchronous execution and completes with child output', async () => {
    const pending = runTaktAsync(options);
    const settled = vi.fn();
    void pending.then(settled);
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(endMock).toHaveBeenCalledWith(undefined);

    complete(null, 'completed\n', 'diagnostic\n');
    await expect(pending).resolves.toEqual({
      stdout: 'completed\n', stderr: 'diagnostic\n', exitCode: 0,
    });
  });

  it('passes arguments, environment, input, timeout and buffer limit to the child', async () => {
    const pending = runTaktAsync({ ...options, input: 'n\n', timeout: 240_000 });
    expect(execFileMock).toHaveBeenCalledWith('node', [
      fileURLToPath(new URL('../../bin/takt', import.meta.url)), '--provider', 'mock', 'run',
    ], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf-8',
      timeout: 240_000,
      maxBuffer: 10 * 1024 * 1024,
    }, expect.any(Function));
    expect(endMock).toHaveBeenCalledExactlyOnceWith('n\n');
    complete(null, '', '');
    await pending;
  });

  it.each([
    { args: ['--provider', 'codex', 'run'], injectProvider: true, expected: ['--provider', 'codex', 'run'] },
    { args: ['run'], injectProvider: false, expected: ['run'] },
  ])('preserves provider selection for $expected', async ({ args, injectProvider, expected }) => {
    const pending = runTaktAsync({ ...options, args, injectProvider });
    expect(execFileMock.mock.calls[0]?.[1].slice(1)).toEqual(expected);
    expect(execFileMock.mock.calls[0]?.[2].timeout).toBe(180_000);
    complete(null, '', '');
    await pending;
  });

  it('returns a nonzero exit and both output streams without retrying ordinary failures', async () => {
    const pending = runTaktAsync(options);
    complete(Object.assign(new Error('command failed'), { code: 23 }), 'partial', 'failed');
    await expect(pending).resolves.toEqual({ stdout: 'partial', stderr: 'failed', exitCode: 23 });
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it('returns a failed result when the child cannot start', async () => {
    const pending = runTaktAsync(options);
    complete(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }), '', '');
    await expect(pending).resolves.toEqual({ stdout: '', stderr: '', exitCode: 1 });
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('rejects a child terminated by %s without retrying', async (signal) => {
    const pending = runTaktAsync(options);
    const rejected = expect(pending).rejects.toThrow('timed out');
    complete(Object.assign(new Error('terminated'), { signal }), '', 'Reconnecting...');
    await rejected;
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['stream disconnected before completion', ''],
    ['', 'Reconnecting...'],
    ['', 'error sending request for url (https://chatgpt.com/backend-api/codex/responses)'],
  ])('retries a transient provider failure and waits for the retry callback', async (stdout, stderr) => {
    const pending = runTaktAsync(options);
    complete(Object.assign(new Error('provider failed'), { code: 1 }), stdout, stderr);
    await Promise.resolve();
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[1]?.slice(0, 3)).toEqual(execFileMock.mock.calls[0]?.slice(0, 3));
    complete(null, 'recovered', '');
    await expect(pending).resolves.toEqual({ stdout: 'recovered', stderr: '', exitCode: 0 });
  });

  it('stops after four transient retries and preserves the last failure', async () => {
    const pending = runTaktAsync(options);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(execFileMock).toHaveBeenCalledTimes(attempt + 1);
      complete(Object.assign(new Error('provider failed'), { code: 23 }), String(attempt), 'Reconnecting...');
      await Promise.resolve();
    }
    await expect(pending).resolves.toEqual({ stdout: '4', stderr: 'Reconnecting...', exitCode: 23 });
    expect(execFileMock).toHaveBeenCalledTimes(5);
    expect(endMock).toHaveBeenCalledTimes(5);
  });
});
