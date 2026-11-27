import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { DEFAULT_COMMAND_GATE_TIMEOUT_MS } from '../../models/quality-gate-defaults.js';
import { assertPathSegmentsAreSafe, isRealPathInside } from '../../../shared/utils/index.js';
import { pickCommandGateNestedObservabilityEnv } from '../../../shared/telemetry/index.js';
import { buildCommandEnv, MAX_COMMAND_OUTPUT_BYTES, runBoundedCommand } from '../../../shared/utils/bounded-command-runner.js';
import { sanitizeSensitiveText } from './commandGateMessage.js';
import {
  ensurePrivateDirectory,
  writePrivateFile,
} from '../../../shared/utils/private-file.js';
import type {
  CommandOutputLimitFailureDetails,
  CommandQualityGateResult,
  RunCommandQualityGateOptions,
} from './types.js';

const OUTPUT_LIMIT_FAILURE_DETAILS: CommandOutputLimitFailureDetails = {
  outputLimitExceeded: true,
  outputLimitBytes: MAX_COMMAND_OUTPUT_BYTES,
};

function resolveGateCwd(projectRoot: string, cwd: string | undefined): string {
  return cwd ? path.resolve(projectRoot, cwd) : projectRoot;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  executionDetails?: readonly string[],
): { outputLogPath?: string; outputLogError?: string } {
  if (executionDetails === undefined && !stdout && !stderr) {
    return {};
  }

  try {
    const logDir = path.join(projectRoot, '.takt', 'quality-gates', 'logs');
    if (executionDetails !== undefined) {
      assertPathSegmentsAreSafe(projectRoot, logDir, () => new Error('Unsafe quality gate output log directory'));
    }
    ensurePrivateDirectory(logDir);
    const logPath = path.join(logDir, `${Date.now()}-command-gate-${randomUUID()}.log`);
    const content = [
      `Command: ${sanitizeCommandForOutputLog(command)}`,
      `Cwd: ${sanitizeSensitiveText(cwd)}`,
      ...(executionDetails === undefined ? [] : [...executionDetails, `Completed at: ${new Date().toISOString()}`]),
      '',
      'Stdout:',
      sanitizeSensitiveText(stdout),
      '',
      'Stderr:',
      sanitizeSensitiveText(stderr),
    ].join('\n');
    writePrivateFile(logPath, content);
    return { outputLogPath: logPath };
  } catch (error: unknown) {
    return { outputLogError: formatUnknownError(error) };
  }
}

function buildCommandGateEnv(
  source: NodeJS.ProcessEnv,
  childProcessEnv: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  return {
    ...buildCommandEnv(source),
    ...pickCommandGateNestedObservabilityEnv(childProcessEnv),
  };
}

function buildFailure(
  gate: RunCommandQualityGateOptions['gate'],
  cwd: string,
  projectRoot: string,
  stdout: string,
  stderr: string,
  timedOut: boolean,
  timeoutMs: number | undefined,
  outputLimitFailure: CommandOutputLimitFailureDetails | undefined,
  exitCode?: number,
): CommandQualityGateResult {
  const exitDetails = timedOut ? `Timeout: ${timeoutMs}ms` : `Exit code: ${exitCode ?? 'unavailable'}`;
  const outputLog = writeOutputLog(
    projectRoot, gate.command, cwd, stdout, stderr,
    gate.runAt === 'before_report' ? [exitDetails] : undefined,
  );
  const failure = {
    gateName: gate.name ?? gate.command,
    type: 'command' as const,
    command: gate.command,
    cwd,
    projectRoot,
    ...(exitCode !== undefined ? { exitCode } : {}),
    stdout,
    stderr,
    timedOut,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...outputLog,
  };
  if (outputLimitFailure === undefined) {
    return { ok: false, failure };
  }
  return {
    ok: false,
    failure: { ...failure, ...outputLimitFailure },
  };
}

export async function runCommandQualityGate({
  gate,
  projectRoot,
  childProcessEnv,
  signal,
}: RunCommandQualityGateOptions): Promise<CommandQualityGateResult> {
  signal?.throwIfAborted();
  const cwd = resolveGateCwd(projectRoot, gate.cwd);
  const gateName = gate.name ?? gate.command;

  if (!isRealPathInside(projectRoot, cwd)) {
    return buildFailure(
      gate,
      cwd,
      projectRoot,
      '',
      `Command quality gate cwd must stay inside the project root: ${cwd}`,
      false,
      gate.timeoutMs,
      undefined,
    );
  }

  const effectiveTimeoutMs = gate.timeoutMs ?? DEFAULT_COMMAND_GATE_TIMEOUT_MS;
  const result = await runBoundedCommand({
    command: gate.command,
    cwd,
    timeoutMs: effectiveTimeoutMs,
    env: buildCommandGateEnv(process.env, childProcessEnv),
    signal,
  });
  signal?.throwIfAborted();
  if (result.exitCode === 0 && !result.timedOut && result.error === undefined) {
    if (gate.runAt === 'before_report') {
      const log = writeOutputLog(projectRoot, gate.command, cwd, result.stdout, result.stderr, ['Exit code: 0']);
      if (log.outputLogPath === undefined) {
        throw new Error(`Could not save successful quality gate result: ${sanitizeSensitiveText(log.outputLogError ?? '')}`);
      }
      return {
        ok: true,
        stdout: result.stdout,
        stderr: result.stderr,
        evidence: {
          name: sanitizeSensitiveText(gateName),
          command: sanitizeCommandForOutputLog(gate.command),
          exitCode: 0,
          outputLogPath: path.relative(projectRoot, log.outputLogPath),
        },
      };
    }
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  }
  return buildFailure(
    gate, cwd, projectRoot,
    result.stdout, result.stderr, result.timedOut,
    result.timedOut ? effectiveTimeoutMs : undefined,
    result.outputLimitExceeded ? OUTPUT_LIMIT_FAILURE_DETAILS : undefined,
    result.timedOut ? undefined : result.exitCode ?? undefined,
  );
}
