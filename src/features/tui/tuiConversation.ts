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
import type { CommandAvailability } from '../interactive/slashCommandRegistry.js';
import { resolvePreviousOrder, type ConversationPlan } from '../interactive/conversationPlan.js';
import type { InteractiveModeResult } from '../interactive/interactive.js';
import {
  createConversationSession,
  type ConversationSessionErrorCode,
  type ConversationSessionResult,
} from '../interactive/conversationSession.js';
import type { WorkflowContext } from '../interactive/interactive-summary-types.js';
import type { ConversationMessage } from '../interactive/interactiveApplication.js';
import {
  createClipboardImagePasteHandler,
  createImagePasteHandler,
  type ImageAttachmentStore,
  resolvePromptImageAttachments,
} from '../interactive/imageAttachments.js';
import type { PastedImage } from '../interactive/inlineImagePaste.js';

/**
 * Which command path a task came from. Every mode carries it — the conversation
 * needs it to pick the right selector and to decide what a rejected draft means
 * — but only the modes that rewrite `order.md` publish it on the result.
 */
export type InteractiveResultSource = NonNullable<InteractiveModeResult['source']>;

export interface TuiConversationOptions {
  cwd: string;
  /** Mode-specific system prompt, tools and permission mode. */
  plan: ConversationPlan;
  /** Left out by a mode that has no workflow to describe to the summary prompt. */
  workflowContext?: WorkflowContext;
  /** Images pasted during this run; referenced from prompts by placeholder. */
  attachmentStore: ImageAttachmentStore;
  /** Task text supplied on the command line; seeds the conversation history. */
  userMessage?: string;
  /** Previous session transcript included once as reference on the first provider call. */
  handoffHistory?: readonly ConversationMessage[];
  /** Keep temporary provider/model sessions out of persisted `/continue` metadata. */
  persistSession?: boolean;
  sourceContext?: string;
  /** Enable settings handoffs owned by the resident interactive TUI. */
  enableSettingsCommands?: boolean;
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

/**
 * `commit` applies whatever the turn leaves behind outside the view — the
 * transcript the caller summarizes from, the session to resume. The view calls
 * it only for a turn that is still the current one and was not interrupted, so
 * an adapter must do nothing on its own until then.
 */
export type TuiSubmission =
  | { kind: 'assistant_response'; content: string; notices?: readonly string[]; commit?: () => void }
  | {
    kind: 'task_instruction';
    task: string;
    /** The command path that produced it. */
    origin?: InteractiveResultSource;
    notices?: readonly string[];
    commit?: () => void;
  }
  | { kind: 'error'; message: string; notices?: readonly string[]; commit?: () => void };

/** Commands the TUI settles itself, without contacting the provider. */
export type TuiLocalCommand =
  | { kind: 'cancel' }
  | { kind: 'execute'; task: string; origin?: InteractiveResultSource }
  | { kind: 'choose_action'; task: string; origin?: InteractiveResultSource }
  | { kind: 'resume_session' }
  /**
   * Something the caller has to run with the terminal to itself — a settings
   * menu, a workflow — after which the conversation picks up again. The id is
   * the caller's own name for it.
   */
  | {
    kind: 'handoff';
    id: string;
    /** What was typed alongside the command, for the run that carries it out. */
    text?: string;
  }
  | { kind: 'paste_image' }
  | { kind: 'notice'; message: string };

export interface TuiConversation {
  /**
   * True when the line means an operation on the conversation rather than
   * something to say. A queue may merge what the user typed into one message,
   * and a command must never be merged into one — but a line that merely starts
   * with a slash (`/usr/bin/env is missing`) is text like any other.
   */
  isCommandLine(text: string): boolean;
  readonly lang: 'en' | 'ja';
  /** Which commands this run can offer, and which it refuses outright. */
  readonly commandAvailability: CommandAvailability;
  /** True when the mode records on its result which command path produced it. */
  readonly tracksResultSource: boolean;
  /**
   * Commands the TUI resolves on its own. Callers consult this before `submit`
   * so a local command never raises the thinking indicator.
   */
  resolveLocalCommand(text: string): TuiLocalCommand | null;
  submit(input: TuiSubmitInput): Promise<TuiSubmission>;
  /** Summarize straight into a task instruction, skipping the chat turn. */
  createInstruction(input: TuiSubmitInput): Promise<TuiSubmission>;
  /** Continue from a session picked with /resume. */
  resumeSession(sessionId: string): Promise<void>;
  /**
   * Put a `/go` draft the user rejected back into the conversation, so the next
   * revision starts from what was proposed. Left out by a front-end whose
   * session keeps no transcript of its own (exec).
   */
  recordRejectedDraft?(task: string): void;
  /** Snapshot all user/assistant context needed by a recreated provider session. */
  snapshotHistory?(): readonly ConversationMessage[];
  /** Apply an effort override to future calls on the active session. */
  setEffort?(effort: string): void;
  /** Capture the clipboard image and return the placeholder to insert. */
  pasteClipboardImage(abortSignal: AbortSignal): Promise<string>;
  /** Refuse further images once the run ended, so a late save leaves no temp file. */
  sealImages(): void;
  /** Store an image the terminal pasted inline and return its placeholder. */
  saveInlineImage(image: PastedImage): Promise<string>;
}

export function createTuiConversation(options: TuiConversationOptions): TuiConversation {
  const { ctx, strategy } = options.plan;


  const session = createConversationSession({
    cwd: options.cwd,
    outputMode: 'silent',
    ctx,
    strategy,
    formalSpec: strategy.formalSpec,
    ...(options.workflowContext ? { workflowContext: options.workflowContext } : {}),
    // `--continue` and `/resume` hand the TUI a live session with no local
    // transcript; summarizing it straight away has to work.
    summarizeResumedSession: true,
    ...(options.userMessage ? { initialUserMessage: options.userMessage } : {}),
    ...(options.handoffHistory && options.handoffHistory.length > 0
      ? { handoffHistory: options.handoffHistory }
      : {}),
    ...(options.persistSession === false ? { persistSession: false } : {}),
    ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
    resolveImageAttachments: (prompt) =>
      resolvePromptImageAttachments(prompt, options.attachmentStore.listAttachments()),
  });

  const previousOrder = resolvePreviousOrder(strategy.previousOrderContent);
  // Exactly what the readline loop builds (conversationLoop.ts): the retry mode
  // is the only one that enables `/retry`, `/replay` needs an order to resubmit,
  // and a mode with a guarded execution path names the commands it allows at all.
  const commandAvailability: CommandAvailability = {
    enableRetryCommand: strategy.enableRetryCommand === true,
    hasPreviousOrder: previousOrder !== undefined,
    ...(options.enableSettingsCommands === true ? { enableSettingsCommands: true } : {}),
    ...(strategy.enabledCommands ? { enabledCommands: strategy.enabledCommands } : {}),
  };

  return {
    lang: ctx.lang,
    commandAvailability,
    // Only the modes that rewrite the task's `order.md` put the command path on
    // the result, exactly as in the readline loop.
    tracksResultSource: strategy.trackResultSource === true,

    isCommandLine(text: string): boolean {
      // The registry decides, not the leading character: `/go` is a command,
      // `/usr/bin/env is missing` is a sentence. A mode that disables a command
      // has no command there either, so the line stays text.
      return matchSlashCommand(text.trim(), commandAvailability) !== null;
    },

    recordRejectedDraft(task: string): void {
      session.recordRejectedDraft(task);
    },

    snapshotHistory(): readonly ConversationMessage[] {
      return session.snapshotHistory();
    },

    setEffort(effort: string): void {
      session.setEffort(effort);
    },

    resolveLocalCommand(text: string): TuiLocalCommand | null {
      const match = matchSlashCommand(text.trim(), commandAvailability);
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
            : { kind: 'execute', task: latest, origin: 'accept' };
        }
        // Both commands are gated exactly as the readline loop gates them
        // (conversationLoop.ts): `/replay` resubmits the previous order without
        // asking, `/retry` puts it through the action selector first.
        case SlashCommand.Replay:
          return previousOrder === undefined
            ? { kind: 'notice', message: getLabel('instruct.ui.replayNoOrder', ctx.lang) }
            : { kind: 'execute', task: previousOrder, origin: 'replay' };
        case SlashCommand.Retry: {
          if (strategy.enableRetryCommand !== true) {
            return { kind: 'notice', message: getLabel('interactive.ui.retryUnavailable', ctx.lang) };
          }
          return previousOrder === undefined
            ? { kind: 'notice', message: getLabel('interactive.ui.retryNoOrder', ctx.lang) }
            : { kind: 'choose_action', task: previousOrder, origin: 'retry' };
        }
        case SlashCommand.Resume:
          return { kind: 'resume_session' };
        case SlashCommand.PasteImage:
          return { kind: 'paste_image' };
        case SlashCommand.Workflow:
        case SlashCommand.Mode:
        case SlashCommand.Provider:
          return match.text === ''
            ? { kind: 'handoff', id: match.command.slice(1) }
            : {
              kind: 'notice',
              message: getLabel('tui.errors.settingNoArguments', ctx.lang, { command: match.command }),
            };
        case SlashCommand.Model:
        case SlashCommand.Effort:
          return match.text !== ''
            ? { kind: 'handoff', id: match.command.slice(1), text: match.text }
            : {
              kind: 'notice',
              message: getLabel('tui.errors.settingValueRequired', ctx.lang, { command: match.command }),
            };
        case SlashCommand.Go:
        case SlashCommand.Setup:
          return null;
      }
    },

