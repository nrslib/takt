/**
 * Persona interactive mode.
 *
 * Uses the first movement's persona and tools for the interactive
 * conversation. The persona acts as the conversational agent,
 * performing code exploration and analysis while discussing the task.
 * The conversation result is passed as the task to the piece.
 */

import type { FirstMovementInfo } from '../../infra/config/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import {
  type PieceContext,
  type InteractiveModeResult,
  DEFAULT_INTERACTIVE_TOOLS,
} from './interactive.js';
import {
  initializeSession,
  displayAndClearSessionState,
  runConversationLoop,
} from './conversationLoop.js';

/**
 * Run persona mode: converse as the first movement's persona.
 *
 * The persona's system prompt is used for all AI calls.
 * The first movement's allowed tools are made available.
 * After the conversation, the result is summarized as a task.
 *
 * @param cwd - Working directory
 * @param firstMovement - First movement's persona and tool info
 * @param initialInput - Pre-filled input
 * @param pieceContext - Piece context for summary generation
 * @returns Result with conversation-derived task
 */
export async function personaMode(
  cwd: string,
  firstMovement: FirstMovementInfo,
  initialInput?: string,
  pieceContext?: PieceContext,
): Promise<InteractiveModeResult> {
  const ctx = initializeSession(cwd, 'persona-interactive');

  displayAndClearSessionState(cwd, ctx.lang);

  const allowedTools = firstMovement.allowedTools.length > 0
    ? firstMovement.allowedTools
    : DEFAULT_INTERACTIVE_TOOLS;

  const introMessage = `${getLabel('interactive.ui.intro', ctx.lang)} [${firstMovement.personaDisplayName}]`;

  return runConversationLoop(cwd, ctx, {
    systemPrompt: firstMovement.personaContent,
    allowedTools,
    transformPrompt: (msg) => msg,
    introMessage,
  }, pieceContext, initialInput);
}
