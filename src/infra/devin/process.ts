import type { ChildProcess } from 'node:child_process';
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

export type DevinExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

export interface DevinProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface DevinAcpProcess {
  readonly child: ChildProcess;
  /**
   * Settles when the child exits. Resolves with the exit info on `close`;
   * rejects when spawning the process or one of its stdio streams fails.
   */
  readonly exited: Promise<DevinProcessExit>;
  stderrText(): string;
  stderrOverflowed(): boolean;
  terminate(): void;
}

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

export function createExecError(
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

export function buildCloseErrorMessage(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) {
    return `devin terminated by signal ${signal}`;
  }
  if (code !== null) {
    return `devin exited with code ${code}`;
  }
  return 'devin closed without exit code or signal';
}

// `devin acp` keeps stdout for JSON-RPC protocol frames and stderr for
// diagnostics. Stderr is still collected with the same bound as print mode so
// a chatty process cannot exhaust memory; stdout needs no byte bound here
// because the SDK consumes it incrementally and rejects oversized frames.
export function spawnDevinAcp(args: string[], options: DevinCallOptions): DevinAcpProcess {
  const child = crossSpawn(options.devinCliPath ?? DEVIN_COMMAND, args, {
    cwd: options.cwd,
    env: buildEnv(options.childProcessEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stderrBytes = 0;
  let stderrOverflowed = false;
  let childClosed = false;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;

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

  const terminate = (): void => {
    if (!childClosed) {
      child.kill('SIGTERM');
      scheduleForceKill();
    }
  };

  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    stderrBytes += Buffer.byteLength(text);
    if (stderrBytes > DEVIN_MAX_BUFFER_BYTES) {
      stderrOverflowed = true;
      terminate();
      return;
    }
    stderr += text;
  });

  const exited = new Promise<DevinProcessExit>((resolve, reject) => {
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      childClosed = true;
      clearTerminationTimer();
      resolve({ code, signal });
    });

    guardChildProcessStreams(child, (error, source) => {
      if (source === 'process') {
        reject(createExecError(error.message, {
          code: (error as NodeJS.ErrnoException).code,
          stderr,
        }));
        return;
      }
      reject(createExecError(`devin ${source} stream error: ${error.message}`, { stderr }));
      terminate();
    });
  });
  // The caller always races `exited`, but a late rejection after the turn has
  // already settled must not surface as an unhandled rejection.
  exited.catch(() => {});

  return {
    child,
    exited,
    stderrText: () => stderr,
    stderrOverflowed: () => stderrOverflowed,
    terminate,
  };
}
