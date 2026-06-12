import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_COMMAND_GATE_TIMEOUT_MS } from '../../models/quality-gate-defaults.js';
import { isRealPathInside } from '../../../shared/utils/index.js';
import { pickCommandGateNestedObservabilityEnv } from '../../../shared/telemetry/index.js';
import { sanitizeSensitiveText } from './commandGateMessage.js';
import type { CommandQualityGateResult, RunCommandQualityGateOptions } from './types.js';

const FORCE_KILL_GRACE_MS = 100;
const MAX_OUTPUT_BYTES = 64 * 1024;
const OUTPUT_LIMIT_MARKER = `[OUTPUT TRUNCATED: exceeded ${MAX_OUTPUT_BYTES} bytes]`;
const COMMAND_GATE_ENV_ALLOWLIST = new Set([
  'PATH',
  'Path',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]);

function resolveGateCwd(projectRoot: string, cwd: string | undefined): string {
  return cwd ? path.resolve(projectRoot, cwd) : projectRoot;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function appendStderr(stderr: string, message: string): string {
  return stderr ? `${stderr}\n${message}` : message;
}

function appendOutputWithinLimit(current: string, outputBytes: number, chunk: string): {
  output: string;
  bytes: number;
  exceeded: boolean;
} {
  if (outputBytes >= MAX_OUTPUT_BYTES) {
    return {
      output: current.endsWith(OUTPUT_LIMIT_MARKER) ? current : `${current}\n${OUTPUT_LIMIT_MARKER}`,
      bytes: outputBytes,
      exceeded: true,
    };
  }

  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  if (outputBytes + chunkBytes <= MAX_OUTPUT_BYTES) {
    return {
      output: `${current}${chunk}`,
      bytes: outputBytes + chunkBytes,
      exceeded: false,
    };
  }

  const remainingBytes = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
  const boundedChunk = Buffer.from(chunk, 'utf8').subarray(0, remainingBytes).toString('utf8');
  return {
    output: `${current}${boundedChunk}\n${OUTPUT_LIMIT_MARKER}`,
    bytes: MAX_OUTPUT_BYTES,
    exceeded: true,
  };
}

function sanitizeCommandForOutputLog(command: string): string {
  const sanitized = sanitizeSensitiveText(command);
  return sanitized === command ? command : '[REDACTED]';
}

function writeOutputLog(
  projectRoot: string,
  command: string,
  cwd: string,
  stdout: string,
  stderr: string,
): { outputLogPath?: string; outputLogError?: string } {
  if (!stdout && !stderr) {
    return {};
  }

  try {
    const logDir = path.join(projectRoot, '.takt', 'quality-gates', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${Date.now()}-command-gate-${randomUUID()}.log`);
    const content = [
      `Command: ${sanitizeCommandForOutputLog(command)}`,
      `Cwd: ${sanitizeSensitiveText(cwd)}`,
      '',
      'Stdout:',
      sanitizeSensitiveText(stdout),
      '',
      'Stderr:',
      sanitizeSensitiveText(stderr),
    ].join('\n');
    writeFileSync(logPath, content, 'utf8');
    return { outputLogPath: logPath };
  } catch (error: unknown) {
    return { outputLogError: formatUnknownError(error) };
  }
}

function buildCommandGateEnv(
  source: NodeJS.ProcessEnv,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of COMMAND_GATE_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return {
    ...env,
    ...pickCommandGateNestedObservabilityEnv(childProcessEnv),
  };
}

function buildFailure(
  gateName: string,
  gateCommand: string,
  cwd: string,
  projectRoot: string,
  stdout: string,
  stderr: string,
  timedOut: boolean,
  timeoutMs: number | undefined,
  outputLimitExceeded: boolean,
  exitCode?: number,
): CommandQualityGateResult {
  const outputLog = writeOutputLog(projectRoot, gateCommand, cwd, stdout, stderr);
  return {
    ok: false,
    failure: {
      gateName,
      type: 'command',
      command: gateCommand,
      cwd,
      projectRoot,
      ...(exitCode !== undefined ? { exitCode } : {}),
      stdout,
      stderr,
      timedOut,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(outputLimitExceeded ? { outputLimitExceeded, outputLimitBytes: MAX_OUTPUT_BYTES } : {}),
      ...outputLog,
    },
  };
}

function killProcess(childPid: number, signal: NodeJS.Signals = 'SIGTERM'): string | undefined {
  try {
    if (process.platform === 'win32') {
      process.kill(childPid, signal);
      return undefined;
    }
    process.kill(-childPid, signal);
    return undefined;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ESRCH') {
      return undefined;
    }
    return `Failed to kill timed-out command: ${formatUnknownError(error)}`;
  }
}

export function runCommandQualityGate({
  gate,
  projectRoot,
  childProcessEnv,
}: RunCommandQualityGateOptions): Promise<CommandQualityGateResult> {
  const cwd = resolveGateCwd(projectRoot, gate.cwd);
  const gateName = gate.name ?? gate.command;

  if (!isRealPathInside(projectRoot, cwd)) {
    return Promise.resolve(buildFailure(
      gateName,
      gate.command,
      cwd,
      projectRoot,
      '',
      `Command quality gate cwd must stay inside the project root: ${cwd}`,
      false,
      gate.timeoutMs,
      false,
    ));
  }

  return new Promise((resolve) => {
    const effectiveTimeoutMs = gate.timeoutMs ?? DEFAULT_COMMAND_GATE_TIMEOUT_MS;
    const child = spawn(gate.command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildCommandGateEnv(process.env, childProcessEnv),
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let terminationScheduled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      if (outputLimitExceeded) {
        return;
      }
      const appended = appendOutputWithinLimit(stdout, outputBytes, chunk);
      stdout = appended.output;
      outputBytes = appended.bytes;
      if (appended.exceeded) {
        outputLimitExceeded = true;
        terminateProcess();
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      if (outputLimitExceeded) {
        return;
      }
      const appended = appendOutputWithinLimit(stderr, outputBytes, chunk);
      stderr = appended.output;
      outputBytes = appended.bytes;
      if (appended.exceeded) {
        outputLimitExceeded = true;
        terminateProcess();
      }
    });

    const timeout: NodeJS.Timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess();
    }, effectiveTimeoutMs);

    function clearTimers(): void {
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
    }

    function settle(result: CommandQualityGateResult): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve(result);
    }

    function terminateProcess(): void {
      if (terminationScheduled) {
        return;
      }
      terminationScheduled = true;
      clearTimeout(timeout);

      if (child.pid === undefined) {
        settle(buildFailure(
          gateName,
          gate.command,
          cwd,
          projectRoot,
          stdout,
          stderr,
          timedOut,
          timedOut ? effectiveTimeoutMs : undefined,
          outputLimitExceeded,
        ));
        return;
      }

      const killError = killProcess(child.pid);
      if (killError !== undefined) {
        stderr = appendStderr(stderr, killError);
      }

      forceKillTimer = setTimeout(() => {
        if (child.pid !== undefined) {
          const forceKillError = killProcess(child.pid, 'SIGKILL');
          if (forceKillError !== undefined) {
            stderr = appendStderr(stderr, forceKillError);
          }
        }
        settle(buildFailure(
          gateName,
          gate.command,
          cwd,
          projectRoot,
          stdout,
          stderr,
          timedOut,
          timedOut ? effectiveTimeoutMs : undefined,
          outputLimitExceeded,
        ));
      }, FORCE_KILL_GRACE_MS);
      forceKillTimer.unref?.();
    }

    child.on('error', (error) => {
      settle(buildFailure(
        gateName,
        gate.command,
        cwd,
        projectRoot,
        stdout,
        stderr || error.message,
        timedOut,
        timedOut ? effectiveTimeoutMs : undefined,
        outputLimitExceeded,
      ));
    });

    child.on('close', (code) => {
      clearTimers();

      if (code === 0 && !timedOut && !outputLimitExceeded) {
        settle({ ok: true, stdout, stderr });
        return;
      }

      settle(buildFailure(
        gateName,
        gate.command,
        cwd,
        projectRoot,
        stdout,
        stderr,
        timedOut,
        timedOut ? effectiveTimeoutMs : undefined,
        outputLimitExceeded,
        timedOut || outputLimitExceeded ? undefined : code ?? undefined,
      ));
    });
  });
}
