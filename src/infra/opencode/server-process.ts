import type { ChildProcess } from 'node:child_process';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';
import { getErrorMessage } from '../../shared/utils/error.js';
import { crossSpawn } from '../../shared/utils/spawn.js';

const OPENCODE_SERVER_HOSTNAME = '127.0.0.1';

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
    child.kill();
  } catch {
    // The child can exit between the state check and kill call.
  }
}

function formatServerExitError(output: string, code: number | null, signal: NodeJS.Signals | null): Error {
  const cause = code === null ? String(signal) : String(code);
  const detail = output.trim() === '' ? '' : `\nServer output: ${output}`;
  return new Error(`OpenCode server exited with code ${cause}${detail}`);
}

function formatStreamError(stream: string, error: unknown): Error {
  return new Error(`OpenCode server ${stream} stream failed: ${getErrorMessage(error)}`);
}

export async function startOpenCodeServer(
  options: OpenCodeServerStartOptions,
): Promise<OpenCodeServerProcess> {
  const child = crossSpawn(
    'opencode',
    ['serve', `--hostname=${OPENCODE_SERVER_HOSTNAME}`, `--port=${options.port}`],
    {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
      },
    },
  );

  let output = '';
  let started = false;
  let closing = false;
  let runtimeError: Error | undefined;
  const errorListeners = new Set<ServerErrorListener>();
  let failStartup: ((error: Error) => void) | undefined;

  const notifyRuntimeError = (error: Error): void => {
    if (runtimeError !== undefined || closing) return;
    runtimeError = error;
    for (const listener of errorListeners) listener(error);
  };

  const onChildStreamError = (stream: string) => (error: unknown): void => {
    const streamError = formatStreamError(stream, error);
    if (started) notifyRuntimeError(streamError);
    else failStartup?.(streamError);
  };

  child.stdin?.on('error', onChildStreamError('stdin'));
  child.stdout?.on('error', onChildStreamError('stdout'));
  child.stderr?.on('error', onChildStreamError('stderr'));

  const url = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      const error = new Error(`Timeout waiting for OpenCode server to start after ${options.timeoutMs}ms`);
      fail(error);
    }, options.timeoutMs);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      closing = true;
      stopChild(child);
      reject(error);
    };
    failStartup = fail;

    child.on('error', (error) => {
      if (started) notifyRuntimeError(formatStreamError('process', error));
      else fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('exit', (code, signal) => {
      if (started) {
        if (!closing) notifyRuntimeError(formatServerExitError(output, code, signal));
        return;
      }
      fail(formatServerExitError(output, code, signal));
    });

    const onOutput = (chunk: Buffer | string): void => {
      if (started || settled) return;
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (!line.startsWith('opencode server listening')) continue;
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
        clearTimeout(timeoutId);
        resolve(serverUrl);
        return;
      }
    };

    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);
  });

  failStartup = undefined;

  try {
    const client = createOpencodeClient({ baseUrl: url });
    return {
      client,
      close: () => {
        if (closing) return;
        closing = true;
        errorListeners.clear();
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
    stopChild(child);
    throw error;
  }
}
