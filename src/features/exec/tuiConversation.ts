/**
 * The exec conversation, in the shape the Ink TUI consumes.
 *
 * Exec drives its own turns — one assistant call, no session object — so this
 * adapter answers the same `TuiConversation` contract over that loop. `/setup`
 * and `/go` are hand-offs: both need the bare terminal (a settings menu, a
 * workflow run) and the conversation resumes afterwards.
 */

import { matchSlashCommand } from '../interactive/commandMatcher.js';
import {
  createClipboardImagePasteHandler,
  createImagePasteHandler,
  resolvePromptImageAttachments,
  type ImageAttachmentStore,
} from '../interactive/imageAttachments.js';
import type { PastedImage } from '../interactive/inlineImagePaste.js';
import type { ConversationMessage } from '../interactive/interactive.js';
import type { TuiConversation, TuiLocalCommand, TuiSubmission, TuiSubmitInput } from '../tui/tuiConversation.js';
import { SlashCommand } from '../../shared/constants.js';
import { getLabel } from '../../shared/i18n/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';
import { askExecAssistant, type ExecSessionContext } from './assistantSession.js';
import { EXEC_CONVERSATION_COMMAND_AVAILABILITY } from './commandAvailability.js';

/** The ids the exec run answers when the conversation hands the terminal over. */
export const EXEC_SETUP_HANDOFF = 'exec-setup';
export const EXEC_GO_HANDOFF = 'exec-go';

export interface ExecTuiConversationOptions {
  readonly cwd: string;
  readonly attachmentStore: ImageAttachmentStore;
  /** The session as it stands right now, which `/setup` can replace. */
  readonly session: () => ExecSessionContext;
  /** The system prompt for a clarifying turn. */
  readonly systemPrompt: () => string;
  /** Called after every finished turn so the run keeps the transcript it summarizes. */
  readonly onTurn: (turn: readonly ConversationMessage[], sessionId: string | undefined) => void;
}

/** What one exec turn reported alongside its answer. */
interface TurnNotices {
  readonly notices: string[];
}

export function createExecTuiConversation(options: ExecTuiConversationOptions): TuiConversation {
  const ctx = (): ExecSessionContext => options.session();

  return {
    lang: ctx().lang,
    // Exec offers its own command set; `/retry` and `/replay` are not part of it,
    // and `/setup` — which the plain conversation has no use for — is.
    commandAvailability: EXEC_CONVERSATION_COMMAND_AVAILABILITY,
    // Exec runs its own workflow through `/go`; no result of its own records a
    // command path.
    tracksResultSource: false,

    isCommandLine(text: string): boolean {
      // Exec's own command set, so a line that names something else is text.
      return matchSlashCommand(text.trim(), EXEC_CONVERSATION_COMMAND_AVAILABILITY) !== null;
    },

    resolveLocalCommand(text: string): TuiLocalCommand | null {
      const match = matchSlashCommand(text.trim(), EXEC_CONVERSATION_COMMAND_AVAILABILITY);
      if (!match) {
        return null;
      }
      switch (match.command) {
        case SlashCommand.Cancel:
          return { kind: 'cancel' };
        case SlashCommand.Setup:
          return { kind: 'handoff', id: EXEC_SETUP_HANDOFF };
        case SlashCommand.Go:
          // No side effect here: the queue resolves a command once to see
          // whether it can wait and again when it runs, and the run must be told
          // what was typed exactly once.
          return { kind: 'handoff', id: EXEC_GO_HANDOFF, text: match.text };
        case SlashCommand.PasteImage:
          return { kind: 'paste_image' };
        default:
          return null;
      }
    },

    async submit(input: TuiSubmitInput): Promise<TuiSubmission> {
      const text = input.text.trim();
      const session = ctx();
      const turn: TurnNotices = { notices: [] };
      // Closed when the turn ends: a provider that keeps streaming or reporting
      // past its abort reaches sinks nobody is drawing any more.
      let turnEnded = false;
      try {
        const response = await askExecAssistant(
          options.cwd,
          session,
          text,
          options.systemPrompt(),
          {
            imageAttachments: resolvePromptImageAttachments(
              text,
              options.attachmentStore.listAttachments(),
            ),
            abortSignal: input.abortSignal,
            // Ink owns the terminal, so the answer is streamed into the view
            // instead of being written to stdout underneath it.
            outputMode: 'silent',
            onStream: (event) => {
              if (!turnEnded && event.type === 'text') {
                input.onAssistantChunk(event.data.text);
              }
            },
            onNotice: (message) => {
              if (!turnEnded) {
                turn.notices.push(message);
              }
            },
          },
        );
        return {
          kind: 'assistant_response',
          content: response.content,
          notices: turn.notices,
          // Handed to the view rather than run here: the run's transcript and
          // session must only grow with the turns the view accepted, never with
          // one the user interrupted or a later turn replaced.
          commit: () => {
            options.onTurn(
              [{ role: 'user', content: text }, { role: 'assistant', content: response.content }],
              response.sessionId,
            );
          },
        };
      } catch (error) {
        return {
          kind: 'error',
          message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
          notices: turn.notices,
        };
      } finally {
        turnEnded = true;
      }
    },

    createInstruction(): Promise<TuiSubmission> {
      // Exec summarizes through its own `/go` hand-off, never through this seam.
      return Promise.resolve({
        kind: 'error',
        message: getLabel('tui.errors.unsupportedCommand', ctx().lang),
      });
    },

    resumeSession(): void {
      // Exec has no session picker; `/resume` is not in its command set.
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
