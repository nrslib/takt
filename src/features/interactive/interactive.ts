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

import chalk from 'chalk';
import type { Language } from '../../core/models/index.js';
import {
  loadGlobalConfig,
  loadPersonaSessions,
  updatePersonaSession,
  loadSessionState,
  clearSessionState,
  type SessionState,
  type MovementPreview,
} from '../../infra/config/index.js';
import { isQuietMode } from '../../shared/context.js';
import { getProvider, type ProviderType } from '../../infra/providers/index.js';
import { selectOption } from '../../shared/prompt/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { info, error, blankLine, StreamDisplay } from '../../shared/ui/index.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { readMultilineInput } from './lineEditor.js';
const log = createLogger('interactive');

/** Shape of interactive UI text */
interface InteractiveUIText {
  intro: string;
  resume: string;
  noConversation: string;
  summarizeFailed: string;
  continuePrompt: string;
  proposed: string;
  actionPrompt: string;
  actions: {
    execute: string;
    createIssue: string;
    saveTask: string;
    continue: string;
  };
  cancelled: string;
  playNoTask: string;
}

/**
 * Format session state for display
 */
function formatSessionStatus(state: SessionState, lang: 'en' | 'ja'): string {
  const lines: string[] = [];

  // Status line
  if (state.status === 'success') {
    lines.push(getLabel('interactive.previousTask.success', lang));
  } else if (state.status === 'error') {
    lines.push(
      getLabel('interactive.previousTask.error', lang, {
        error: state.errorMessage!,
      })
    );
  } else if (state.status === 'user_stopped') {
    lines.push(getLabel('interactive.previousTask.userStopped', lang));
  }

  // Piece name
  lines.push(
    getLabel('interactive.previousTask.piece', lang, {
      pieceName: state.pieceName,
    })
  );

  // Timestamp
  const timestamp = new Date(state.timestamp).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US');
  lines.push(
    getLabel('interactive.previousTask.timestamp', lang, {
      timestamp,
    })
  );

  return lines.join('\n');
}

function resolveLanguage(lang?: Language): 'en' | 'ja' {
  return lang === 'ja' ? 'ja' : 'en';
}

/**
 * Format MovementPreview[] into a Markdown string for template injection.
 * Each movement is rendered with its persona and instruction content.
 */
export function formatMovementPreviews(previews: MovementPreview[], lang: 'en' | 'ja'): string {
  return previews.map((p, i) => {
    const toolsStr = p.allowedTools.length > 0
      ? p.allowedTools.join(', ')
      : (lang === 'ja' ? 'なし' : 'None');
    const editStr = p.canEdit
      ? (lang === 'ja' ? '可' : 'Yes')
      : (lang === 'ja' ? '不可' : 'No');
    const personaLabel = lang === 'ja' ? 'ペルソナ' : 'Persona';
    const instructionLabel = lang === 'ja' ? 'インストラクション' : 'Instruction';
    const toolsLabel = lang === 'ja' ? 'ツール' : 'Tools';
    const editLabel = lang === 'ja' ? '編集' : 'Edit';

    const lines = [
      `### ${i + 1}. ${p.name} (${p.personaDisplayName})`,
    ];
    if (p.personaContent) {
      lines.push(`**${personaLabel}:**`, p.personaContent);
    }
    if (p.instructionContent) {
      lines.push(`**${instructionLabel}:**`, p.instructionContent);
    }
    lines.push(`**${toolsLabel}:** ${toolsStr}`, `**${editLabel}:** ${editStr}`);
    return lines.join('\n');
  }).join('\n\n');
}

