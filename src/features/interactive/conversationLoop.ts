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
  takeSessionState,
} from '../../infra/config/index.js';
import { createLogger, sanitizeTerminalText } from '../../shared/utils/index.js';
import { info, error, blankLine } from '../../shared/ui/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { readPipedLine } from './lineEditor.js';
import { selectRecentSession } from './sessionSelector.js';
import { matchSlashCommand } from './commandMatcher.js';
import type { CommandAvailability } from './slashCommandRegistry.js';
import { SlashCommand } from '../../shared/constants.js';
import {
  type WorkflowContext,
  type InteractiveModeResult,
  type InteractiveUIText,
  type ConversationMessage,
  type InteractiveSeedInput,
  type PostSummaryAction,
  buildSummaryPrompt,
  selectPostSummaryAction,
  formatSessionStatus,
} from './interactive.js';
import { callAIWithRetry, type CallAIResult, type SessionContext } from './aiCaller.js';
import {
  createInputLogMeta,
  createSessionLogMeta,
} from './conversationLogMeta.js';
import { resolvePreviousOrder } from './conversationPlan.js';
import { prependInitialPromptContext } from './promptSections.js';
import type { PermissionMode } from '../../core/models/index.js';
import {
  buildInteractiveResultWithAttachments,
  cleanupImageAttachmentStore,
  createSessionImageAttachmentStore,
  resolvePromptImageAttachments,
} from './imageAttachments.js';
import type { InteractiveImageAttachment } from './imageAttachments.js';

export { type CallAIResult, type SessionContext, callAIWithRetry } from './aiCaller.js';

const log = createLogger('conversation-loop');

function resolveGoSummaryInput(
  history: ConversationMessage[],
  hasSessionContext: boolean,
  hasSourceContext: boolean,
  inlineTaskText: string,
): { summaryHistory: ConversationMessage[]; userNote: string } {
  if (history.length > 0 || hasSessionContext || hasSourceContext || !inlineTaskText) {
    return {
      summaryHistory: history,
      userNote: inlineTaskText,
    };
  }

  return {
    summaryHistory: [{ role: 'user', content: inlineTaskText }],
    userNote: '',
  };
}

function findLatestAssistantMessage(history: ConversationMessage[]): ConversationMessage | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role === 'assistant') {
      return message;
    }
  }
  return undefined;
}

/**
 * Display and clear previous session state if present.
 */
export function displayAndClearSessionState(cwd: string, lang: 'en' | 'ja'): void {
  const sessionState = takeSessionState(cwd);
  if (sessionState) {
    const statusLabel = formatSessionStatus(sessionState, lang);
    info(statusLabel);
    blankLine();
  }
}

export type { PostSummaryAction } from './interactive.js';

export interface SummaryPromptOptions {
  readonly history: ConversationMessage[];
  readonly hasSession: boolean;
  readonly lang: 'en' | 'ja';
  readonly noTranscriptNote: string;
  readonly conversationLabel: string;
  readonly workflowContext?: WorkflowContext;
  readonly sourceContext?: string;
  readonly promptContext?: string;
  readonly formalSpec: boolean;
  readonly formalSpecComments?: boolean;
  readonly userNote: string;
}

export type SummaryPromptBuilder = (options: SummaryPromptOptions) => string;

export interface NormalizedSummaryTask {
  readonly task: string;
  readonly attachments: readonly InteractiveImageAttachment[];
}

export type SummaryTaskNormalizer = (
  task: string,
  attachments: readonly InteractiveImageAttachment[],
) => NormalizedSummaryTask;

export interface ConversationPromptConfiguration {
  readonly systemPrompt: string;
  readonly formalSpec: boolean;
  readonly formalSpecComments?: boolean;
}

