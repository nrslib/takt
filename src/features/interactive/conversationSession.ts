import { SlashCommand } from '../../shared/constants.js';
import { matchSlashCommand } from './commandMatcher.js';
import { prependInitialPromptContext } from './promptSections.js';
import {
  buildConversationSummaryPrompt,
  type ConversationMessage,
} from './interactiveApplication.js';
import { callAIWithRetry, type SessionContext } from './aiCaller.js';
import type { WorkflowContext } from './interactive-summary-types.js';
import type { InteractiveMetadata } from '../tasks/execute/types.js';

export interface ConversationSessionStrategy {
  systemPrompt: string;
  allowedTools: string[];
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
}

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
      message: string;
    };

export interface ConversationSession {
  handleUserMessage(input: { text: string; abortSignal?: AbortSignal }): Promise<ConversationSessionResult>;
  createTaskInstruction(input: { userNote: string; abortSignal?: AbortSignal }): Promise<ConversationSessionResult>;
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

export function createConversationSession(options: ConversationSessionOptions): ConversationSession {
  let history: ConversationMessage[] = [];
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
      },
    );
    sessionId = newSessionId;

    if (!result) {
      history = previousHistory;
      return { kind: 'error', message: 'AI response was empty' };
    }
    if (!result.success) {
      history = previousHistory;
      return { kind: 'error', message: result.content };
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
    );
    if (!summaryPrompt) {
      return { kind: 'error', message: 'No conversation to summarize' };
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
      },
    );

    if (!result) {
      return { kind: 'error', message: 'Failed to create workflow instruction' };
    }
    if (!result.success) {
      return { kind: 'error', message: result.content };
    }

    const task = result.content.trim();
    if (!task) {
      return { kind: 'error', message: 'Task text is required' };
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
    createTaskInstruction(input: { userNote: string; abortSignal?: AbortSignal }): Promise<ConversationSessionResult> {
      return handleGoCommand(input.userNote, input.abortSignal);
    },

    async handleUserMessage(input: { text: string; abortSignal?: AbortSignal }): Promise<ConversationSessionResult> {
      const message = input.text.trim();
      if (!message) {
        return { kind: 'error', message: 'Message text is required' };
      }

      const match = matchSlashCommand(message);
      if (!match) {
        return handleRegularMessage(message, input.abortSignal);
      }

      switch (match.command) {
        case SlashCommand.Play: {
          const task = match.text.trim();
          if (!task) {
            return { kind: 'error', message: 'Task text is required' };
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
          return { kind: 'error', message: `Unsupported command: ${match.command}` };
      }
    },
  };
}
