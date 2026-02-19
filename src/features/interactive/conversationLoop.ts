/**
 * Shared conversation loop for interactive modes (assistant & persona).
 *
 * Extracts the common patterns:
 * - Provider/session initialization
 * - Session state display/clear
 * - Conversation loop (slash commands, AI messaging, /go summary)
 */

import chalk from 'chalk';
import {
  resolveConfigValues,
  loadSessionState,
  clearSessionState,
} from '../../infra/config/index.js';
import { getProvider, type ProviderType } from '../../infra/providers/index.js';
import { createLogger } from '../../shared/utils/index.js';
import { info, error, blankLine } from '../../shared/ui/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { readMultilineInput } from './lineEditor.js';
import { selectRecentSession } from './sessionSelector.js';
import {
  type PieceContext,
  type InteractiveModeResult,
  type InteractiveUIText,
  type ConversationMessage,
  type PostSummaryAction,
  resolveLanguage,
  buildSummaryPrompt,
  selectPostSummaryAction,
  formatSessionStatus,
} from './interactive.js';
import { callAIWithRetry, type CallAIResult, type SessionContext } from './aiCaller.js';

export { type CallAIResult, type SessionContext, callAIWithRetry } from './aiCaller.js';

const log = createLogger('conversation-loop');

/**
 * Initialize provider and language for interactive conversation.
 *
 * Session ID is always undefined (new session).
 * Callers that need session continuity pass sessionId explicitly
 * (e.g., --continue flag or /resume command).
 */
export function initializeSession(cwd: string, personaName: string): SessionContext {
  const globalConfig = resolveConfigValues(cwd, ['language', 'provider', 'model']);
  const lang = resolveLanguage(globalConfig.language);
  if (!globalConfig.provider) {
    throw new Error('Provider is not configured.');
  }
  const providerType = globalConfig.provider as ProviderType;
  const provider = getProvider(providerType);
  const model = globalConfig.model as string | undefined;

  return { provider, providerType, model, lang, personaName, sessionId: undefined };
}

/**
 * Display and clear previous session state if present.
 */
export function displayAndClearSessionState(cwd: string, lang: 'en' | 'ja'): void {
  const sessionState = loadSessionState(cwd);
  if (sessionState) {
    const statusLabel = formatSessionStatus(sessionState, lang);
    info(statusLabel);
    blankLine();
    clearSessionState(cwd);
  }
}

export type { PostSummaryAction } from './interactive.js';

