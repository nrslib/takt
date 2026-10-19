import { crossSpawn, guardChildProcessStreams } from '../../shared/utils/index.js';
import { pickNestedObservabilityEnv } from '../../shared/telemetry/index.js';
import type { DevinCallOptions } from './types.js';

const DEVIN_COMMAND = 'devin';
const DEVIN_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEVIN_FORCE_KILL_DELAY_MS_DEFAULT = 1_000;
const DEVIN_ENV_ALLOWLIST = [
  'ALL_PROXY',
  'APPDATA',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'Path',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'DEVIN_MODEL',
  'DEVIN_SANDBOX',
  'WINDSURF_API_KEY',
];

export type DevinExecResult = {
  stdout: string;
  stderr: string;
};

export type DevinExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

function buildEnv(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of DEVIN_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, pickNestedObservabilityEnv(childProcessEnv));
  return env;
}

function createExecError(
  message: string,
  params: {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals | null;
    name?: string;
  } = {},
): DevinExecError {
  const error = new Error(message) as DevinExecError;
  if (params.name) {
    error.name = params.name;
  }
  error.code = params.code;
  error.stdout = params.stdout;
  error.stderr = params.stderr;
  error.signal = params.signal;
  return error;
}

function buildCloseErrorMessage(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    return `devin terminated by signal ${signal}`;
  }
  if (code !== null) {
    return `devin exited with code ${code}`;
  }
  return 'devin closed without exit code or signal';
}

export function execDevin(
  args: string[],
  options: DevinCallOptions,
  stdinInput?: string,
): Promise<DevinExecResult> {
  return new Promise<DevinExecResult>((resolve, reject) => {
    const child = crossSpawn(options.devinCliPath ?? DEVIN_COMMAND, args, {
      cwd: options.cwd,
      env: buildEnv(options.childProcessEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    let childClosed = false;

    const clearTerminationTimer = (): void => {
      if (terminationTimer !== undefined) {
        clearTimeout(terminationTimer);
        terminationTimer = undefined;
      }
    };

    const scheduleForceKill = (): void => {
      if (terminationTimer === undefined) {
        terminationTimer = setTimeout(() => {
          if (!childClosed) {
            child.kill('SIGKILL');
          }
          terminationTimer = undefined;
        }, DEVIN_FORCE_KILL_DELAY_MS_DEFAULT);
        terminationTimer.unref?.();
      }
    };

    const terminateChild = (): void => {
      child.kill('SIGTERM');
      scheduleForceKill();
    };

    const abortHandler = (): void => {
      if (settled) return;
      terminateChild();
    };

    const cleanup = (): void => {
      if (childClosed) {
        clearTerminationTimer();
      }
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
      guardTeardown();
    };

    const rejectOnce = (error: DevinExecError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const rejectAfterTermination = (error: DevinExecError): void => {
      if (settled) return;
      settled = true;
      terminateChild();
      cleanup();
      reject(error);
    };

    const resolveOnce = (result: DevinExecResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const byteLength = Buffer.byteLength(text);

      if (target === 'stdout') {
        stdoutBytes += byteLength;
        if (stdoutBytes > DEVIN_MAX_BUFFER_BYTES) {
          rejectAfterTermination(createExecError('devin stdout exceeded buffer limit', {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            stdout,
            stderr,
          }));
          return;
        }
        stdout += text;
        return;
      }

      stderrBytes += byteLength;
      if (stderrBytes > DEVIN_MAX_BUFFER_BYTES) {
        rejectAfterTermination(createExecError('devin stderr exceeded buffer limit', {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout,
          stderr,
        }));
        return;
      }
      stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => appendChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', chunk));

    const guardTeardown = guardChildProcessStreams(child, (error, source) => {
      if (source === 'process') {
        rejectOnce(createExecError(error.message, {
          code: (error as NodeJS.ErrnoException).code,
          stdout,
          stderr,
        }));
        return;
      }
      rejectAfterTermination(createExecError(`devin ${source} stream error: ${error.message}`, {
        stdout,
        stderr,
      }));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      childClosed = true;
      clearTerminationTimer();
      if (settled) return;

      if (options.abortSignal?.aborted) {
        rejectOnce(createExecError('Devin execution aborted', {
          name: 'AbortError',
          stdout,
          stderr,
          signal,
        }));
        return;
      }

      if (code === 0) {
        resolveOnce({ stdout, stderr });
        return;
      }

      rejectOnce(createExecError(
        buildCloseErrorMessage(code, signal),
        {
          code: code === null ? undefined : code,
          stdout,
          stderr,
          signal,
        },
      ));
    });

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        abortHandler();
      } else {
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    if (stdinInput !== undefined) {
      child.stdin?.write(stdinInput);
    }
    child.stdin?.end();
  });
}
