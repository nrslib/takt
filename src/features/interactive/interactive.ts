/**
 * Interactive task input mode
 *
 * Allows users to refine task requirements through conversation with AI
 * before executing the task. Uses the same SDK call pattern as piece
 * execution (with onStream) to ensure compatibility.
 *
 * Commands:
 *   /go     - Confirm and execute the task
 *   /cancel - Cancel and exit
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import type { Language } from '../../core/models/index.js';
import { loadGlobalConfig, loadAgentSessions, updateAgentSession } from '../../infra/config/index.js';
import { isQuietMode } from '../../shared/context.js';
import { getProvider, type ProviderType } from '../../infra/providers/index.js';
import { selectOption } from '../../shared/prompt/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { info, error, blankLine, StreamDisplay } from '../../shared/ui/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
const log = createLogger('interactive');

/** Shape of interactive UI text */
interface InteractiveUIText {
  intro: string;
  resume: string;
  noConversation: string;
  summarizeFailed: string;
  continuePrompt: string;
  proposed: string;
  confirm: string;
  cancelled: string;
}

function resolveLanguage(lang?: Language): 'en' | 'ja' {
  return lang === 'ja' ? 'ja' : 'en';
}

function getInteractivePrompts(lang: 'en' | 'ja', pieceContext?: PieceContext) {
  const hasPiece = !!pieceContext;

  const systemPrompt = loadTemplate('score_interactive_system_prompt', lang, {
    pieceInfo: hasPiece,
    pieceName: pieceContext?.name ?? '',
    pieceDescription: pieceContext?.description ?? '',
  });

  return {
    systemPrompt,
    lang,
    pieceContext,
    conversationLabel: getLabel('interactive.conversationLabel', lang),
    noTranscript: getLabel('interactive.noTranscript', lang),
    ui: getLabelObject<InteractiveUIText>('interactive.ui', lang),
  };
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface CallAIResult {
  content: string;
  sessionId?: string;
  success: boolean;
}

/**
 * Build the final task description from conversation history for executeTask.
 */
function buildTaskFromHistory(history: ConversationMessage[]): string {
  return history
    .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
}

/**
 * Build the summary prompt (used as both system prompt and user message).
 * Renders the complete score_summary_system_prompt template with conversation data.
 * Returns empty string if there is no conversation to summarize.
 */
function buildSummaryPrompt(
  history: ConversationMessage[],
  hasSession: boolean,
  lang: 'en' | 'ja',
  noTranscriptNote: string,
  conversationLabel: string,
  pieceContext?: PieceContext,
): string {
  let conversation = '';
  if (history.length > 0) {
    const historyText = buildTaskFromHistory(history);
    conversation = `${conversationLabel}\n${historyText}`;
  } else if (hasSession) {
    conversation = `${conversationLabel}\n${noTranscriptNote}`;
  } else {
    return '';
  }

  const hasPiece = !!pieceContext;
  return loadTemplate('score_summary_system_prompt', lang, {
    pieceInfo: hasPiece,
    pieceName: pieceContext?.name ?? '',
    pieceDescription: pieceContext?.description ?? '',
    conversation,
  });
}

async function confirmTask(task: string, message: string, confirmLabel: string, yesLabel: string, noLabel: string): Promise<boolean> {
  blankLine();
  info(message);
  console.log(task);
  const decision = await selectOption(confirmLabel, [
    { label: yesLabel, value: 'yes' },
    { label: noLabel, value: 'no' },
  ]);
  return decision === 'yes';
}

/**
 * Read a single line of input from the user.
 * Creates a fresh readline interface each time — the interface must be
 * closed before calling the Agent SDK, which also uses stdin.
 * Returns null on EOF (Ctrl+D).
 */
function readLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.stdin.readable && !process.stdin.destroyed) {
      process.stdin.resume();
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let answered = false;

    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });

    rl.on('close', () => {
      if (!answered) {
        resolve(null);
      }
    });
  });
}

/**
 * Call AI with the same pattern as piece execution.
 * The key requirement is passing onStream — the Agent SDK requires
 * includePartialMessages to be true for the async iterator to yield.
 */
async function callAI(
  provider: ReturnType<typeof getProvider>,
  prompt: string,
  cwd: string,
  model: string | undefined,
  sessionId: string | undefined,
  display: StreamDisplay,
  systemPrompt: string,
): Promise<CallAIResult> {
  const response = await provider.call('interactive', prompt, {
    cwd,
    model,
    sessionId,
    systemPrompt,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
    onStream: display.createHandler(),
  });

  display.flush();
  const success = response.status !== 'blocked';
  return { content: response.content, sessionId: response.sessionId, success };
}

export interface InteractiveModeResult {
  /** Whether the user confirmed with /go */
  confirmed: boolean;
  /** The assembled task text (only meaningful when confirmed=true) */
  task: string;
}

export interface PieceContext {
  /** Piece name (e.g. "minimal") */
  name: string;
  /** Piece description */
  description: string;
}

/**
 * Run the interactive task input mode.
 *
 * Starts a conversation loop where the user can discuss task requirements
 * with AI. The conversation continues until:
 *   /go     → returns the conversation as a task
 *   /cancel → exits without executing
 *   Ctrl+D  → exits without executing
 */
