/**
 * Error and deny handler for AskUserQuestion blocking.
 *
 * Lives in core/piece/ because it is used by multiple provider adapters
 * (claude, opencode) — keeping it provider-neutral avoids cross-infra
 * runtime dependencies.
 */

import type { AskUserQuestionHandler } from './types.js';

const DENY_MESSAGE =
  'AskUserQuestion is not available in non-interactive mode. Present your questions directly as text output and wait for the user to respond.';

/**
 * Thrown by the deny handler to signal that AskUserQuestion should be
 * blocked rather than retried. Caught by SdkOptionsBuilder to return
 * `decision: 'block'`.
 */
export class AskUserQuestionDeniedError extends Error {
  constructor() {
    super(DENY_MESSAGE);
    this.name = 'AskUserQuestionDeniedError';
  }
}

/**
 * Create a handler that always denies AskUserQuestion.
 *
 * Used during piece execution to prevent user interaction —
 * the thrown error is caught by SdkOptionsBuilder and converted
 * to `decision: 'block'`, prompting the AI to proceed on its own.
 */
export function createDenyAskUserQuestionHandler(): AskUserQuestionHandler {
  return (): never => {
    throw new AskUserQuestionDeniedError();
  };
}
