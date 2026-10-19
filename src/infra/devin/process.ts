import { execFileSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger, getErrorMessage, guardChildProcessStreams, spawnManagedProcess } from '../../shared/utils/index.js';
import { pickNestedObservabilityEnv } from '../../shared/telemetry/index.js';
import type { DevinCallOptions } from './types.js';

const log = createLogger('devin-process');

// Matches the grace window the managed process gives the leader group
// between SIGTERM and SIGKILL.
const DESCENDANT_KILL_GRACE_MS = 250;
const DESCENDANT_SCAN_TIMEOUT_MS = 5_000;

const DEVIN_COMMAND = 'devin';
const DEVIN_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
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
  'DEVIN_API_URL',
  'DEVIN_MODEL',
  'DEVIN_SANDBOX',
  'DEVIN_SESSIONS_DIR',
  'DEVIN_WEBAPP_URL',
  'WINDSURF_API_KEY',
];

export type DevinExecError = Error & {
  code?: string | number;
  /** Devin's `cognition.ai/errorKind` from a JSON-RPC error's data, when present. */
  errorKind?: string;
  /** Session resolved during the call; lets error paths report it for resume. */
  sessionId?: string;
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
  /**
   * Exit info once the leader process dies — set on `exit` or `close`,
   * whichever arrives first.
   */
  exitInfo(): DevinProcessExit | undefined;
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
    errorKind?: string;
    sessionId?: string;
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
  error.errorKind = params.errorKind;
  error.sessionId = params.sessionId;
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

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

// Devin's exec tool runs commands via setsid: they stay direct children of
// the devin process but lead their own sessions and process groups, so the
// leader's process-group signal cannot reach them. The descendant list must
// be collected BEFORE the leader dies — afterwards the survivors are
// reparented (to /init) and the ancestry is gone. Each descendant process
// group then gets its own SIGTERM → grace → SIGKILL, mirroring the managed
// termination cadence.
function collectDescendantProcessGroups(rootPid: number): Set<number> {
  const groups = new Set<number>();
  try {
    const output = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: DESCENDANT_SCAN_TIMEOUT_MS,
    });
    const childrenByParent = new Map<number, number[]>();
    const pgidByPid = new Map<number, number>();
    for (const line of output.split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 3) {
        continue;
      }
      const [pid, ppid, pgid] = fields.map(Number) as [number, number, number];
      if (Number.isNaN(pid) || Number.isNaN(ppid) || Number.isNaN(pgid)) {
        continue;
      }
      pgidByPid.set(pid, pgid);
      const siblings = childrenByParent.get(ppid);
      if (siblings === undefined) {
        childrenByParent.set(ppid, [pid]);
      } else {
        siblings.push(pid);
      }
    }
    const queue = [rootPid];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const pid of childrenByParent.get(parent) ?? []) {
        const pgid = pgidByPid.get(pid);
        if (pgid !== undefined) {
          groups.add(pgid);
        }
        queue.push(pid);
      }
    }
  } catch {
    // ps unavailable (or mocked): the leader-group kill still applies.
  }
  return groups;
}

// `devin acp` keeps stdout for JSON-RPC protocol frames and stderr for
// diagnostics. Stderr is still collected with the same bound as print mode so
// a chatty process cannot exhaust memory; stdout needs no byte bound here
// because the SDK consumes it incrementally and rejects oversized frames.
// The agent execs tool commands and MCP servers below the leader, so
// termination goes through the managed-process machinery — process-group
// kill on POSIX, `taskkill /T` on Windows — plus a descendant sweep on POSIX
// for the setsid'd exec commands that escape the leader's group.
export function spawnDevinAcp(args: string[], options: DevinCallOptions): DevinAcpProcess {
  // The managed process gets no abort signal: its listener would kill the
  // leader's group before `terminate()` can collect the detached descendant
  // groups. Abort is funnelled through `terminate()` by the ACP runner.
  options.abortSignal?.throwIfAborted();
  const managed = spawnManagedProcess(
    options.devinCliPath ?? DEVIN_COMMAND,
    args,
    {
      cwd: options.cwd,
      env: buildEnv(options.childProcessEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
    undefined,
  );
  const child = managed.child;

  let stderr = '';
  let stderrBytes = 0;
  let stderrOverflowed = false;
  let exit: DevinProcessExit | undefined;

  const terminate = (): void => {
    // On POSIX, sweep the detached (setsid'd) descendant groups first — their
    // ancestry is still intact while the leader lives. Windows' taskkill /T
    // already follows the whole tree.
    const descendantGroups = process.platform === 'win32' || child.pid === undefined
      ? new Set<number>()
      : collectDescendantProcessGroups(child.pid);
    for (const pgid of descendantGroups) {
      signalProcessGroup(pgid, 'SIGTERM');
    }
    // Schedule the descendant SIGKILL independently — managed.terminate()
    // waits on `close`, which a pipe-holding descendant could otherwise
    // stall past the kill deadline.
    if (descendantGroups.size > 0) {
      void delay(DESCENDANT_KILL_GRACE_MS).then(() => {
        for (const pgid of descendantGroups) {
          signalProcessGroup(pgid, 'SIGKILL');
        }
      });
    }
    void managed.terminate().catch((error: unknown) => {
      log.debug('Devin process termination failed', { error: getErrorMessage(error) });
    });
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

  const recordExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exit ??= { code, signal };
  };
  child.once('exit', recordExit);
  child.once('close', recordExit);

  const exited = new Promise<DevinProcessExit>((resolve, reject) => {
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
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
    exitInfo: () => exit,
    terminate,
  };
}
