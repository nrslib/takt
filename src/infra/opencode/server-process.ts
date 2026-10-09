import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { crossSpawn } from '../../shared/utils/spawn.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';
import type { OpenCodeRuntime } from './runtime.js';
import type { OpenCodeTransport } from './transport.js';
import { createV2Transport } from './v2-transport.js';
import { createV1Transport } from './v1-transport.js';

const OPENCODE_SERVER_HOSTNAME = '127.0.0.1';
const CHILD_TERMINATION_GRACE_MS = 500;

export interface OpenCodeServerStartOptions {
  runtime: OpenCodeRuntime;
  port: number;
  timeoutMs: number;
  config: Record<string, unknown>;
  mcpServerNames?: readonly string[];
}

export interface OpenCodeServerProcess {
  client: OpenCodeTransport;
  close: () => Promise<void>;
  onError: (listener: (error: Error) => void) => () => void;
}

type ServerErrorListener = (error: Error) => void;

class OpenCodeServerStopError extends Error {
  constructor(cause: unknown) {
    super('Failed to terminate the OpenCode server process', { cause });
    this.name = 'OpenCodeServerStopError';
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || childHasExited(child)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    const timers: { kill?: NodeJS.Timeout; exitConfirmation?: NodeJS.Timeout } = {};

    const cleanup = (): void => {
      if (timers.kill !== undefined) clearTimeout(timers.kill);
      if (timers.exitConfirmation !== undefined) clearTimeout(timers.exitConfirmation);
      child.removeListener('exit', onExit);
    };

    const onExit = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const failToKill = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OpenCodeServerStopError(cause));
    };

    const confirmExitSoon = (cause: unknown, remainingChecks = 2): void => {
      if (childHasExited(child)) {
        onExit();
        return;
      }
      // Allow two timer phases for the child-process exit event to update state before failing.
      timers.exitConfirmation = setTimeout(() => {
        timers.exitConfirmation = undefined;
        if (childHasExited(child)) onExit();
        else if (remainingChecks > 1) confirmExitSoon(cause, remainingChecks - 1);
        else failToKill(cause);
      }, 0);
    };

    child.once('exit', onExit);
    if (childHasExited(child)) {
      onExit();
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // The child may exit between the state check and kill call.
    }

    if (childHasExited(child)) {
      onExit();
      return;
    }

    const killTimer = setTimeout(() => {
      if (childHasExited(child)) {
        onExit();
        return;
      }
      try {
        if (!child.kill('SIGKILL')) {
          const cause = new Error(`SIGKILL was not sent to OpenCode server process ${child.pid}`);
          if (childHasExited(child)) onExit();
          else confirmExitSoon(cause);
        }
      } catch (error) {
        if (childHasExited(child)) onExit();
        else confirmExitSoon(error);
      }
    }, CHILD_TERMINATION_GRACE_MS);
    timers.kill = killTimer;
    killTimer.unref();
  });
}

function formatServerExitError(output: string, code: number | null, signal: NodeJS.Signals | null): Error {
  const cause = code === null ? String(signal) : String(code);
  const detail = output.trim() === '' ? '' : `\nServer output: ${sanitizeSensitiveText(output)}`;
  return new Error(`OpenCode server exited with code ${cause}${detail}`);
}

function formatStreamError(stream: string, error: unknown): Error {
  return new Error(`OpenCode server ${stream} stream failed: ${sanitizeSensitiveText(getErrorMessage(error))}`);
}

