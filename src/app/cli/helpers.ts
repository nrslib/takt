/**
 * CLI helper functions
 *
 * Utility functions for option parsing and task classification.
 */

import type { Command } from 'commander';
import type { TaskExecutionOptions } from '../../features/tasks/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { isIssueReference } from '../../infra/git/index.js';
import { warnLegacyConfigKeyOncePerProcess } from '../../infra/config/legacy-workflow-key-deprecation.js';

const REMOVED_ROOT_COMMANDS = new Set(['switch']);

/**
 * Resolve --provider and --model options into TaskExecutionOptions.
 * Returns undefined if neither is specified.
 */
export function resolveAgentOverrides(program: Command): TaskExecutionOptions | undefined {
  const opts = program.opts();
  const provider = opts.provider as ProviderType | undefined;
  const model = opts.model as string | undefined;

  if (!provider && !model) {
    return undefined;
  }

  return { provider, model };
}

/**
 * Check if the input is a task description that should execute directly
 * vs one that should enter interactive mode.
 *
 * Direct execution (returns true):
 * - Valid issue references (e.g., "#32", "#10 #20")
 *
 * Interactive mode (returns false):
 * - All other inputs (task descriptions, single words, slash-prefixed, etc.)
 *
 * Note: This simplified logic ensures that only explicit issue references
 * trigger direct execution. All other inputs go through interactive mode
 * for requirement clarification.
 */
export function isDirectTask(input: string): boolean {
  return isIssueReference(input) || input.trim().split(/\s+/).every((t: string) => isIssueReference(t));
}

export function resolveSlashFallbackTask(args: string[], knownCommands: string[]): string | null {
  const firstArg = args[0];
  if (!firstArg?.startsWith('/')) {
    return null;
  }

  const commandName = firstArg.slice(1);
  if (knownCommands.includes(commandName)) {
    return null;
  }

  return args.join(' ');
}

export function resolveRemovedRootCommand(args: string[]): string | null {
  const firstArg = args[0];
  if (!firstArg) {
    return null;
  }
  return REMOVED_ROOT_COMMANDS.has(firstArg) ? firstArg : null;
}

export function resolveWorkflowCliOption(opts: Record<string, unknown>): string | undefined {
  const workflow = typeof opts.workflow === 'string' ? opts.workflow : undefined;
  const piece = typeof opts.piece === 'string' ? opts.piece : undefined;

  if (workflow !== undefined && piece !== undefined && workflow !== piece) {
    throw new Error('--workflow and --piece cannot be used together with different values');
  }

  if (typeof piece === 'string') {
    warnLegacyConfigKeyOncePerProcess('piece', 'workflow', 'CLI');
  }

  return workflow ?? piece;
}
