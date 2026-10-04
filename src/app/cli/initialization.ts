import { resolve } from 'node:path';
import type { Command } from 'commander';
import { initGlobalDirs, initProjectDirs } from '../../infra/config/global/initialization.js';
import { getConfigDirCollision } from '../../infra/config/paths.js';
import { isVerboseMode } from '../../infra/config/project/resolvedSettings.js';
import { resolveConfigValues } from '../../infra/config/resolveConfigValue.js';
import {
  initializeRuntimeAssignmentInvocation,
  prepareRuntimeAssignmentInvocation,
} from '../../infra/config/runtime-provider/invocation.js';
import { initGitProvider } from '../../infra/git/index.js';
import { setQuietMode } from '../../shared/context.js';
import { setLogLevel } from '../../shared/ui/LogManager.js';
import { createLogger, initDebugLogger, setVerboseConsole } from '../../shared/utils/debug.js';

interface CliExecutionContext {
  cwd: string;
  pipelineMode: boolean;
}

let executionContext: Readonly<CliExecutionContext> | undefined;

export function assertConfigDirsDoNotCollide(projectDir: string): void {
  const collisionPath = getConfigDirCollision(projectDir);
  if (collisionPath === undefined) return;

  throw new Error(
    `Global and project configuration directories resolve to the same path: ${collisionPath}. `
      + 'Set TAKT_CONFIG_DIR to a different directory.',
  );
}

export async function initializeCliExecutionContext(program: Command, cliVersion: string): Promise<void> {
  executionContext = undefined;
  const cwd = resolve(process.cwd());
  const rootOpts = program.opts();
  const pipelineMode = rootOpts.pipeline === true;

  prepareRuntimeAssignmentInvocation(cwd, rootOpts.runtimeAssignment, rootOpts.runtimeFile);
  await initGlobalDirs({ nonInteractive: pipelineMode });
  initializeRuntimeAssignmentInvocation(cwd, rootOpts.runtimeAssignment, rootOpts.runtimeFile);
  initProjectDirs(cwd);
  initGitProvider(cwd);

  const verbose = isVerboseMode(cwd);
  const config = resolveConfigValues(cwd, ['logging', 'minimalOutput']);
  initDebugLogger(verbose ? { enabled: true, trace: config.logging?.trace } : undefined, cwd);

  if (verbose) {
    setVerboseConsole(true);
    setLogLevel('debug');
  } else {
    setLogLevel(config.logging?.level ?? 'info');
  }

  const quietMode = rootOpts.quiet === true || config.minimalOutput === true;
  setQuietMode(quietMode);

  executionContext = Object.freeze({ cwd, pipelineMode });
  createLogger('cli').info('TAKT CLI starting', { version: cliVersion, cwd, verbose, pipelineMode, quietMode });
}

export function getCliExecutionContext(): Readonly<CliExecutionContext> {
  if (executionContext === undefined) {
    throw new Error('CLI execution context is not initialized');
  }
  return executionContext;
}
