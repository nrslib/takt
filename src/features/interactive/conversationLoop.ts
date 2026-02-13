/**
 * Shared conversation loop for interactive modes (assistant & persona).
 *
 * Extracts the common patterns:
 * - Provider/session initialization
 * - AI call with retry on stale session
 * - Session state display/clear
 * - Conversation loop (slash commands, AI messaging, /go summary)
 */

import chalk from 'chalk';
import {
  loadGlobalConfig,
  loadPersonaSessions,
  updatePersonaSession,
  loadSessionState,
  clearSessionState,
} from '../../infra/config/index.js';
import { isQuietMode } from '../../shared/context.js';
import { getProvider, type ProviderType } from '../../infra/providers/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { info, error, blankLine, StreamDisplay } from '../../shared/ui/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { readMultilineInput } from './lineEditor.js';
import { EXIT_SIGINT } from '../../shared/exitCodes.js';
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

const log = createLogger('conversation-loop');

/** Result from a single AI call */
export interface CallAIResult {
  content: string;
  sessionId?: string;
  success: boolean;
}

/** Initialized session context for conversation loops */
export interface SessionContext {
  provider: ReturnType<typeof getProvider>;
  providerType: ProviderType;
  model: string | undefined;
  lang: 'en' | 'ja';
  personaName: string;
  sessionId: string | undefined;
}

/**
 * Initialize provider, session, and language for interactive conversation.
 */
export function initializeSession(cwd: string, personaName: string): SessionContext {
  const globalConfig = loadGlobalConfig();
  const lang = resolveLanguage(globalConfig.language);
  if (!globalConfig.provider) {
    throw new Error('Provider is not configured.');
  }
  const providerType = globalConfig.provider as ProviderType;
  const provider = getProvider(providerType);
  const model = globalConfig.model as string | undefined;
  const savedSessions = loadPersonaSessions(cwd, providerType);
  const sessionId: string | undefined = savedSessions[personaName];

  return { provider, providerType, model, lang, personaName, sessionId };
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

/**
 * Call AI with automatic retry on stale/invalid session.
 *
 * On session failure, clears sessionId and retries once without session.
 * Updates sessionId and persists it on success.
 */
export async function callAIWithRetry(
  prompt: string,
  systemPrompt: string,
  allowedTools: string[],
  cwd: string,
  ctx: SessionContext,
): Promise<{ result: CallAIResult | null; sessionId: string | undefined }> {
  const display = new StreamDisplay('assistant', isQuietMode());
  const abortController = new AbortController();
  let sigintCount = 0;
  const onSigInt = (): void => {
    sigintCount += 1;
    if (sigintCount === 1) {
      blankLine();
      info(getLabel('piece.sigintGraceful', ctx.lang));
      abortController.abort();
      return;
    }
    blankLine();
    error(getLabel('piece.sigintForce', ctx.lang));
    process.exit(EXIT_SIGINT);
  };
  process.on('SIGINT', onSigInt);
  let { sessionId } = ctx;

  try {
    const agent = ctx.provider.setup({ name: ctx.personaName, systemPrompt });
    const response = await agent.call(prompt, {
      cwd,
      model: ctx.model,
      sessionId,
      allowedTools,
      abortSignal: abortController.signal,
      onStream: display.createHandler(),
    });
    display.flush();
    const success = response.status !== 'blocked' && response.status !== 'error';

    if (!success && sessionId) {
      log.info('Session invalid, retrying without session');
      sessionId = undefined;
      const retryDisplay = new StreamDisplay('assistant', isQuietMode());
      const retryAgent = ctx.provider.setup({ name: ctx.personaName, systemPrompt });
      const retry = await retryAgent.call(prompt, {
        cwd,
        model: ctx.model,
        sessionId: undefined,
        allowedTools,
        abortSignal: abortController.signal,
        onStream: retryDisplay.createHandler(),
      });
      retryDisplay.flush();
      if (retry.sessionId) {
        sessionId = retry.sessionId;
        updatePersonaSession(cwd, ctx.personaName, sessionId, ctx.providerType);
      }
      return {
        result: { content: retry.content, sessionId: retry.sessionId, success: retry.status !== 'blocked' && retry.status !== 'error' },
        sessionId,
      };
    }

    if (response.sessionId) {
      sessionId = response.sessionId;
      updatePersonaSession(cwd, ctx.personaName, sessionId, ctx.providerType);
    }
    return {
      result: { content: response.content, sessionId: response.sessionId, success },
      sessionId,
    };
  } catch (e) {
    const msg = getErrorMessage(e);
    log.error('AI call failed', { error: msg });
    error(msg);
    blankLine();
    return { result: null, sessionId };
  } finally {
    process.removeListener('SIGINT', onSigInt);
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
}

/**
 * Run the shared conversation loop.
 *
 * Handles: EOF, /play, /go (summary), /cancel, regular AI messaging.
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

    if (trimmed === '/cancel') {
      info(ui.cancelled);
      return { action: 'cancel', task: '' };
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
