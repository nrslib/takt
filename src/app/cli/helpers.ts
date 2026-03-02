/**
 * CLI helper functions
 *
 * Utility functions for option parsing and task classification.
 */

import type { Command } from 'commander';
import type { TaskExecutionOptions } from '../../features/tasks/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { isIssueReference } from '../../infra/github/index.js';

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
