/**
 * Commander program setup
 *
 * Creates the Command instance, registers global options,
 * and sets up the preAction hook for initialization.
 */

import { Command, Option } from 'commander';
import { packageVersion } from '../../shared/package-info.js';
import { runUpdateCheck } from './updateCheck.js';

const cliVersion = packageVersion;

export { cliVersion };

export const program = new Command();
program.exitOverride();

let updateCheckStarted = false;

program
  .name('takt')
  .description('TAKT: TAKT Agent Koordination Topology')
  .version(cliVersion);

// --- Global options ---
program
  .option('-i, --issue <number>', 'Issue number (equivalent to #N)', (val: string) => parseInt(val, 10))
  .option('--pr <number>', 'PR number to fetch review comments and fix', (val: string) => parseInt(val, 10))
  .option('-w, --workflow <name>', 'Workflow name or path to workflow file')
  .option('-b, --branch <name>', 'Branch name (auto-generated if omitted)')
  .option('--auto-pr', 'Create PR after successful execution')
  .option('--draft', 'Create PR as draft (requires --auto-pr or auto_pr config)')
  .option('--repo <owner/repo>', 'Repository (defaults to current)')
  .option(
    '--provider <name>',
    'Override agent provider (auto|claude|claude-sdk|claude-terminal|codex|opencode|cursor|copilot|kiro|mock)',
  )
  .addOption(new Option('--auto-strategy <strategy>', 'Auto routing strategy (cost|balanced|performance)')
    .choices(['cost', 'balanced', 'performance']))
  .option('--model <name>', 'Override agent model')
  .option('-t, --task <string>', 'Task content (as alternative to issue reference)')
  .option('--pipeline', 'Pipeline mode: non-interactive, no worktree, direct branch creation')
  .option('--skip-git', 'Skip branch creation, commit, and push (pipeline mode)')
  .option('-q, --quiet', 'Minimal output mode: suppress AI output (for CI)')
  .option('-c, --continue', 'Continue from the last assistant session');

program
  .argument('[task]', 'Task to execute (or issue reference like "#6")')
  .action(async (task?: string) => {
    const { executeDefaultAction } = await import('./routing.js');
    await executeDefaultAction(task);
  });

/**
 * Run pre-action hook: common initialization for all commands.
 * Exported for use in slash-command fallback logic.
 */
export async function runPreActionHook(): Promise<void> {
  await scheduleUpdateCheck();
  const { initializeCliExecutionContext } = await import('./initialization.js');
  await initializeCliExecutionContext(program, cliVersion);
}

export async function scheduleUpdateCheck(): Promise<void> {
  if (updateCheckStarted) return;
  updateCheckStarted = true;
  await runUpdateCheck(cliVersion);
}

// Common initialization for all commands
program.hook('preAction', runPreActionHook);
