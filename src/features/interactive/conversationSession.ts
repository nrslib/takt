import { SlashCommand } from '../../shared/constants.js';
import { getLabel } from '../../shared/i18n/index.js';
import { matchSlashCommand } from './commandMatcher.js';
import { prependInitialPromptContext } from './promptSections.js';
import {
  buildConversationSummaryPrompt,
  type ConversationMessage,
} from './interactiveApplication.js';
import { callAIWithRetry, type SessionContext } from './aiCaller.js';
import type { SummaryPromptBuilder } from './conversationLoop.js';
import type { WorkflowContext } from './interactive-summary-types.js';
import type { InteractiveMetadata } from '../tasks/execute/types.js';
import type { PermissionMode } from '../../core/models/index.js';
import type { ImageAttachmentReference } from '../../shared/types/image-attachments.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import { shouldUseGherkinTaskInstructions } from './taskInstructionFormat.js';

export interface ConversationSessionStrategy {
  systemPrompt: string;
  allowedTools: string[];
  /** Constraint the provider must enforce for this mode (Grill Me is read-only). */
  permissionMode?: PermissionMode;
  transformPrompt: (message: string, sourceContext?: string) => string;
  summaryPromptContext?: string;
  initialPromptContext?: string;
  /**
   * Mode-specific `/go` prompt. Retry and Instruct revise the task's existing
   * `order.md` instead of writing a new instruction, and that prompt is built
   * from the canonical order — the same builder the readline loop uses.
   */
  summaryPromptBuilder?: SummaryPromptBuilder;
}

export interface ConversationSessionOptions {
  cwd: string;
  outputMode?: 'terminal' | 'silent';
  ctx: SessionContext;
  strategy: ConversationSessionStrategy;
  workflowContext?: WorkflowContext;
  sourceContext?: string;
  /** Task text seeded from outside the conversation; enters the history without an AI call. */
  initialUserMessage?: string;
  /**
   * Summarize a continued provider session that has no local transcript yet.
   * Off by default: without it a `/go` with nothing to summarize reports that
   * there is no conversation, which is what the ACP adapter relies on.
   */
  summarizeResumedSession?: boolean;
  /** Stream observer for front-ends that render the response themselves (`outputMode: 'silent'`). */
  onStream?: StreamCallback;
  /** Resolves the image placeholders a prompt references into provider attachments. */
  resolveImageAttachments?: (prompt: string) => ImageAttachmentReference[];
}

/** What one turn is given: how to stop it, and where its own stream goes. */
export interface ConversationTurnInput {
  abortSignal?: AbortSignal;
  /**
   * Receives this turn's chunks. A provider that ignores its abort can still
   * emit after the user moved on, and those chunks belong to the turn that asked
   * for them — never to the one on screen now.
   */
  onStream?: StreamCallback;
  /**
   * Receives this turn's notices — for example that the provider took the images
   * as paths rather than as images. Same reason as `onStream`: a notice about a
   * turn's images belongs to the turn that sent them, never to the one on screen
   * now.
   */
  onNotice?: (message: string) => void;
}

/**
 * Machine-readable cause so front-ends can localize the failure.
 * `provider_error` carries the provider's own text in `message`.
 */
export type ConversationSessionErrorCode =
  | 'message_required'
  | 'task_text_required'
  | 'empty_ai_response'
  | 'no_conversation'
  | 'instruction_failed'
  | 'unsupported_command'
  | 'provider_error';

export type ConversationSessionResult =
  | {
      kind: 'assistant_response';
      content: string;
      sessionId?: string;
    }
  | {
      kind: 'workflow_execution_requested';
      task: string;
      workflowIdentifier?: string;
      interactiveMetadata: InteractiveMetadata;
      sessionId?: string;
    }
  | {
      kind: 'error';
      /** Absent when a producer only has human-readable text to offer. */
      code?: ConversationSessionErrorCode;
      message: string;
    };

export interface ConversationSession {
  handleUserMessage(input: ConversationTurnInput & { text: string }): Promise<ConversationSessionResult>;
  createTaskInstruction(input: ConversationTurnInput & { userNote: string }): Promise<ConversationSessionResult>;
}

/**
 * Controls only the interactive front-ends need. Kept off `ConversationSession`
 * so the ACP adapter's dependency contract stays exactly as it was.
 */
export interface InteractiveConversationSession extends ConversationSession {
  /** Latest assistant reply, for front-ends that offer /accept. */
  getLatestAssistantMessage(): string | null;
  /**
   * Put a `/go` draft the user rejected back into the conversation, so the next
   * revision starts from what was proposed rather than from nothing.
   */
  recordRejectedDraft(task: string): void;
  /** Continue from a previously recorded provider session (/resume). */
  setSessionId(nextSessionId: string): void;
}