export async function startOpenCodeServer(
  options: OpenCodeServerStartOptions,
): Promise<OpenCodeServerProcess> {
  const password = options.runtime.generation === 'v2' ? randomBytes(32).toString('base64url') : undefined;
  const child = crossSpawn(
    options.runtime.command,
    ['serve', `--hostname=${OPENCODE_SERVER_HOSTNAME}`, `--port=${options.port}`],
    {
      env: {
        ...buildChildProcessEnv(),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
        ...(password === undefined ? {} : { OPENCODE_PASSWORD: password }),
      },
    },
  );

  let output = '';
  const OUTPUT_TAIL_MAX_CHARS = 2000;
  const appendOutput = (text: string): void => {
    output = (output + text).slice(-OUTPUT_TAIL_MAX_CHARS);
  };
  let started = false;
  let closing = false;
  let runtimeError: Error | undefined;
  const errorListeners = new Set<ServerErrorListener>();
  let removeProcessListeners: () => void = () => {};

  const notifyRuntimeError = (error: Error): void => {
    if (runtimeError !== undefined || closing) return;
    runtimeError = error;
    for (const listener of errorListeners) listener(error);
  };

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdoutLineBuffer = '';
    let stderrLineBuffer = '';
    let removeStartupDataListeners: () => void = () => {};

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      closing = true;
      removeProcessListeners();
      void stopChild(child).then(
        () => reject(error),
        (stopError: unknown) => reject(new AggregateError(
          [error, stopError],
          'OpenCode server startup failed and the child process could not be stopped',
        )),
      );
    };

    const onChildStreamError = (stream: string) => (error: unknown): void => {
      const streamError = formatStreamError(stream, error);
      if (started) notifyRuntimeError(streamError);
      else fail(streamError);
    };

    const onStdinError = onChildStreamError('stdin');
    const onStdoutError = onChildStreamError('stdout');
    const onStderrError = onChildStreamError('stderr');

    const processOutputLine = (line: string): void => {
      const prefix = options.runtime.generation === 'v2' ? 'server listening' : 'opencode server listening';
      if (started || settled || !line.startsWith(prefix)) return;
      const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
      if (!match) {
        fail(new Error(`Failed to parse server url from output: ${line}`));
        return;
      }
      const serverUrl = match[1];
      if (serverUrl === undefined) {
        fail(new Error(`Failed to parse server url from output: ${line}`));
        return;
      }
      started = true;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      resolve(serverUrl);
    };

    const onOutput = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string): void => {
      const text = chunk.toString();
      appendOutput(text);
      if (started || settled) return;
      const buffered = stream === 'stdout' ? stdoutLineBuffer + text : stderrLineBuffer + text;
      const lines = buffered.split('\n');
      const incompleteLine = lines.pop() ?? '';
      if (stream === 'stdout') stdoutLineBuffer = incompleteLine;
      else stderrLineBuffer = incompleteLine;
      for (const line of lines) {
        processOutputLine(line);
        if (started || settled) return;
      }
    };

    const onStdoutData = onOutput('stdout');
    const onStderrData = onOutput('stderr');
    const onChildError = (error: unknown): void => {
      if (started) {
        notifyRuntimeError(formatStreamError('process', error));
        closing = true;
        removeProcessListeners();
        return;
      }
      fail(error instanceof Error ? error : new Error(String(error)));
    };
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (started) {
        if (!closing) {
          notifyRuntimeError(formatServerExitError(output, code, signal));
          closing = true;
        }
        removeProcessListeners();
        return;
      }
      fail(formatServerExitError(output, code, signal));
    };

    removeStartupDataListeners = (): void => {
      child.stdout?.removeListener('data', onStdoutData);
      child.stderr?.removeListener('data', onStderrData);
    };
    removeProcessListeners = (): void => {
      removeStartupDataListeners();
      child.stdin?.removeListener('error', onStdinError);
      child.stdout?.removeListener('error', onStdoutError);
      child.stderr?.removeListener('error', onStderrError);
      child.removeListener('error', onChildError);
      child.removeListener('exit', onChildExit);
    };

    const timeoutId = setTimeout(() => {
      fail(new Error(`Timeout waiting for OpenCode server to start after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdin?.on('error', onStdinError);
    child.stdout?.on('error', onStdoutError);
    child.stderr?.on('error', onStderrError);
    child.on('error', onChildError);
    child.on('exit', onChildExit);
    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);
  });

  try {
    const client = password === undefined ? createV1Transport(url) : createV2Transport(url, password, options.mcpServerNames);
    let closePromise: Promise<void> | undefined;
    return {
      client,
      close: () => {
        if (closePromise !== undefined) return closePromise;
        closing = true;
        errorListeners.clear();
        removeProcessListeners();
        closePromise = stopChild(child);
        return closePromise;
      },
      onError: (listener) => {
        if (runtimeError !== undefined) {
          listener(runtimeError);
          return () => {};
        }
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
    };
  } catch (error) {
    closing = true;
    errorListeners.clear();
    removeProcessListeners();
    try {
      await stopChild(child);
    } catch (stopError) {
      throw new AggregateError(
        [error, stopError],
        'OpenCode server transport creation failed and the child process could not be stopped',
      );
    }
    throw error;
  }
}