    async submit(input: TuiSubmitInput): Promise<TuiSubmission> {
      const text = input.text.trim();
      // This turn's own sinks, closed when the turn ends: a provider that keeps
      // streaming or reporting past its abort reaches a sink nobody is drawing
      // any more, never the turn that took its place.
      const notices: string[] = [];
      let turnEnded = false;
      let result: ConversationSessionResult;
      try {
        result = await session.handleUserMessage({
          text,
          abortSignal: input.abortSignal,
          onStream: (event) => {
            if (!turnEnded && event.type === 'text') {
              input.onAssistantChunk(event.data.text);
            }
          },
          onNotice: (message) => {
            if (!turnEnded) {
              notices.push(message);
            }
          },
        });
      } finally {
        turnEnded = true;
      }

      switch (result.kind) {
        case 'assistant_response':
          return { kind: 'assistant_response', content: result.content, notices };
        case 'workflow_execution_requested':
          return { kind: 'task_instruction', task: result.task, origin: 'go', notices };
        case 'error':
          return {
            kind: 'error',
            message: describeSessionError(result.code, result.message, ctx.lang),
            notices,
          };
      }
    },

    async createInstruction(input: TuiSubmitInput): Promise<TuiSubmission> {
      const notices: string[] = [];
      let turnEnded = false;
      let result: ConversationSessionResult;
      try {
        result = await session.createTaskInstruction({
          userNote: input.text.trim(),
          abortSignal: input.abortSignal,
          onStream: (event) => {
            if (!turnEnded && event.type === 'text') {
              input.onAssistantChunk(event.data.text);
            }
          },
          onNotice: (message) => {
            if (!turnEnded) {
              notices.push(message);
            }
          },
        });
      } finally {
        turnEnded = true;
      }
      return result.kind === 'workflow_execution_requested'
        ? { kind: 'task_instruction', task: result.task, origin: 'go', notices }
        : {
          kind: 'error',
          message: result.kind === 'error'
            ? describeSessionError(result.code, result.message, ctx.lang)
            : result.content,
          notices,
        };
    },

    async resumeSession(sessionId: string): Promise<void> {
      session.setSessionId(sessionId);
      if (strategy.resolveResumedSessionConfiguration) {
        session.setPromptConfiguration(await strategy.resolveResumedSessionConfiguration());
      }
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
