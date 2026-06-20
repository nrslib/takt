import { crossSpawn } from '../../shared/utils/index.js';
import { pickNestedObservabilityEnv } from '../../shared/telemetry/index.js';
import type { KiroCallOptions } from './types.js';

const KIRO_COMMAND = 'kiro-cli';
const KIRO_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const KIRO_FORCE_KILL_DELAY_MS_DEFAULT = 1_000;
const KIRO_ENV_ALLOWLIST = [
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
  'KIRO_HOME',
];

export type KiroExecResult = {
  stdout: string;
  stderr: string;
};

export type KiroExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

function buildEnv(
  kiroApiKey: string | undefined,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KIRO_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, pickNestedObservabilityEnv(childProcessEnv));

  const resolvedKiroApiKey = kiroApiKey !== undefined ? kiroApiKey : process.env.KIRO_API_KEY;
  if (resolvedKiroApiKey !== undefined) {
    env.KIRO_API_KEY = resolvedKiroApiKey;
  }

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
): KiroExecError {
  const error = new Error(message) as KiroExecError;
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
    return `kiro-cli terminated by signal ${signal}`;
  }
  if (code !== null) {
    return `kiro-cli exited with code ${code}`;
  }
  return 'kiro-cli closed without exit code or signal';
}

export function execKiro(
  args: string[],
  options: KiroCallOptions,
): Promise<KiroExecResult> {
  return new Promise<KiroExecResult>((resolve, reject) => {
    const child = crossSpawn(options.kiroCliPath ?? KIRO_COMMAND, args, {
      cwd: options.cwd,
      env: buildEnv(options.kiroApiKey, options.childProcessEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.end();

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
        }, KIRO_FORCE_KILL_DELAY_MS_DEFAULT);
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
    };

    const rejectOnce = (error: KiroExecError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const rejectAfterTermination = (error: KiroExecError): void => {
      if (settled) return;
      terminateChild();
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (result: KiroExecResult): void => {
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
        if (stdoutBytes > KIRO_MAX_BUFFER_BYTES) {
          rejectAfterTermination(createExecError('kiro-cli stdout exceeded buffer limit', {
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
      if (stderrBytes > KIRO_MAX_BUFFER_BYTES) {
        rejectAfterTermination(createExecError('kiro-cli stderr exceeded buffer limit', {
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

    child.on('error', (error: NodeJS.ErrnoException) => {
      rejectOnce(createExecError(error.message, {
        code: error.code,
        stdout,
        stderr,
      }));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      childClosed = true;
      clearTerminationTimer();
      if (settled) return;

      if (options.abortSignal?.aborted) {
        rejectOnce(createExecError('Kiro execution aborted', {
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
  });
}
