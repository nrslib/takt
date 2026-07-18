#!/usr/bin/env node

/**
 * TAKT CLI entry point
 */

import { CommanderError } from 'commander';
import { getErrorMessage } from '../../shared/utils/error.js';
import { error as errorLog } from '../../shared/ui/index.js';
import { resolveRemovedRootCommand, resolveSlashFallbackTask } from './helpers.js';
import { installImmediateSigintExit } from './immediateSigintExit.js';

import { program, runPreActionHook, scheduleUpdateCheck } from './program.js';
import './commands.js';

(async () => {
  const args = process.argv.slice(2);
  const cleanupImmediateSigintExit = installImmediateSigintExit(args[0]);

  try {
    try {
      const { operands } = program.parseOptions(args);
      const removedRootCommand = resolveRemovedRootCommand(operands);
      if (removedRootCommand !== null) {
        await scheduleUpdateCheck();
        errorLog(`error: unknown command '${removedRootCommand}'`);
        return process.exit(1);
      }

      const knownCommands = program.commands.map((cmd) => cmd.name());
      const slashFallbackTask = resolveSlashFallbackTask(args, knownCommands);

      if (slashFallbackTask !== null) {
        await runPreActionHook();
        const { executeDefaultAction } = await import('./routing.js');
        await executeDefaultAction(slashFallbackTask);
        return process.exit();
      }

      await program.parseAsync();
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error;
      await scheduleUpdateCheck();
      return process.exit(error.exitCode);
    }

    const rootArg = process.argv.slice(2)[0];
    if (rootArg !== 'watch') {
      process.exit();
    }
  } finally {
    cleanupImmediateSigintExit();
  }
})().catch((err) => {
  errorLog(getErrorMessage(err));
  process.exit(1);
});
