/**
 * Commander program setup
 *
 * Creates the Command instance, registers global options,
 * and sets up the preAction hook for initialization.
 */

import { createRequire } from 'node:module';
import { Command } from 'commander';
import { resolve } from 'node:path';
import {
  initGlobalDirs,
  initProjectDirs,
  loadGlobalConfig,
  isVerboseMode,
} from '../../infra/config/index.js';
import { setQuietMode } from '../../shared/context.js';
import { setLogLevel } from '../../shared/ui/index.js';
import { initDebugLogger, createLogger, setVerboseConsole } from '../../shared/utils/index.js';

const require = createRequire(import.meta.url);
const { version: cliVersion } = require('../../../package.json') as { version: string };

const log = createLogger('cli');

/** Resolved cwd shared across commands via preAction hook */
export let resolvedCwd = '';

/** Whether pipeline mode is active (--task specified, set in preAction) */
export let pipelineMode = false;

export { cliVersion };

export const program = new Command();

program
  .name('takt')
  .description('TAKT: TAKT Agent Koordination Topology')
  .version(cliVersion);

// --- Global options ---
program
  .option('-i, --issue <number>', 'GitHub issue number (equivalent to #N)', (val: string) => parseInt(val, 10))
  .option('-w, --piece <name>', 'Piece name or path to piece file')
  .option('-b, --branch <name>', 'Branch name (auto-generated if omitted)')
  .option('--auto-pr', 'Create PR after successful execution')
  .option('--repo <owner/repo>', 'Repository (defaults to current)')
  .option('--provider <name>', 'Override agent provider (claude|codex|opencode|mock)')
  .option('--model <name>', 'Override agent model')
  .option('-t, --task <string>', 'Task content (as alternative to GitHub issue)')
  .option('--pipeline', 'Pipeline mode: non-interactive, no worktree, direct branch creation')
  .option('--skip-git', 'Skip branch creation, commit, and push (pipeline mode)')
  .option('--create-worktree <yes|no>', 'Skip the worktree prompt by explicitly specifying yes or no')
  .option('-q, --quiet', 'Minimal output mode: suppress AI output (for CI)');

/**
 * Run pre-action hook: common initialization for all commands.
 * Exported for use in slash-command fallback logic.
 */
export async function runPreActionHook(): Promise<void> {
  resolvedCwd = resolve(process.cwd());

  const rootOpts = program.opts();
  pipelineMode = rootOpts.pipeline === true;

  await initGlobalDirs({ nonInteractive: pipelineMode });
  initProjectDirs(resolvedCwd);

  const verbose = isVerboseMode(resolvedCwd);
  initDebugLogger(verbose ? { enabled: true } : undefined, resolvedCwd);

  const config = loadGlobalConfig();

  if (verbose) {
    setVerboseConsole(true);
    setLogLevel('debug');
  } else {
    setLogLevel(config.logLevel);
  }

  const quietMode = rootOpts.quiet === true || config.minimalOutput === true;
  setQuietMode(quietMode);

  log.info('TAKT CLI starting', { version: cliVersion, cwd: resolvedCwd, verbose, pipelineMode, quietMode });
}

// Common initialization for all commands
program.hook('preAction', runPreActionHook);