/** Strategy for customizing conversation loop behavior */
export interface ConversationStrategy {
  /** System prompt for AI calls */
  systemPrompt: string;
  /** Resolved formal specification mode for this conversation session. */
  formalSpec: boolean;
  /** Whether formal notation blocks must include natural-language meaning comments. */
  formalSpecComments?: boolean;
  /** Resolve prompt configuration after the user selects another session. */
  resolveResumedSessionConfiguration?: () => Promise<ConversationPromptConfiguration>;
  /** Allowed tools for AI calls */
  allowedTools: string[];
  /** Permission mode for AI calls. */
  permissionMode?: PermissionMode;
  /** Transform user message before sending to AI (e.g., policy injection) */
  transformPrompt: (userMessage: string, sourceContext?: string) => string;
  /** Intro message displayed at start */
  introMessage: string;
  /** Custom action selector (optional). If not provided, uses default selectPostSummaryAction. */
  selectAction?: (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null>;
  /** Action selector used for a generated /go proposal. */
  selectGoAction?: (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null>;
  /** Action selector used by /retry. */
  selectRetryAction?: (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null>;
  /** Build a mode-specific /go prompt. */
  summaryPromptBuilder?: SummaryPromptBuilder;
  /** Normalize a generated summary and its attachments before confirmation. */
  normalizeSummaryTask?: SummaryTaskNormalizer;
  /** Offset newly pasted image placeholders after the canonical order's images. */
  initialImageAttachmentIndex?: number;
  /** Previous order.md content for /replay command (retry/instruct only) */
  previousOrderContent?: string;
  /** Enable /retry slash command (retry mode only) */
  enableRetryCommand?: boolean;
  /** Explicit slash-command allowlist for modes with a guarded execution path. */
  enabledCommands?: readonly SlashCommand[];
  /** Context prepended to the first regular prompt in this conversation. */
  initialPromptContext?: string;
  /** Context prepended to summary prompts. */
  summaryPromptContext?: string;
  /** Include the command source on returned results for task re-execution flows. */
  trackResultSource?: boolean;
}

/**
 * Run the shared conversation loop.
 *
 * Handles: EOF, /accept, /retry, /replay, /go (summary), /cancel, regular AI messaging.
 * The Strategy object controls system prompt, tool access, and prompt transformation.
 */
export async function runConversationLoop(
  cwd: string,
  ctx: SessionContext,
  strategy: ConversationStrategy,
  workflowContext: WorkflowContext | undefined,
  initialInput: InteractiveSeedInput | undefined,
): Promise<InteractiveModeResult> {
  const history: ConversationMessage[] = initialInput?.userMessage
    ? [{ role: 'user', content: initialInput.userMessage }]
    : [];
  const sourceContext = initialInput?.sourceContext;
  let shouldSendInitialPromptContext = !!strategy.initialPromptContext;
  let sessionId = ctx.sessionId;
  let activePromptConfiguration: ConversationPromptConfiguration = {
    systemPrompt: strategy.systemPrompt,
    formalSpec: strategy.formalSpec,
    formalSpecComments: strategy.formalSpecComments ?? true,
  };
  const ui = getLabelObject<InteractiveUIText>('interactive.ui', ctx.lang);
  const conversationLabel = getLabel('interactive.conversationLabel', ctx.lang);
  const noTranscript = getLabel('interactive.noTranscript', ctx.lang);
  const attachmentStore = createSessionImageAttachmentStore(
    cwd,
    initialInput?.attachments,
    strategy.initialImageAttachmentIndex,
  );

  try {
    info(strategy.introMessage);
    if (sessionId) {
      info(ui.resume);
    }
    blankLine();

    /** Helper: call AI with current session and update session state */
    async function doCallAI(prompt: string, sysPrompt: string, tools: string[]): Promise<CallAIResult | null> {
      let imageAttachments: ReturnType<typeof resolvePromptImageAttachments>;
      try {
        imageAttachments = resolvePromptImageAttachments(prompt, attachmentStore.listAttachments());
      } catch (caught) {
        error(sanitizeTerminalText(caught instanceof Error ? caught.message : String(caught)));
        blankLine();
        return null;
      }
      const { result, sessionId: newSessionId } = await callAIWithRetry(
        prompt,
        sysPrompt,
        tools,
        cwd,
        { ...ctx, sessionId },
        { imageAttachments, permissionMode: strategy.permissionMode },
      );
      sessionId = newSessionId;
      return result;
    }

    if (sourceContext) {
      log.debug('Loaded initial input as source context without auto-submitting to AI', {
        ...createInputLogMeta(sourceContext, sessionId),
      });
    }

    async function handleSummaryAction(
      task: string,
      source: 'go' | 'retry',
      selector?: (task: string, lang: 'en' | 'ja') => Promise<PostSummaryAction | null>,
      normalize = false,
    ): Promise<InteractiveModeResult | null> {
      const normalized = normalize && strategy.normalizeSummaryTask
        ? strategy.normalizeSummaryTask(task, attachmentStore.listAttachments())
        : {
          task,
          attachments: attachmentStore.listAttachments(),
        };
      const actionSelector = selector
        ?? (source === 'go' ? strategy.selectGoAction : strategy.selectRetryAction)
        ?? strategy.selectAction;
      const selectedAction = actionSelector
        ? await actionSelector(normalized.task, ctx.lang)
        : await selectPostSummaryAction(normalized.task, ui.proposed, ui);
      if (selectedAction === 'continue' || selectedAction === null) {
        if (selectedAction === 'continue' && source === 'go') {
          history.push({ role: 'assistant', content: normalized.task });
        }
        info(ui.continuePrompt);
        return null;
      }
      log.info('Conversation action selected', { action: selectedAction, messageCount: history.length });
      const sourceMetadata = strategy.trackResultSource ? { source } : {};
      return buildInteractiveResultWithAttachments(
        { action: selectedAction, task: normalized.task, ...sourceMetadata },
        attachmentStore,
        normalized.attachments,
      );
    }

    const commandAvailability: CommandAvailability = {
      enableRetryCommand: strategy.enableRetryCommand,
      hasPreviousOrder: resolvePreviousOrder(strategy.previousOrderContent) !== undefined,
      enabledCommands: strategy.enabledCommands,
    };

    while (true) {
      const input = await readPipedLine(chalk.green('> '));

      if (input === null) {
        blankLine();
        info(ui.cancelled);
        return buildInteractiveResultWithAttachments({ action: 'cancel', task: '' }, attachmentStore);
      }

      const trimmed = input.trim();

      if (!trimmed) {
        continue;
      }

      const match = matchSlashCommand(trimmed, commandAvailability);

      // No slash command detected, treat as regular message
      if (!match) {
        history.push({ role: 'user', content: trimmed });
        log.debug('Sending to AI', {
          messageCount: history.length,
          ...createSessionLogMeta(sessionId),
        });
        process.stdin.pause();
        info(getLabel('interactive.ui.thinking', ctx.lang));

        const promptWithTransform = prependInitialPromptContext(
          strategy.transformPrompt(trimmed, sourceContext),
          shouldSendInitialPromptContext ? strategy.initialPromptContext : undefined,
        );
        const result = await doCallAI(
          promptWithTransform,
          activePromptConfiguration.systemPrompt,
          strategy.allowedTools,
        );
        if (result) {
          shouldSendInitialPromptContext = false;
          if (!result.success) {
            error(result.content);
            blankLine();
            history.pop();
            return buildInteractiveResultWithAttachments({ action: 'cancel', task: '' }, attachmentStore);
          }
          history.push({ role: 'assistant', content: result.content });
          blankLine();
        } else {
          history.pop();
        }
        continue;
      }

      switch (match.command) {
        case SlashCommand.Accept: {
          const assistantMessage = findLatestAssistantMessage(history);
          if (!assistantMessage) {
            info(ui.acceptNoAssistant);
            continue;
          }
          return buildInteractiveResultWithAttachments({
            action: 'execute',
            task: assistantMessage.content,
            ...(strategy.trackResultSource ? { source: 'accept' as const } : {}),
          }, attachmentStore);
        }

        case SlashCommand.Retry: {
          if (!strategy.enableRetryCommand) {
            info(ui.retryUnavailable);
            continue;
          }
          const retryOrder = resolvePreviousOrder(strategy.previousOrderContent);
          if (retryOrder === undefined) {
            info(ui.retryNoOrder);
            continue;
          }
          log.info('Retry command — using previous order.md');
          const selectedAction = strategy.selectRetryAction
            ? await handleSummaryAction(retryOrder, 'retry', strategy.selectRetryAction)
            : await handleSummaryAction(retryOrder, 'retry');
          if (selectedAction === null) {
            continue;
          }
          return selectedAction;
        }

        case SlashCommand.Go: {
          const { summaryHistory, userNote } = resolveGoSummaryInput(
            history,
            !!sessionId,
            !!sourceContext,
            match.text,
          );
          let summaryPrompt = strategy.summaryPromptBuilder
            ? strategy.summaryPromptBuilder({
              history: summaryHistory,
              hasSession: !!sessionId,
              lang: ctx.lang,
              noTranscriptNote: noTranscript,
              conversationLabel,
              workflowContext,
              sourceContext,
              promptContext: strategy.summaryPromptContext,
              formalSpec: activePromptConfiguration.formalSpec,
              formalSpecComments: activePromptConfiguration.formalSpecComments ?? true,
              userNote,
            })
            : buildSummaryPrompt(
              summaryHistory,
              !!sessionId,
              ctx.lang,
              noTranscript,
              conversationLabel,
              workflowContext,
              sourceContext,
              strategy.summaryPromptContext,
              activePromptConfiguration.formalSpec,
              activePromptConfiguration.formalSpecComments ?? true,
            );
          if (!summaryPrompt) {
            info(ui.noConversation);
            continue;
          }
          if (userNote && !strategy.summaryPromptBuilder) {
            summaryPrompt = `${summaryPrompt}\n\nUser Note:\n${userNote}`;
          }
          process.stdin.pause();
          info(getLabel('interactive.ui.creatingInstruction', ctx.lang));
          let summaryImageAttachments: ReturnType<typeof resolvePromptImageAttachments>;
          try {
            summaryImageAttachments = resolvePromptImageAttachments(summaryPrompt, attachmentStore.listAttachments());
          } catch (caught) {
            error(sanitizeTerminalText(caught instanceof Error ? caught.message : String(caught)));
            blankLine();
            continue;
          }
          // Summary AI must not inherit the conversation session to avoid chat-mode behavior.
          const { result: summaryResult } = await callAIWithRetry(
            summaryPrompt, summaryPrompt, strategy.allowedTools, cwd,
            { ...ctx, sessionId: undefined },
            {
              imageAttachments: summaryImageAttachments,
              permissionMode: strategy.permissionMode,
              persistSession: false,
            },
          );
          if (!summaryResult) {
            info(ui.summarizeFailed);
            continue;
          }
          if (!summaryResult.success) {
            error(summaryResult.content);
            blankLine();
            return buildInteractiveResultWithAttachments({ action: 'cancel', task: '' }, attachmentStore);
          }
          const task = summaryResult.content.trim();
          const selectedAction = await handleSummaryAction(task, 'go', strategy.selectGoAction, true);
          if (selectedAction === null) {
            continue;
          }
          return selectedAction;
        }

        case SlashCommand.Replay: {
          const replayOrder = resolvePreviousOrder(strategy.previousOrderContent);
          if (replayOrder === undefined) {
            const replayNoOrder = getLabel('instruct.ui.replayNoOrder', ctx.lang);
            info(replayNoOrder);
            continue;
          }
          log.info('Replay command');
          return buildInteractiveResultWithAttachments({
            action: 'execute',
            task: replayOrder,
            ...(strategy.trackResultSource ? { source: 'replay' as const } : {}),
          }, attachmentStore);
        }

        case SlashCommand.Cancel: {
          info(ui.cancelled);
          return buildInteractiveResultWithAttachments({ action: 'cancel', task: '' }, attachmentStore);
        }

        case SlashCommand.Resume: {
          const selectedId = await selectRecentSession(cwd, ctx.lang);
          if (selectedId) {
            sessionId = selectedId;
            if (strategy.resolveResumedSessionConfiguration) {
              activePromptConfiguration = await strategy.resolveResumedSessionConfiguration();
            }
            info(getLabel('interactive.resumeSessionLoaded', ctx.lang));
          }
          continue;
        }

        case SlashCommand.PasteImage: {
          info(ui.pasteImageUnavailable);
          continue;
        }
      }
    }
  } catch (caught) {
    cleanupImageAttachmentStore(attachmentStore);
    throw caught;
  }
}