const WORKFLOW_IDENTIFIER_PATTERNS = [
  /(?:^|[\s,.;!?。、])--workflow(?:=|\s+)([^\s,.;!?。、]+)/iu,
  /(?:^|[\s,.;!?。、])workflow\s*[:=]\s*([^\s,.;!?。、]+)/iu,
];

function extractWorkflowIdentifier(text: string): string | undefined {
  for (const pattern of WORKFLOW_IDENTIFIER_PATTERNS) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function resolveWorkflowIdentifierFromUserInputs(history: ConversationMessage[], userNote: string): string | undefined {
  const noteWorkflowIdentifier = extractWorkflowIdentifier(userNote);
  if (noteWorkflowIdentifier) {
    return noteWorkflowIdentifier;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message || message.role !== 'user') {
      continue;
    }
    const historyWorkflowIdentifier = extractWorkflowIdentifier(message.content);
    if (historyWorkflowIdentifier) {
      return historyWorkflowIdentifier;
    }
  }
  return undefined;
}

export function createConversationSession(options: ConversationSessionOptions): InteractiveConversationSession {
  const gherkin = shouldUseGherkinTaskInstructions(options.cwd);
  let history: ConversationMessage[] = options.initialUserMessage
    ? [{ role: 'user', content: options.initialUserMessage }]
    : [];
  let sessionId = options.ctx.sessionId;
  let shouldSendInitialPromptContext = !!options.strategy.initialPromptContext;
  /**
   * The turn whose result the session still belongs to.
   *
   * A caller may start the next turn before the previous one has finished — an
   * interrupted answer whose provider keeps going, for instance. That older call
   * settles eventually, and what it settles with describes a conversation that
   * has already moved on: writing its history, its session id or its rollback
   * over the current one would undo a turn the user has already seen answered.
   */
  let currentTurn = 0;
  /** Opens a turn and hands back the test for "is this still the turn in play". */
  function beginTurn(): () => boolean {
    const turn = ++currentTurn;
    return (): boolean => turn === currentTurn;
  }

  async function handleRegularMessage(
    message: string,
    input: ConversationTurnInput,
  ): Promise<ConversationSessionResult> {
    const isCurrentTurn = beginTurn();
    const previousHistory = history;
    history = [...history, { role: 'user', content: message }];
    const prompt = prependInitialPromptContext(
      options.strategy.transformPrompt(message, options.sourceContext),
      shouldSendInitialPromptContext ? options.strategy.initialPromptContext : undefined,
    );
    const { result, sessionId: newSessionId, error: callError } = await callAIWithRetry(
      prompt,
      options.strategy.systemPrompt,
      options.strategy.allowedTools,
      options.cwd,
      { ...options.ctx, sessionId },
      {
        outputMode: options.outputMode,
        abortSignal: input.abortSignal,
        onStream: input.onStream ?? options.onStream,
        // Evaluated after the provider answers: a superseded turn must not write
        // its session id over the one the current turn is using.
        persistSession: isCurrentTurn,
        permissionMode: options.strategy.permissionMode,
        imageAttachments: options.resolveImageAttachments?.(prompt),
        ...(input.onNotice ? { onNotice: input.onNotice } : {}),
      },
    );
    if (isCurrentTurn()) {
      sessionId = newSessionId;
    }

    if (!result) {
      if (isCurrentTurn()) {
        history = previousHistory;
      }
      // The call threw: that reason is the answer to "why is there nothing", and
      // only a caller with a terminal would otherwise have seen it.
      return callError === undefined
        ? { kind: 'error', code: 'empty_ai_response', message: 'AI response was empty' }
        : { kind: 'error', code: 'provider_error', message: callError };
    }
    if (!result.success) {
      if (isCurrentTurn()) {
        history = previousHistory;
      }
      return { kind: 'error', code: 'provider_error', message: result.content };
    }

    if (!isCurrentTurn()) {
      // A turn the caller has moved past: it still reports its answer, but the
      // session it describes is no longer the one in play.
      return {
        kind: 'assistant_response',
        content: result.content,
        sessionId: result.sessionId,
      };
    }
    shouldSendInitialPromptContext = false;
    history = [...history, { role: 'assistant', content: result.content }];
    return {
      kind: 'assistant_response',
      content: result.content,
      sessionId: result.sessionId,
    };
  }

  async function handleGoCommand(
    userNote: string,
    input: ConversationTurnInput,
  ): Promise<ConversationSessionResult> {
    // `/go` is a turn like any other: opening it supersedes a chat turn that is
    // still running, so that one no longer writes history or session id when it
    // finally settles.
    const isCurrentTurn = beginTurn();
    const resumedSessionNote = options.summarizeResumedSession === true && sessionId
      ? getLabel('interactive.noTranscript', options.ctx.lang)
      : undefined;
    const summaryPrompt = options.strategy.summaryPromptBuilder
      ? options.strategy.summaryPromptBuilder({
        history,
        hasSession: resumedSessionNote !== undefined,
        lang: options.ctx.lang,
        noTranscriptNote: resumedSessionNote ?? '',
        conversationLabel: getLabel('interactive.conversationLabel', options.ctx.lang),
        ...(options.workflowContext ? { workflowContext: options.workflowContext } : {}),
        ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
        ...(options.strategy.summaryPromptContext
          ? { promptContext: options.strategy.summaryPromptContext }
          : {}),
        gherkin,
        userNote,
      })
      : buildConversationSummaryPrompt(
        history,
        userNote,
        options.ctx.lang,
        options.strategy.summaryPromptContext,
        gherkin,
        {
          ...(options.workflowContext ? { workflowContext: options.workflowContext } : {}),
          ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
          ...(resumedSessionNote === undefined ? {} : { resumedSessionNote }),
        },
      );
    if (!summaryPrompt) {
      return { kind: 'error', code: 'no_conversation', message: 'No conversation to summarize' };
    }

    const { result, sessionId: newSessionId, error: callError } = await callAIWithRetry(
      summaryPrompt,
      summaryPrompt,
      options.strategy.allowedTools,
      options.cwd,
      { ...options.ctx, sessionId: undefined },
      {
        outputMode: options.outputMode,
        abortSignal: input.abortSignal,
        persistSession: false,
        onStream: input.onStream ?? options.onStream,
        permissionMode: options.strategy.permissionMode,
        imageAttachments: options.resolveImageAttachments?.(summaryPrompt),
        ...(input.onNotice ? { onNotice: input.onNotice } : {}),
      },
    );

    if (!result) {
      // The call threw: that reason is the answer to "why is there no
      // instruction", and a silent caller has no terminal to have seen it on.
      return callError === undefined
        ? { kind: 'error', code: 'instruction_failed', message: 'Failed to create workflow instruction' }
        : { kind: 'error', code: 'provider_error', message: callError };
    }
    if (!result.success) {
      return { kind: 'error', code: 'provider_error', message: result.content };
    }

    const task = result.content.trim();
    if (!task) {
      return { kind: 'error', code: 'task_text_required', message: 'Task text is required' };
    }
    const workflowIdentifier = resolveWorkflowIdentifierFromUserInputs(history, userNote);
    return {
      kind: 'workflow_execution_requested',
      task,
      ...(workflowIdentifier ? { workflowIdentifier } : {}),
      interactiveMetadata: {
        confirmed: true,
        task,
      },
      // The caller records this session to resume from; a superseded summary
      // describes a conversation that has already moved on.
      ...(newSessionId && isCurrentTurn() ? { sessionId: newSessionId } : {}),
    };
  }

  return {
    getLatestAssistantMessage(): string | null {
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role === 'assistant') {
          return message.content;
        }
      }
      return null;
    },

    setSessionId(nextSessionId: string): void {
      sessionId = nextSessionId;
    },

    recordRejectedDraft(task: string): void {
      history = [...history, { role: 'assistant', content: task }];
    },

    createTaskInstruction(input: ConversationTurnInput & { userNote: string }): Promise<ConversationSessionResult> {
      return handleGoCommand(input.userNote, input);
    },

    async handleUserMessage(input: ConversationTurnInput & { text: string }): Promise<ConversationSessionResult> {
      const message = input.text.trim();
      if (!message) {
        return { kind: 'error', code: 'message_required', message: 'Message text is required' };
      }

      const match = matchSlashCommand(message);
      if (!match) {
        return handleRegularMessage(message, input);
      }

      switch (match.command) {
        case SlashCommand.Play: {
          const task = match.text.trim();
          if (!task) {
            return { kind: 'error', code: 'task_text_required', message: 'Task text is required' };
          }
          return {
            kind: 'workflow_execution_requested',
            task,
            interactiveMetadata: {
              confirmed: true,
              task,
            },
          };
        }
        case SlashCommand.Go:
          return handleGoCommand(match.text, input);
        default:
          return { kind: 'error', code: 'unsupported_command', message: `Unsupported command: ${match.command}` };
      }
    },
  };
}
