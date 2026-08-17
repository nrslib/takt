import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { guardChildProcessStreams } from '../shared/utils/child-process-guard.js';

function makeFakeChild(): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  proc.stdin = new EventEmitter() as NodeJS.ReadableStream;
  proc.stdout = new EventEmitter() as NodeJS.ReadableStream;
  proc.stderr = new EventEmitter() as NodeJS.ReadableStream;
  return proc as ChildProcess;
}

describe('guardChildProcessStreams', () => {
  it('forwards process errors with the process source', () => {
    const child = makeFakeChild();
    const onError = vi.fn();
    const teardown = guardChildProcessStreams(child, onError);

    const error = new Error('spawn failed');
    child.emit('error', error);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, 'process');
    teardown();
  });

  it('forwards stdout stream errors with the stdout source', () => {
    const child = makeFakeChild();
    const onError = vi.fn();
    const teardown = guardChildProcessStreams(child, onError);

    const error = new Error('stdout broke');
    (child.stdout as EventEmitter).emit('error', error);

    expect(onError).toHaveBeenCalledWith(error, 'stdout');
    teardown();
  });

  it('forwards stderr stream errors with the stderr source', () => {
    const child = makeFakeChild();
    const onError = vi.fn();
    const teardown = guardChildProcessStreams(child, onError);

    const error = new Error('stderr broke');
    (child.stderr as EventEmitter).emit('error', error);

    expect(onError).toHaveBeenCalledWith(error, 'stderr');
    teardown();
  });

  it('forwards stdin stream errors with the stdin source', () => {
    const child = makeFakeChild();
    const onError = vi.fn();
    const teardown = guardChildProcessStreams(child, onError);

    const error = new Error('stdin broke');
    (child.stdin as EventEmitter).emit('error', error);

    expect(onError).toHaveBeenCalledWith(error, 'stdin');
    teardown();
  });

  it('does not register listeners for missing stdio streams', () => {
    const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
    proc.stdin = null;
    proc.stdout = null;
    proc.stderr = null;
    const child = proc as ChildProcess;

    const onError = vi.fn();
    const teardown = guardChildProcessStreams(child, onError);

    child.emit('error', new Error('only process'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error), 'process');
    teardown();
  });

  it('stops forwarding errors after teardown', () => {
    const child = makeFakeChild();
    const onError = vi.fn();
    const teardown = guardChildProcessStreams(child, onError);

    // Add a no-op 'error' listener so bare EventEmitter does not throw when
    // we emit 'error' with no other listener present after teardown.
    child.on('error', () => undefined);
    (child.stdout as EventEmitter).on('error', () => undefined);
    (child.stderr as EventEmitter).on('error', () => undefined);
    (child.stdin as EventEmitter).on('error', () => undefined);

    teardown();
    expect(() => {
      child.emit('error', new Error('after teardown'));
      (child.stdout as EventEmitter).emit('error', new Error('stdout after teardown'));
      (child.stderr as EventEmitter).emit('error', new Error('stderr after teardown'));
      (child.stdin as EventEmitter).emit('error', new Error('stdin after teardown'));
    }).not.toThrow();

    expect(onError).not.toHaveBeenCalled();
  });

  it('is safe to call teardown multiple times', () => {
    const child = makeFakeChild();
    const onError = vi.fn();
    const teardown = guardChildProcessStreams(child, onError);

    expect(() => {
      teardown();
      teardown();
      teardown();
    }).not.toThrow();
  });
});
