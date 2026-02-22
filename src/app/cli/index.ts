#!/usr/bin/env node

/**
 * TAKT CLI entry point
 *
 * Import order matters: program setup → commands → routing → parse.
 */

import { checkForUpdates } from '../../shared/utils/index.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { error as errorLog } from '../../shared/ui/index.js';

checkForUpdates();

// Import in dependency order
import { program, runPreActionHook } from './program.js';
import './commands.js';
import { executeDefaultAction } from './routing.js';

(async () => {
  const args = process.argv.slice(2);
  const firstArg = args[0];

  // Handle '/' prefixed inputs that are not known commands
  if (firstArg?.startsWith('/')) {
    const commandName = firstArg.slice(1);
    const knownCommands = program.commands.map((cmd) => cmd.name());

    if (!knownCommands.includes(commandName)) {
      // Treat as task instruction
      const task = args.join(' ');
      await runPreActionHook();
      await executeDefaultAction(task);
      process.exit(0);
    }
  }

  // Normal parsing for all other cases (including '#' prefixed inputs)
  await program.parseAsync();

  const rootArg = process.argv.slice(2)[0];
  if (rootArg !== 'watch') {
    process.exit(0);
  }
})().catch((err) => {
  errorLog(getErrorMessage(err));
  process.exit(1);
});
