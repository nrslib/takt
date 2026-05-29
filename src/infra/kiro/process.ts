import { crossSpawn } from '../../shared/utils/index.js';
import type { KiroCallOptions } from './types.js';

const KIRO_COMMAND = 'kiro-cli';
const KIRO_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const KIRO_FORCE_KILL_DELAY_MS_DEFAULT = 1_000;
const KIRO_ENV_ALLOWLIST = [
  'APPDATA',
  'HOME',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'PATH',
  'Path',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
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

function buildEnv(kiroApiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of KIRO_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (kiroApiKey !== undefined) {
    env.KIRO_API_KEY = kiroApiKey;
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
      env: buildEnv(options.kiroApiKey),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;

    const abortHandler = (): void => {
      if (settled) return;
      child.kill('SIGTERM');
      abortTimer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, KIRO_FORCE_KILL_DELAY_MS_DEFAULT);
      abortTimer.unref?.();
    };

    const cleanup = (): void => {
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
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
          child.kill('SIGTERM');
          rejectOnce(createExecError('kiro-cli stdout exceeded buffer limit', {
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
        child.kill('SIGTERM');
        rejectOnce(createExecError('kiro-cli stderr exceeded buffer limit', {
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
