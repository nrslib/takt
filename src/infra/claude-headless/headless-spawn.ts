import { spawn } from 'node:child_process';

import { tryExtractTextFromStreamJsonLine, tryExtractThinkingFromStreamJsonLine } from './stream-json-lines.js';
import type { ClaudeHeadlessCallOptions } from './types.js';

const HEADLESS_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const HEADLESS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const HEADLESS_ABORTED_MESSAGE = 'Claude CLI execution aborted';
const CLAUDE_COMMAND = 'claude';

function buildHeadlessEnv(options: ClaudeHeadlessCallOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = options.anthropicApiKey;
  }
  return env;
}

export type ExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

function createExecError(
  message: string,
  params: {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals | null;
    name?: string;
  } = {},
): ExecError {
  const error = new Error(message) as ExecError;
  if (params.name) {
    error.name = params.name;
  }
  error.code = params.code;
  error.stdout = params.stdout;
  error.stderr = params.stderr;
  error.signal = params.signal;
  return error;
}

export function runHeadlessCli(
  args: string[],
  options: ClaudeHeadlessCallOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const executable = options.claudeCliPath ?? CLAUDE_COMMAND;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: buildHeadlessEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const clearIdle = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const scheduleIdle = (): void => {
      clearIdle();
      idleTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        child.kill('SIGTERM');
        rejectOnce(
          createExecError('Claude CLI stream idle timeout: no output within time limit', {
            stdout,
            stderr,
          }),
        );
      }, HEADLESS_STREAM_IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    const abortHandler = (): void => {
      if (settled) {
        return;
      }
      child.kill('SIGTERM');
    };

    const cleanup = (): void => {
      clearIdle();
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
    };

    const resolveOnce = (result: { stdout: string; stderr: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: ExecError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const byteLength = Buffer.byteLength(text);

      if (target === 'stdout') {
        stdoutBytes += byteLength;
        if (stdoutBytes > HEADLESS_MAX_BUFFER_BYTES) {
          child.kill('SIGTERM');
          rejectOnce(
            createExecError('Claude CLI stdout exceeded buffer limit', {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
              stdout,
              stderr,
            }),
          );
          return;
        }
        stdout += text;
        scheduleIdle();
        return;
      }

      stderrBytes += byteLength;
      if (stderrBytes > HEADLESS_MAX_BUFFER_BYTES) {
        child.kill('SIGTERM');
        rejectOnce(
          createExecError('Claude CLI stderr exceeded buffer limit', {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            stdout,
            stderr,
          }),
        );
        return;
      }
      stderr += text;
    };

    let lineBuffer = '';

    const flushLines = (final = false): void => {
      const parts = lineBuffer.split('\n');
      lineBuffer = final ? '' : (parts.pop() ?? '');
      if (!options.onStream) return;

      for (const line of parts) {
        const thinking = tryExtractThinkingFromStreamJsonLine(line);
        if (thinking) {
          options.onStream({ type: 'thinking', data: { thinking } });
          continue;
        }
        const text = tryExtractTextFromStreamJsonLine(line);
        if (text) {
          options.onStream({ type: 'text', data: { text } });
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      appendChunk('stdout', chunk);
      lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      flushLines(false);
    });

    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      rejectOnce(
        createExecError(error.message, {
          code: error.code,
          stdout,
          stderr,
        }),
      );
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }

      flushLines(true);

      if (options.abortSignal?.aborted) {
        rejectOnce(
          createExecError(HEADLESS_ABORTED_MESSAGE, {
            name: 'AbortError',
            stdout,
            stderr,
            signal,
          }),
        );
        return;
      }

      if (code === 0) {
        resolveOnce({ stdout, stderr });
        return;
      }

      const message = signal
        ? `Claude CLI terminated by signal ${signal}`
        : code === null
          ? 'Claude CLI exited without an exit code'
          : `Claude CLI exited with code ${code}`;

      rejectOnce(
        createExecError(message, {
          code: code ?? undefined,
          stdout,
          stderr,
          signal,
        }),
      );
    });

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        abortHandler();
      } else {
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    scheduleIdle();
  });
}
