import { SlashCommand } from '../../shared/constants.js';
import { getLabel } from '../../shared/i18n/index.js';
import { matchSlashCommand } from './commandMatcher.js';
import { prependInitialPromptContext } from './promptSections.js';
import {
  buildConversationSummaryPrompt,
  type ConversationMessage,
} from './interactiveApplication.js';
import { callAIWithRetry, type SessionContext } from './aiCaller.js';
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
  handleUserMessage(input: { text: string; abortSignal?: AbortSignal }): Promise<ConversationSessionResult>;
  createTaskInstruction(input: { userNote: string; abortSignal?: AbortSignal }): Promise<ConversationSessionResult>;
}

/**
 * Controls only the interactive front-ends need. Kept off `ConversationSession`
 * so the ACP adapter's dependency contract stays exactly as it was.
 */
export interface InteractiveConversationSession extends ConversationSession {
  /** Latest assistant reply, for front-ends that offer /accept. */
  getLatestAssistantMessage(): string | null;
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

  async function handleRegularMessage(message: string, abortSignal: AbortSignal | undefined): Promise<ConversationSessionResult> {
    const previousHistory = history;
    history = [...history, { role: 'user', content: message }];
    const prompt = prependInitialPromptContext(
      options.strategy.transformPrompt(message, options.sourceContext),
      shouldSendInitialPromptContext ? options.strategy.initialPromptContext : undefined,
    );
    const { result, sessionId: newSessionId } = await callAIWithRetry(
      prompt,
      options.strategy.systemPrompt,
      options.strategy.allowedTools,
      options.cwd,
      { ...options.ctx, sessionId },
      {
        outputMode: options.outputMode,
        abortSignal,
        onStream: options.onStream,
        permissionMode: options.strategy.permissionMode,
        imageAttachments: options.resolveImageAttachments?.(prompt),
      },
    );
    sessionId = newSessionId;

    if (!result) {
      history = previousHistory;
      return { kind: 'error', code: 'empty_ai_response', message: 'AI response was empty' };
    }
    if (!result.success) {
      history = previousHistory;
      return { kind: 'error', code: 'provider_error', message: result.content };
    }

    shouldSendInitialPromptContext = false;
    history = [...history, { role: 'assistant', content: result.content }];
    return {
      kind: 'assistant_response',
      content: result.content,
      sessionId: result.sessionId,
    };
  }

  async function handleGoCommand(userNote: string, abortSignal: AbortSignal | undefined): Promise<ConversationSessionResult> {
    const summaryPrompt = buildConversationSummaryPrompt(
      history,
      userNote,
      options.ctx.lang,
      options.strategy.summaryPromptContext,
      gherkin,
      {
        ...(options.workflowContext ? { workflowContext: options.workflowContext } : {}),
        ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
        ...(options.summarizeResumedSession === true && sessionId
          ? { resumedSessionNote: getLabel('interactive.noTranscript', options.ctx.lang) }
          : {}),
      },
    );
    if (!summaryPrompt) {
      return { kind: 'error', code: 'no_conversation', message: 'No conversation to summarize' };
    }

    const { result, sessionId: newSessionId } = await callAIWithRetry(
      summaryPrompt,
      summaryPrompt,
      options.strategy.allowedTools,
      options.cwd,
      { ...options.ctx, sessionId: undefined },
      {
        outputMode: options.outputMode,
        abortSignal,
        persistSession: false,
        onStream: options.onStream,
        permissionMode: options.strategy.permissionMode,
        imageAttachments: options.resolveImageAttachments?.(summaryPrompt),
      },
    );

    if (!result) {
      return { kind: 'error', code: 'instruction_failed', message: 'Failed to create workflow instruction' };
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
      ...(newSessionId ? { sessionId: newSessionId } : {}),
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

    createTaskInstruction(input: { userNote: string; abortSignal?: AbortSignal }): Promise<ConversationSessionResult> {
      return handleGoCommand(input.userNote, input.abortSignal);
    },

    async handleUserMessage(input: { text: string; abortSignal?: AbortSignal }): Promise<ConversationSessionResult> {
      const message = input.text.trim();
      if (!message) {
        return { kind: 'error', code: 'message_required', message: 'Message text is required' };
      }

      const match = matchSlashCommand(message);
      if (!match) {
        return handleRegularMessage(message, input.abortSignal);
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
          return handleGoCommand(match.text, input.abortSignal);
        default:
          return { kind: 'error', code: 'unsupported_command', message: `Unsupported command: ${match.command}` };
      }
    },
  };
}
