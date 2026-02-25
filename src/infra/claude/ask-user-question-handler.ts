/**
 * AskUserQuestion handler factory.
 *
 * Returns the appropriate handler based on TTY availability:
 * - TTY → interactive terminal UI (select / text input)
 * - No TTY → immediately denies so the AI falls back to plain text
 */

import { resolveTtyPolicy } from '../../shared/prompt/tty.js';
import type { AskUserQuestionHandler } from './types.js';
import { createTtyAskUserQuestionHandler } from './ask-user-question-tty.js';
import { createDenyAskUserQuestionHandler } from '../../core/piece/ask-user-question-error.js';

export { AskUserQuestionDeniedError } from '../../core/piece/ask-user-question-error.js';

/**
 * Create an AskUserQuestion handler based on TTY availability.
 *
 * - TTY available → returns interactive terminal UI handler
 * - No TTY → returns a deny handler (throws `AskUserQuestionDeniedError`)
 */
export function createAskUserQuestionHandler(): AskUserQuestionHandler {
  const { useTty } = resolveTtyPolicy();
  if (useTty) {
    return createTtyAskUserQuestionHandler();
  }
  return createDenyAskUserQuestionHandler();
}
