/**
 * Session connection layer for the Ink TUI.
 *
 * Drives the headless conversation session and translates its results into
 * outcomes the React tree renders. Nothing in this module writes to the
 * terminal — the provider runs in `silent` output mode and reports progress
 * through the per-submission stream sink.
 */

import { SlashCommand } from '../../shared/constants.js';
import { getLabel } from '../../shared/i18n/index.js';
import { matchSlashCommand } from '../interactive/commandMatcher.js';
import type { ConversationPlan } from '../interactive/conversationPlan.js';
import {
  createConversationSession,
  type ConversationSessionErrorCode,
  type ConversationSessionResult,
} from '../interactive/conversationSession.js';
import type { WorkflowContext } from '../interactive/interactive-summary-types.js';
import {
  createClipboardImagePasteHandler,
  createImagePasteHandler,
  type ImageAttachmentStore,
  resolvePromptImageAttachments,
} from '../interactive/imageAttachments.js';
import type { PastedImage } from '../interactive/inlineImagePaste.js';

export interface TuiConversationOptions {
  cwd: string;
  /** Mode-specific system prompt, tools and permission mode. */
  plan: ConversationPlan;
  workflowContext: WorkflowContext;
  /** Images pasted during this run; referenced from prompts by placeholder. */
  attachmentStore: ImageAttachmentStore;
  /** Task text supplied on the command line; seeds the conversation history. */
  userMessage?: string;
  sourceContext?: string;
}

/** i18n label for every failure the session reports with a fixed cause. */
const SESSION_ERROR_LABEL_KEYS: Readonly<
  Record<Exclude<ConversationSessionErrorCode, 'provider_error'>, string>
> = {
  message_required: 'tui.errors.messageRequired',
  task_text_required: 'tui.errors.taskTextRequired',
  empty_ai_response: 'tui.errors.emptyAiResponse',
  no_conversation: 'tui.errors.noConversation',
  instruction_failed: 'tui.errors.instructionFailed',
  unsupported_command: 'tui.errors.unsupportedCommand',
};

function describeSessionError(
  code: ConversationSessionErrorCode | undefined,
  message: string,
  lang: 'en' | 'ja',
): string {
  // No code means the producer only had human-readable text to offer.
  return code === undefined || code === 'provider_error'
    ? message
    : getLabel(SESSION_ERROR_LABEL_KEYS[code], lang);
}

export interface TuiSubmitInput {
  text: string;
  abortSignal: AbortSignal;
  onAssistantChunk: (chunk: string) => void;
}

export type TuiSubmission =
  | { kind: 'assistant_response'; content: string }
  | { kind: 'task_instruction'; task: string }
  | { kind: 'error'; message: string };

/** Commands the TUI settles itself, without contacting the provider. */
export type TuiLocalCommand =
  | { kind: 'cancel' }
  | { kind: 'execute'; task: string }
  | { kind: 'choose_action'; task: string }
  | { kind: 'resume_session' }
  | { kind: 'paste_image' }
  | { kind: 'notice'; message: string };

export interface TuiConversation {
  readonly lang: 'en' | 'ja';
  /** Which order-dependent commands this run can offer. */
  readonly commandAvailability: {
    readonly enableRetryCommand: boolean;
    readonly hasPreviousOrder: boolean;
  };
  /**
   * Commands the TUI resolves on its own. Callers consult this before `submit`
   * so a local command never raises the thinking indicator.
   */
  resolveLocalCommand(text: string): TuiLocalCommand | null;
  submit(input: TuiSubmitInput): Promise<TuiSubmission>;
  /** Summarize straight into a task instruction, skipping the chat turn. */
  createInstruction(input: TuiSubmitInput): Promise<TuiSubmission>;
  /** Continue from a session picked with /resume. */
  resumeSession(sessionId: string): void;
  /** Capture the clipboard image and return the placeholder to insert. */
  pasteClipboardImage(abortSignal: AbortSignal): Promise<string>;
  /** Refuse further images once the run ended, so a late save leaves no temp file. */
  sealImages(): void;
  /** Store an image the terminal pasted inline and return its placeholder. */
  saveInlineImage(image: PastedImage): Promise<string>;
}

