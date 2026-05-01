#!/usr/bin/env node

/**
 * TAKT CLI entry point
 *
 * Import order matters: program setup → commands → routing → parse.
 */

import { checkForUpdates } from '../../shared/utils/index.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { error as errorLog } from '../../shared/ui/index.js';
import { resolveRemovedRootCommand, resolveSlashFallbackTask } from './helpers.js';
import { installImmediateSigintExit } from './immediateSigintExit.js';
import { installOpencodeExitCleanup } from './opencodeExitCleanup.js';

checkForUpdates();

// Import in dependency order
import { program, runPreActionHook } from './program.js';
import './commands.js';
import { executeDefaultAction } from './routing.js';

(async () => {
  const args = process.argv.slice(2);
  installOpencodeExitCleanup();
  const cleanupImmediateSigintExit = installImmediateSigintExit(args[0]);
  const { operands } = program.parseOptions(args);
  const removedRootCommand = resolveRemovedRootCommand(operands);
  if (removedRootCommand !== null) {
    cleanupImmediateSigintExit();
    errorLog(`error: unknown command '${removedRootCommand}'`);
    process.exit(1);
  }

  const knownCommands = program.commands.map((cmd) => cmd.name());
  const slashFallbackTask = resolveSlashFallbackTask(args, knownCommands);

  if (slashFallbackTask !== null) {
    try {
      await runPreActionHook();
      await executeDefaultAction(slashFallbackTask);
    } finally {
      cleanupImmediateSigintExit();
    }
    process.exit(0);
  }

  // Normal parsing for all other cases (including '#' prefixed inputs)
  try {
    await program.parseAsync();
  } finally {
    cleanupImmediateSigintExit();
  }

  const rootArg = process.argv.slice(2)[0];
  if (rootArg !== 'watch') {
    process.exit(0);
  }
})().catch((err) => {
  errorLog(getErrorMessage(err));
  process.exit(1);
});
