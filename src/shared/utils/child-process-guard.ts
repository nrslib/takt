/**
 * Guards a spawned child process and its stdio streams against unhandled
 * 'error' events. Attaches a single 'error' listener to the process and to
 * each present stdio stream (stdin/stdout/stderr), forwarding every emitted
 * error to the supplied callback along with the stream that produced it.
 *
 * The helper does not terminate the process; routing the error to the
 * caller's existing failure path is the callback's responsibility.
 *
 * Returns a teardown function that removes every listener it registered. The
 * teardown function is idempotent and safe to call multiple times.
 */

import type { ChildProcess } from 'node:child_process';

export type ChildProcessStreamSource = 'process' | 'stdin' | 'stdout' | 'stderr';

type ChildProcessStreamErrorHandler = (error: Error, source: ChildProcessStreamSource) => void;

type RegisteredListener = {
  emitter: NodeJS.EventEmitter;
  handler: (error: Error) => void;
};

export function guardChildProcessStreams(
  child: ChildProcess,
  onError: ChildProcessStreamErrorHandler,
): () => void {
  let tornDown = false;

  const listeners: RegisteredListener[] = [];

  const register = (
    emitter: NodeJS.EventEmitter | null | undefined,
    source: ChildProcessStreamSource,
  ): void => {
    if (emitter === null || emitter === undefined) {
      return;
    }
    const handler = (error: Error): void => {
      onError(error, source);
    };
    emitter.on('error', handler);
    listeners.push({ emitter, handler });
  };

  register(child, 'process');
  register(child.stdin, 'stdin');
  register(child.stdout, 'stdout');
  register(child.stderr, 'stderr');

  return function teardown(): void {
    if (tornDown) {
      return;
    }
    tornDown = true;
    for (const { emitter, handler } of listeners) {
      emitter.removeListener('error', handler);
    }
    listeners.length = 0;
  };
}
