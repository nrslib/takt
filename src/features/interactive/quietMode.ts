/**
 * Quiet interactive mode.
 *
 * Generates task instructions without asking clarifying questions.
 * Uses the same summarization logic as assistant mode but skips
 * the conversational loop — goes directly to summary generation.
 */

import chalk from 'chalk';
import { createLogger } from '../../shared/utils/index.js';
import { info, error, blankLine } from '../../shared/ui/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { readMultilineInput } from './lineEditor.js';
import {
  type PieceContext,
  type InteractiveModeResult,
  type InteractiveUIText,
  type ConversationMessage,
  DEFAULT_INTERACTIVE_TOOLS,
  buildSummaryPrompt,
  selectPostSummaryAction,
} from './interactive.js';
import {
  initializeSession,
  callAIWithRetry,
} from './conversationLoop.js';

const log = createLogger('quiet-mode');

/**
 * Run quiet mode: collect user input and generate instructions without questions.
 *
 * Flow:
 * 1. If initialInput is provided, use it; otherwise prompt for input
 * 2. Build summary prompt from the user input
 * 3. Call AI to generate task instructions (best-effort, no questions)
 * 4. Present the result and let user choose action
 *
 * @param cwd - Working directory
 * @param initialInput - Pre-filled input (e.g., from issue reference)
 * @param pieceContext - Piece context for template rendering
 * @returns Result with generated task instructions
 */
export async function quietMode(
  cwd: string,
  initialInput?: string,
  pieceContext?: PieceContext,
): Promise<InteractiveModeResult> {
  const ctx = initializeSession(cwd, 'interactive');

  let userInput = initialInput;

  if (!userInput) {
    info(getLabel('interactive.ui.intro', ctx.lang));
    blankLine();

    const input = await readMultilineInput(chalk.green('> '));
    if (input === null) {
      blankLine();
      info(getLabel('interactive.ui.cancelled', ctx.lang));
      return { action: 'cancel', task: '' };
    }
    const trimmed = input.trim();
    if (!trimmed) {
      info(getLabel('interactive.ui.cancelled', ctx.lang));
      return { action: 'cancel', task: '' };
    }
    userInput = trimmed;
  }

  const history: ConversationMessage[] = [
    { role: 'user', content: userInput },
  ];

  const conversationLabel = getLabel('interactive.conversationLabel', ctx.lang);
  const noTranscript = getLabel('interactive.noTranscript', ctx.lang);

  const summaryPrompt = buildSummaryPrompt(
    history, !!ctx.sessionId, ctx.lang, noTranscript, conversationLabel, pieceContext,
  );

  if (!summaryPrompt) {
    info(getLabel('interactive.ui.noConversation', ctx.lang));
    return { action: 'cancel', task: '' };
  }

  const { result } = await callAIWithRetry(
    summaryPrompt, summaryPrompt, DEFAULT_INTERACTIVE_TOOLS, cwd, ctx,
  );

  if (!result) {
    return { action: 'cancel', task: '' };
  }

  if (!result.success) {
    error(result.content);
    blankLine();
    return { action: 'cancel', task: '' };
  }

  const task = result.content.trim();
  const ui = getLabelObject<InteractiveUIText>('interactive.ui', ctx.lang);

  const selectedAction = await selectPostSummaryAction(task, ui.proposed, ui);
  if (selectedAction === 'continue' || selectedAction === null) {
    return { action: 'cancel', task: '' };
  }

  log.info('Quiet mode action selected', { action: selectedAction });
  return { action: selectedAction, task };
}
