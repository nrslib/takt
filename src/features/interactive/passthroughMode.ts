/**
 * Passthrough interactive mode.
 *
 * Passes user input directly as the task string without any
 * AI-assisted instruction generation or system prompt injection.
 */

import chalk from 'chalk';
import { info, blankLine } from '../../shared/ui/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { readPipedLine } from './lineEditor.js';
import type { InteractiveModeResult } from './interactive.js';

/**
 * Run passthrough mode: collect user input and return it as-is.
 *
 * If initialInput is provided, it is used directly as the task.
 * Otherwise, prompts the user for input.
 *
 * @param _cwd - The project, which this mode has no use for: it neither reads
 *   configuration nor stores anything. Kept so every interactive entry point is
 *   called the same way.
 * @param lang - Display language
 * @param initialInput - Pre-filled input (e.g., from issue reference)
 * @returns Result with the raw user input as task
 */
export async function passthroughMode(
  _cwd: string,
  lang: 'en' | 'ja',
  initialInput?: string,
): Promise<InteractiveModeResult> {
  if (initialInput) {
    return { action: 'execute', task: initialInput };
  }

  info(getLabel('interactive.ui.introPassthrough', lang));
  blankLine();

  // Piped input carries no paste gestures — a terminal takes the TUI instead —
  // so there is no image store here and nothing to clean up.
  const input = await readPipedLine(chalk.green('> '));

  if (input === null) {
    blankLine();
    info(getLabel('interactive.ui.cancelled', lang));
    return { action: 'cancel', task: '' };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    info(getLabel('interactive.ui.cancelled', lang));
    return { action: 'cancel', task: '' };
  }

  return { action: 'execute', task: trimmed };
}