export function createTuiConversation(options: TuiConversationOptions): TuiConversation {
  const { ctx, strategy } = options.plan;

  let activeChunkSink: ((chunk: string) => void) | null = null;
  const session = createConversationSession({
    cwd: options.cwd,
    outputMode: 'silent',
    ctx,
    strategy,
    workflowContext: options.workflowContext,
    // `--continue` and `/resume` hand the TUI a live session with no local
    // transcript; summarizing it straight away has to work.
    summarizeResumedSession: true,
    ...(options.userMessage ? { initialUserMessage: options.userMessage } : {}),
    ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
    resolveImageAttachments: (prompt) =>
      resolvePromptImageAttachments(prompt, options.attachmentStore.listAttachments()),
    onStream: (event) => {
      if (event.type === 'text') {
        activeChunkSink?.(event.data.text);
      }
    },
  });

  return {
    lang: ctx.lang,
    commandAvailability: { enableRetryCommand: false, hasPreviousOrder: false },

    resolveLocalCommand(text: string): TuiLocalCommand | null {
      const match = matchSlashCommand(text.trim());
      if (!match) {
        return null;
      }
      switch (match.command) {
        case SlashCommand.Cancel:
          return { kind: 'cancel' };
        case SlashCommand.Accept: {
          const latest = session.getLatestAssistantMessage();
          return latest === null
            ? { kind: 'notice', message: getLabel('interactive.ui.acceptNoAssistant', ctx.lang) }
            : { kind: 'execute', task: latest };
        }
        case SlashCommand.Play:
          return match.text
            ? { kind: 'execute', task: match.text }
            : { kind: 'notice', message: getLabel('interactive.ui.playNoTask', ctx.lang) };
        // The default conversation never carries a previous order — the readline
        // loop gates both commands the same way (conversationLoop.ts:264-279).
        case SlashCommand.Replay:
          return { kind: 'notice', message: getLabel('instruct.ui.replayNoOrder', ctx.lang) };
        case SlashCommand.Retry:
          return { kind: 'notice', message: getLabel('interactive.ui.retryUnavailable', ctx.lang) };
        case SlashCommand.Resume:
          return { kind: 'resume_session' };
        case SlashCommand.PasteImage:
          return { kind: 'paste_image' };
        case SlashCommand.Go:
        case SlashCommand.Setup:
          return null;
      }
    },

    async submit(input: TuiSubmitInput): Promise<TuiSubmission> {
      const text = input.text.trim();
      activeChunkSink = input.onAssistantChunk;
      let result: ConversationSessionResult;
      try {
        result = await session.handleUserMessage({ text, abortSignal: input.abortSignal });
      } finally {
        activeChunkSink = null;
      }

      switch (result.kind) {
        case 'assistant_response':
          return { kind: 'assistant_response', content: result.content };
        case 'workflow_execution_requested':
          return { kind: 'task_instruction', task: result.task };
        case 'error':
          return {
            kind: 'error',
            message: describeSessionError(result.code, result.message, ctx.lang),
          };
      }
    },

    async createInstruction(input: TuiSubmitInput): Promise<TuiSubmission> {
      activeChunkSink = input.onAssistantChunk;
      let result: ConversationSessionResult;
      try {
        result = await session.createTaskInstruction({
          userNote: input.text.trim(),
          abortSignal: input.abortSignal,
        });
      } finally {
        activeChunkSink = null;
      }
      return result.kind === 'workflow_execution_requested'
        ? { kind: 'task_instruction', task: result.task }
        : {
          kind: 'error',
          message: result.kind === 'error'
            ? describeSessionError(result.code, result.message, ctx.lang)
            : result.content,
        };
    },

    resumeSession(sessionId: string): void {
      session.setSessionId(sessionId);
    },

    pasteClipboardImage(abortSignal: AbortSignal): Promise<string> {
      return createClipboardImagePasteHandler(options.attachmentStore)(abortSignal);
    },

    sealImages(): void {
      options.attachmentStore.seal();
    },

    saveInlineImage(image: PastedImage): Promise<string> {
      return createImagePasteHandler(options.attachmentStore)(image);
    },
  };
}