function getInteractivePrompts(lang: 'en' | 'ja', pieceContext?: PieceContext) {
  const hasPreview = !!pieceContext?.movementPreviews?.length;
  const systemPrompt = loadTemplate('score_interactive_system_prompt', lang, {
    hasPiecePreview: hasPreview,
    pieceStructure: pieceContext?.pieceStructure ?? '',
    movementDetails: hasPreview ? formatMovementPreviews(pieceContext!.movementPreviews!, lang) : '',
  });
  const policyContent = loadTemplate('score_interactive_policy', lang, {});

  return {
    systemPrompt,
    policyContent,
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
  const hasPreview = !!pieceContext?.movementPreviews?.length;
  const summaryMovementDetails = hasPreview
    ? `\n### ${lang === 'ja' ? '処理するエージェント' : 'Processing Agents'}\n${formatMovementPreviews(pieceContext!.movementPreviews!, lang)}`
    : '';
  return loadTemplate('score_summary_system_prompt', lang, {
    pieceInfo: hasPiece,
    pieceName: pieceContext?.name ?? '',
    pieceDescription: pieceContext?.description ?? '',
    movementDetails: summaryMovementDetails,
    conversation,
  });
}

type PostSummaryAction = InteractiveModeAction | 'continue';

async function selectPostSummaryAction(
  task: string,
  proposedLabel: string,
  ui: InteractiveUIText,
): Promise<PostSummaryAction | null> {
  blankLine();
  info(proposedLabel);
  console.log(task);

  return selectOption<PostSummaryAction>(ui.actionPrompt, [
    { label: ui.actions.execute, value: 'execute' },
    { label: ui.actions.createIssue, value: 'create_issue' },
    { label: ui.actions.saveTask, value: 'save_task' },
    { label: ui.actions.continue, value: 'continue' },
  ]);
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
  const agent = provider.setup({ name: 'interactive', systemPrompt });
  const response = await agent.call(prompt, {
    cwd,
    model,
    sessionId,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
    onStream: display.createHandler(),
  });

  display.flush();
  const success = response.status !== 'blocked';
  return { content: response.content, sessionId: response.sessionId, success };
}

export type InteractiveModeAction = 'execute' | 'save_task' | 'create_issue' | 'cancel';

export interface InteractiveModeResult {
  /** The action selected by the user */
  action: InteractiveModeAction;
  /** The assembled task text (only meaningful when action is not 'cancel') */
  task: string;
}

export interface PieceContext {
  /** Piece name (e.g. "minimal") */
  name: string;
  /** Piece description */
  description: string;
  /** Piece structure (numbered list of movements) */
  pieceStructure: string;
  /** Movement previews (persona + instruction content for first N movements) */
  movementPreviews?: MovementPreview[];
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
  const personaName = 'interactive';
  const savedSessions = loadPersonaSessions(cwd, providerType);
  let sessionId: string | undefined = savedSessions[personaName];

  // Load and display previous task state
  const sessionState = loadSessionState(cwd);
  if (sessionState) {
    const statusLabel = formatSessionStatus(sessionState, lang);
    info(statusLabel);
    blankLine();
    clearSessionState(cwd);
  }

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
          updatePersonaSession(cwd, personaName, sessionId, providerType);
        }
        return retry;
      }
      if (result.sessionId) {
        sessionId = result.sessionId;
        updatePersonaSession(cwd, personaName, sessionId, providerType);
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

  /**
   * Inject policy into user message for AI call.
   * Follows the same pattern as piece execution (perform_phase1_message.md).
   */
  function injectPolicy(userMessage: string): string {
    const policyIntro = lang === 'ja'
      ? '以下のポリシーは行動規範です。必ず遵守してください。'
      : 'The following policy defines behavioral guidelines. Please follow them.';
    const reminderLabel = lang === 'ja'
      ? '上記の Policy セクションで定義されたポリシー規範を遵守してください。'
      : 'Please follow the policy guidelines defined in the Policy section above.';
    return `## Policy\n${policyIntro}\n\n${prompts.policyContent}\n\n---\n\n${userMessage}\n\n---\n**Policy Reminder:** ${reminderLabel}`;
  }

  // Process initial input if provided (e.g. from `takt a`)
  if (initialInput) {
    history.push({ role: 'user', content: initialInput });
    log.debug('Processing initial input', { initialInput, sessionId });

    const promptWithPolicy = injectPolicy(initialInput);
    const result = await callAIWithRetry(promptWithPolicy, prompts.systemPrompt);
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

    // EOF (Ctrl+D)
    if (input === null) {
      blankLine();
      info('Cancelled');
      return { action: 'cancel', task: '' };
    }

    const trimmed = input.trim();

    // Empty input — skip
    if (!trimmed) {
      continue;
    }

    // Handle slash commands
    if (trimmed.startsWith('/play')) {
      const task = trimmed.slice(5).trim();
      if (!task) {
        info(prompts.ui.playNoTask);
        continue;
      }
      log.info('Play command', { task });
      return { action: 'execute', task };
    }

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
        return { action: 'cancel', task: '' };
      }
      const task = summaryResult.content.trim();
      const selectedAction = await selectPostSummaryAction(task, prompts.ui.proposed, prompts.ui);
      if (selectedAction === 'continue' || selectedAction === null) {
        info(prompts.ui.continuePrompt);
        continue;
      }
      log.info('Interactive mode action selected', { action: selectedAction, messageCount: history.length });
      return { action: selectedAction, task };
    }

    if (trimmed === '/cancel') {
      info(prompts.ui.cancelled);
      return { action: 'cancel', task: '' };
    }

    // Regular input — send to AI
    history.push({ role: 'user', content: trimmed });

    log.debug('Sending to AI', { messageCount: history.length, sessionId });
    process.stdin.pause();

    const promptWithPolicy = injectPolicy(trimmed);
    const result = await callAIWithRetry(promptWithPolicy, prompts.systemPrompt);
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
