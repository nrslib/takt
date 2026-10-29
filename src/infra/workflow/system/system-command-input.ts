import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { WorkflowState, WorkflowSystemInput } from '../../../core/models/types.js';
import type { SystemStepServicesOptions } from '../../../core/workflow/system/system-step-services.js';
import { getPreviousOutput } from '../../../core/workflow/engine/state-manager.js';
import { ensurePrivateDirectory, writePrivateFile } from '../../../shared/utils/private-file.js';
import { buildCommandEnv, MAX_COMMAND_OUTPUT_BYTES, runBoundedCommand } from '../../../shared/utils/bounded-command-runner.js';

export async function resolveCommandInput(
  input: Extract<WorkflowSystemInput, { type: 'command' }>,
  options: SystemStepServicesOptions,
  state: WorkflowState,
): Promise<Record<string, unknown>> {
  if (options.contextDirectory === undefined) {
    throw new Error('Command system input requires a run context directory');
  }
  options.abortSignal?.throwIfAborted();
  const previous = getPreviousOutput(state);
  const directory = join(options.contextDirectory, 'system-commands', randomUUID());
  ensurePrivateDirectory(directory);
  const responsePath = join(directory, 'response.txt');
  writePrivateFile(responsePath, previous?.content ?? '');
  const env = buildCommandEnv(process.env);
  env.TAKT_PREVIOUS_RESPONSE_FILE = responsePath;
  if (previous?.structuredOutput !== undefined) {
    const structuredPath = join(directory, 'structured-output.json');
    writePrivateFile(structuredPath, JSON.stringify(previous.structuredOutput));
    env.TAKT_PREVIOUS_STRUCTURED_OUTPUT_FILE = structuredPath;
  }
  const result = await runBoundedCommand({
    command: input.command,
    timeoutMs: input.timeout_ms,
    cwd: options.cwd,
    env,
    signal: options.abortSignal,
  });
  if (result.aborted) {
    throw new Error('Command system input interrupted');
  }
  if (result.outputLimitExceeded) {
    throw new Error(`Command system input output exceeded ${MAX_COMMAND_OUTPUT_BYTES} bytes`);
  }
  if (result.error !== undefined) {
    throw new Error('Command system input execution failed', { cause: result.error });
  }
  const resolved: Record<string, unknown> = {
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  if (input.output === 'json' && result.exitCode === 0 && !result.timedOut) {
    resolved.json = JSON.parse(result.stdout) as unknown;
  }
  return resolved;
}
