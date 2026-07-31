import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { spawnManagedProcess, type ManagedProcess } from '../../shared/utils/spawn.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { formatProcessExitCause } from '../../shared/utils/process-exit.js';
import type { CodexEvent } from './CodexStreamHandler.js';
import { createStrictCodexExecutionProfile } from './strict-execution-profile.js';
import type { CodexCallOptions } from './types.js';

const MAX_STDERR_BYTES = 64 * 1024;

interface IsolatedCodexExecution {
  readonly prompt: string;
  readonly options: CodexCallOptions;
}

interface CodexCommand {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
}

function resolveCodexCommand(pathOverride: string | undefined): CodexCommand {
  if (pathOverride !== undefined) {
    return { executable: pathOverride, prefixArgs: [] };
  }
  const require = createRequire(import.meta.url);
  return {
    executable: process.execPath,
    prefixArgs: [require.resolve('@openai/codex/bin/codex.js')],
  };
}

function appendStderrChunk(chunks: Buffer[], raw: Buffer): void {
  const captured = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const remaining = Math.max(0, MAX_STDERR_BYTES - captured);
  if (remaining > 0) {
    chunks.push(raw.subarray(0, remaining));
  }
}

function isolatedCodexExitError(
  result: { readonly code: number | null; readonly signal: NodeJS.Signals | null },
  stderrChunks: readonly Buffer[],
): Error {
  return new Error(
    `Isolated Codex exited with ${formatProcessExitCause(result.code, result.signal)}: `
    + Buffer.concat(stderrChunks).toString('utf-8'),
  );
}

export async function* executeIsolatedCodex(
  execution: IsolatedCodexExecution,
): AsyncGenerator<CodexEvent> {
  const { prompt, options } = execution;
  const profile = createStrictCodexExecutionProfile(options);
  let managedProcess: ManagedProcess | undefined;
  let processTerminationAttempted = false;
  let executionError: unknown;
  let cleanupError: AggregateError | undefined;
  try {
    const command = resolveCodexCommand(options.codexPathOverride);
    managedProcess = spawnManagedProcess(
      command.executable,
      [...command.prefixArgs, ...profile.args],
      {
        env: profile.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      options.abortSignal,
    );
    const { child } = managedProcess;
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      throw new Error('Unable to communicate with isolated Codex');
    }

    let stdinError: unknown;
    const stderrChunks: Buffer[] = [];
    child.stdin.once('error', (error) => {
      stdinError = error;
    });
    child.stderr.on('data', (raw: Buffer) => appendStderrChunk(stderrChunks, raw));
    child.stdin.end(prompt);

    const processExitPromise = managedProcess.wait();
    const leaderExitPromise = managedProcess.waitForExit();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const lineIterator = lines[Symbol.asyncIterator]();
    let nextLinePromise = lineIterator.next();
    let leaderExitObserved = false;
    let processCloseObserved = false;
    try {
      while (true) {
        const lifecyclePromises = [
          nextLinePromise.then((next) => ({ kind: 'line' as const, next })),
          ...(leaderExitObserved
            ? []
            : [leaderExitPromise.then((result) => ({ kind: 'leader-exit' as const, result }))]),
          ...(processCloseObserved
            ? []
            : [processExitPromise.then((result) => ({ kind: 'process-close' as const, result }))]),
        ];
        const outcome = await Promise.race(lifecyclePromises);
        if (outcome.kind === 'leader-exit' || outcome.kind === 'process-close') {
          if (outcome.result.code !== 0 || outcome.result.signal !== null) {
            throw isolatedCodexExitError(outcome.result, stderrChunks);
          }
          if (outcome.kind === 'leader-exit') {
            leaderExitObserved = true;
            processTerminationAttempted = true;
            await managedProcess.terminate();
          } else {
            processCloseObserved = true;
            leaderExitObserved = true;
          }
          continue;
        }
        const { next } = outcome;
        if (next.done) {
          break;
        }
        try {
          yield JSON.parse(next.value) as CodexEvent;
        } catch (error) {
          throw new Error('Failed to parse isolated Codex event', { cause: error });
        }
        nextLinePromise = lineIterator.next();
      }
    } finally {
      lines.close();
    }

    const result = await processExitPromise;
    if (stdinError !== undefined) {
      throw stdinError;
    }
    if (result.code !== 0 || result.signal !== null) {
      throw isolatedCodexExitError(result, stderrChunks);
    }
  } catch (error) {
    executionError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (managedProcess !== undefined && !processTerminationAttempted) {
      try {
        processTerminationAttempted = true;
        await managedProcess.terminate();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      profile.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const errors = executionError === undefined
        ? cleanupErrors
        : [executionError, ...cleanupErrors];
      const primary = executionError === undefined
        ? 'Isolated Codex cleanup failed'
        : `Isolated Codex execution failed: ${getErrorMessage(executionError)}; cleanup also failed`;
      cleanupError = new AggregateError(errors, primary);
    }
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if (executionError !== undefined) {
    throw executionError;
  }
}
