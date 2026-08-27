import type { ChildProcess } from 'node:child_process';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';
import { getErrorMessage } from '../../shared/utils/error.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { crossSpawn } from '../../shared/utils/spawn.js';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';

const OPENCODE_SERVER_HOSTNAME = '127.0.0.1';
const CHILD_TERMINATION_GRACE_MS = 500;

export interface OpenCodeServerStartOptions {
  port: number;
  timeoutMs: number;
  config: Record<string, unknown>;
}

export interface OpenCodeServerProcess {
  client: OpencodeClient;
  close: () => void;
  onError: (listener: (error: Error) => void) => () => void;
}

type ServerErrorListener = (error: Error) => void;

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (!child.kill('SIGTERM')) return;
  } catch {
    // The child can exit between the state check and kill call.
    return;
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // The child can exit between the state check and kill call.
    }
  }, CHILD_TERMINATION_GRACE_MS);
  killTimer.unref();
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
  const child = crossSpawn(
    'opencode',
    ['serve', `--hostname=${OPENCODE_SERVER_HOSTNAME}`, `--port=${options.port}`],
    {
      env: {
        ...buildChildProcessEnv(),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
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
      stopChild(child);
      reject(error);
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
      if (started || settled || !line.startsWith('opencode server listening')) return;
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
    const client = createOpencodeClient({ baseUrl: url });
    return {
      client,
      close: () => {
        if (closing) return;
        closing = true;
        errorListeners.clear();
        removeProcessListeners();
        stopChild(child);
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
    stopChild(child);
    throw error;
  }
}
