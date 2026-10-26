import { spawn } from 'node:child_process';
import { truncateUtf8 } from './utf8.js';

export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const OUTPUT_LIMIT_MARKER = `[OUTPUT TRUNCATED: exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes]`;
const COMMAND_ENV_ALLOWLIST = [
  'PATH', 'Path', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
];

export function buildCommandEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMMAND_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export interface BoundedCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  error?: Error;
}

export function runBoundedCommand(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<BoundedCommandResult> {
  return new Promise((resolve) => {
    const result: BoundedCommandResult = {
      exitCode: null, stdout: '', stderr: '', timedOut: false,
      aborted: options.signal?.aborted === true, outputLimitExceeded: false,
    };
    if (result.aborted) {
      resolve(result);
      return;
    }
    const child = spawn(options.command, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
    });
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    function appendOutput(stream: 'stdout' | 'stderr', chunk: string): void {
      if (settled || result.outputLimitExceeded) return;
      const remaining = MAX_COMMAND_OUTPUT_BYTES - outputBytes;
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (chunkBytes <= remaining) {
        result[stream] += chunk;
        outputBytes += chunkBytes;
      } else {
        const bounded = truncateUtf8(chunk, remaining);
        result[stream] += `${bounded.value}\n${OUTPUT_LIMIT_MARKER}`;
        outputBytes += bounded.bytes;
        // Capture is bounded without changing a verbose command's exit status.
        // Callers decide whether excess output constitutes a failure.
        result.outputLimitExceeded = true;
      }
    }
    const onStdout = (chunk: string) => appendOutput('stdout', chunk);
    const onStderr = (chunk: string) => appendOutput('stderr', chunk);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    function settle(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      clearTimeout(settleTimer);
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    }

    function kill(signal: NodeJS.Signals): boolean {
      if (child.pid === undefined) return true;
      try {
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        const message = error instanceof Error ? error.message : String(error);
        result.error = new Error(`Failed to kill command: ${message}`);
        result.stderr += `${result.stderr ? '\n' : ''}${result.error.message}`;
        return false;
      }
    }

    function terminate(): void {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(timeout);
      if (child.pid === undefined) {
        settle();
        return;
      }
      kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (!kill('SIGKILL')) {
          settle();
          return;
        }
        settleTimer = setTimeout(settle, 1000);
        settleTimer.unref?.();
      }, 100);
      forceKillTimer.unref?.();
    }

    function onAbort(): void {
      result.aborted = true;
      terminate();
    }
    const timeout = setTimeout(() => {
      result.timedOut = true;
      terminate();
    }, options.timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      result.error = error;
      result.stderr ||= error.message;
      settle();
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      result.exitCode = code;
      settle();
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