export async function interactiveMode(
  cwd: string,
  initialInput?: string,
  pieceContext?: PieceContext,
): Promise<InteractiveModeResult> {
  const globalConfig = loadGlobalConfig();
  const lang = resolveLanguage(globalConfig.language);
  const prompts = getInteractivePrompts(lang, pieceContext);
  if (!globalConfig.provider) {
    throw new Error('Provider is not configured.');
  }
  const providerType = globalConfig.provider as ProviderType;
  const provider = getProvider(providerType);
  const model = (globalConfig.model as string | undefined);

  const history: ConversationMessage[] = [];
  const agentName = 'interactive';
  const savedSessions = loadAgentSessions(cwd, providerType);
  let sessionId: string | undefined = savedSessions[agentName];

  info(prompts.ui.intro);
  if (sessionId) {
    info(prompts.ui.resume);
  }
  blankLine();

  /** Call AI with automatic retry on session error (stale/invalid session ID). */
  async function callAIWithRetry(prompt: string, systemPrompt: string): Promise<CallAIResult | null> {
    const display = new StreamDisplay('assistant', isQuietMode());
    try {
      const result = await callAI(
        provider,
        prompt,
        cwd,
        model,
        sessionId,
        display,
        systemPrompt,
      );
      // If session failed, clear it and retry without session
      if (!result.success && sessionId) {
        log.info('Session invalid, retrying without session');
        sessionId = undefined;
        const retryDisplay = new StreamDisplay('assistant', isQuietMode());
        const retry = await callAI(
          provider,
          prompt,
          cwd,
          model,
          undefined,
          retryDisplay,
          systemPrompt,
        );
        if (retry.sessionId) {
          sessionId = retry.sessionId;
          updateAgentSession(cwd, agentName, sessionId, providerType);
        }
        return retry;
      }
      if (result.sessionId) {
        sessionId = result.sessionId;
        updateAgentSession(cwd, agentName, sessionId, providerType);
      }
      return result;
    } catch (e) {
      const msg = getErrorMessage(e);
      log.error('AI call failed', { error: msg });
      error(msg);
      blankLine();
      return null;
    }
  }

  // Process initial input if provided (e.g. from `takt a`)
  if (initialInput) {
    history.push({ role: 'user', content: initialInput });
    log.debug('Processing initial input', { initialInput, sessionId });

    const result = await callAIWithRetry(initialInput, prompts.systemPrompt);
    if (result) {
      if (!result.success) {
        error(result.content);
        blankLine();
        return { confirmed: false, task: '' };
      }
      history.push({ role: 'assistant', content: result.content });
      blankLine();
    } else {
      history.pop();
    }
  }

  while (true) {
    const input = await readLine(chalk.green('> '));

    // EOF (Ctrl+D)
    if (input === null) {
      blankLine();
      info('Cancelled');
      return { confirmed: false, task: '' };
    }

    const trimmed = input.trim();

    // Empty input — skip
    if (!trimmed) {
      continue;
    }

    // Handle slash commands
    if (trimmed.startsWith('/go')) {
      const userNote = trimmed.slice(3).trim();
      let summaryPrompt = buildSummaryPrompt(
        history,
        !!sessionId,
        prompts.lang,
        prompts.noTranscript,
        prompts.conversationLabel,
        prompts.pieceContext,
      );
      if (!summaryPrompt) {
        info(prompts.ui.noConversation);
        continue;
      }
      if (userNote) {
        summaryPrompt = `${summaryPrompt}\n\nUser Note:\n${userNote}`;
      }
      const summaryResult = await callAIWithRetry(summaryPrompt, summaryPrompt);
      if (!summaryResult) {
        info(prompts.ui.summarizeFailed);
        continue;
      }
      if (!summaryResult.success) {
        error(summaryResult.content);
        blankLine();
        return { confirmed: false, task: '' };
      }
      const task = summaryResult.content.trim();
      const confirmed = await confirmTask(
        task,
        prompts.ui.proposed,
        prompts.ui.confirm,
        lang === 'ja' ? 'はい' : 'Yes',
        lang === 'ja' ? 'いいえ' : 'No',
      );
      if (!confirmed) {
        info(prompts.ui.continuePrompt);
        continue;
      }
      log.info('Interactive mode confirmed', { messageCount: history.length });
      return { confirmed: true, task };
    }

    if (trimmed === '/cancel') {
      info(prompts.ui.cancelled);
      return { confirmed: false, task: '' };
    }

    // Regular input — send to AI
    // readline is already closed at this point, so stdin is free for SDK
    history.push({ role: 'user', content: trimmed });

    log.debug('Sending to AI', { messageCount: history.length, sessionId });
    process.stdin.pause();

    const result = await callAIWithRetry(trimmed, prompts.systemPrompt);
    if (result) {
      if (!result.success) {
        error(result.content);
        blankLine();
        history.pop();
        return { confirmed: false, task: '' };
      }
      history.push({ role: 'assistant', content: result.content });
      blankLine();
    } else {
      history.pop();
    }
  }
}