/** Strategy for customizing conversation loop behavior */
export interface ConversationStrategy {
  /** System prompt for AI calls */
  systemPrompt: string;
  /** Allowed tools for AI calls */
  allowedTools: string[];
  /** Transform user message before sending to AI (e.g., policy injection) */
  transformPrompt: (userMessage: string) => string;
  /** Intro message displayed at start */
  introMessage: string;
  /** Custom action selector (optional). If not provided, uses default selectPostSummaryAction. */
  selectAction?: (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null>;
  /** Previous order.md content for /replay command (retry/instruct only) */
  previousOrderContent?: string;
}

/**
 * Run the shared conversation loop.
 *
 * Handles: EOF, /play, /retry, /go (summary), /cancel, regular AI messaging.
 * The Strategy object controls system prompt, tool access, and prompt transformation.
 */
export async function runConversationLoop(
  cwd: string,
  ctx: SessionContext,
  strategy: ConversationStrategy,
  pieceContext: PieceContext | undefined,
  initialInput: string | undefined,
): Promise<InteractiveModeResult> {
  const history: ConversationMessage[] = [];
  let sessionId = ctx.sessionId;
  const ui = getLabelObject<InteractiveUIText>('interactive.ui', ctx.lang);
  const conversationLabel = getLabel('interactive.conversationLabel', ctx.lang);
  const noTranscript = getLabel('interactive.noTranscript', ctx.lang);

  info(strategy.introMessage);
  if (sessionId) {
    info(ui.resume);
  }
  blankLine();

  /** Helper: call AI with current session and update session state */
  async function doCallAI(prompt: string, sysPrompt: string, tools: string[]): Promise<CallAIResult | null> {
    const { result, sessionId: newSessionId } = await callAIWithRetry(
      prompt, sysPrompt, tools, cwd, { ...ctx, sessionId },
    );
    sessionId = newSessionId;
    return result;
  }

  if (initialInput) {
    history.push({ role: 'user', content: initialInput });
    log.debug('Processing initial input', { initialInput, sessionId });

    const promptWithTransform = strategy.transformPrompt(initialInput);
    const result = await doCallAI(promptWithTransform, strategy.systemPrompt, strategy.allowedTools);
    if (result) {
      if (!result.success) {
        error(result.content);
        blankLine();
        return { action: 'cancel', task: '' };
      }
      history.push({ role: 'assistant', content: result.content });
      blankLine();
    } else {
      history.pop();
    }
  }

  while (true) {
    const input = await readMultilineInput(chalk.green('> '));

    if (input === null) {
      blankLine();
      info(ui.cancelled);
      return { action: 'cancel', task: '' };
    }

    const trimmed = input.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('/play')) {
      const task = trimmed.slice(5).trim();
      if (!task) {
        info(ui.playNoTask);
        continue;
      }
      log.info('Play command', { task });
      return { action: 'execute', task };
    }

    if (trimmed === '/retry') {
      if (!strategy.previousOrderContent) {
        info(ui.retryNoOrder);
        continue;
      }
      log.info('Retry command — resubmitting previous order.md');
      return { action: 'execute', task: strategy.previousOrderContent };
    }

    if (trimmed.startsWith('/go')) {
      const userNote = trimmed.slice(3).trim();
      let summaryPrompt = buildSummaryPrompt(
        history, !!sessionId, ctx.lang, noTranscript, conversationLabel, pieceContext,
      );
      if (!summaryPrompt) {
        info(ui.noConversation);
        continue;
      }
      if (userNote) {
        summaryPrompt = `${summaryPrompt}\n\nUser Note:\n${userNote}`;
      }
      const summaryResult = await doCallAI(summaryPrompt, summaryPrompt, strategy.allowedTools);
      if (!summaryResult) {
        info(ui.summarizeFailed);
        continue;
      }
      if (!summaryResult.success) {
        error(summaryResult.content);
        blankLine();
        return { action: 'cancel', task: '' };
      }
      const task = summaryResult.content.trim();
      const selectedAction = strategy.selectAction
        ? await strategy.selectAction(task, ctx.lang)
        : await selectPostSummaryAction(task, ui.proposed, ui);
      if (selectedAction === 'continue' || selectedAction === null) {
        info(ui.continuePrompt);
        continue;
      }
      log.info('Conversation action selected', { action: selectedAction, messageCount: history.length });
      return { action: selectedAction, task };
    }

    if (trimmed === '/replay') {
      if (!strategy.previousOrderContent) {
        const replayNoOrder = getLabel('instruct.ui.replayNoOrder', ctx.lang);
        info(replayNoOrder);
        continue;
      }
      log.info('Replay command');
      return { action: 'execute', task: strategy.previousOrderContent };
    }

    if (trimmed === '/cancel') {
      info(ui.cancelled);
      return { action: 'cancel', task: '' };
    }

    if (trimmed === '/resume') {
      const selectedId = await selectRecentSession(cwd, ctx.lang);
      if (selectedId) {
        sessionId = selectedId;
        info(getLabel('interactive.resumeSessionLoaded', ctx.lang));
      }
      continue;
    }

    history.push({ role: 'user', content: trimmed });
    log.debug('Sending to AI', { messageCount: history.length, sessionId });
    process.stdin.pause();

    const promptWithTransform = strategy.transformPrompt(trimmed);
    const result = await doCallAI(promptWithTransform, strategy.systemPrompt, strategy.allowedTools);
    if (result) {
      if (!result.success) {
        error(result.content);
        blankLine();
        history.pop();
        return { action: 'cancel', task: '' };
      }
      history.push({ role: 'assistant', content: result.content });
      blankLine();
    } else {
      history.pop();
    }
  }
}
