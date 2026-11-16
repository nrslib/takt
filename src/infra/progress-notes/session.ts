import { ProgressNotesStore, ProgressNotesUnavailableError, PROGRESS_NOTES_MAX_CHARS, type CreatedProgressNotes } from './store.js';
import type { ProgressNotesRequest } from '../../core/workflow/progress-notes.js';
import type { AgentResponse, Language } from '../../core/models/index.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import { loadTemplate } from '../../shared/prompts/index.js';
import { createLogger } from '../../shared/utils/debug.js';
import { getErrorMessage } from '../../shared/utils/error.js';

const log = createLogger('progress-notes');

export interface ProgressNotesRecorder {
  observe(event: StreamEvent): void;
  finish(response: AgentResponse): void;
  /** The Phase 1 request to resend after a compaction, with the latest saved notes when they exist. */
  recoveryInstruction(): string;
}

export interface ProgressNotesSession extends Omit<ProgressNotesRecorder, 'recoveryInstruction'> {
  flush(): void;
  instruction(requestInstruction: string): string;
}

const WITHOUT_NOTES: ProgressNotesSession = {
  observe: () => undefined,
  finish: () => undefined,
  flush: () => undefined,
  instruction: (requestInstruction) => requestInstruction,
};

/**
 * Notes are auxiliary to the provider's work. The store reports storage and Git failures as
 * ProgressNotesUnavailableError; such a failure stops notes without failing the call, whose response
 * and session ID are never discarded. Anything else is a programming mistake and fails the call.
 */
function absorbNotesFailure(error: unknown, details: Readonly<Record<string, string>>): void {
  if (!(error instanceof ProgressNotesUnavailableError)) throw error;
  log.warn('Progress notes unavailable for the rest of this call', {
    ...details,
    reason: error.message,
    ...(error.cause === undefined ? {} : { cause: getErrorMessage(error.cause) }),
  });
}

/**
 * Record ordinary agent notes, not tool calls or private reasoning. No provider write access is needed.
 * A store that cannot be opened (unsafe path, unreadable or changing inputs, Git or disk failure)
 * leaves the call without notes, exactly as a failure during the call does.
 */
export async function startProgressNotes(
  cwd: string,
  request: ProgressNotesRequest,
  instruction: string,
  language: Language,
): Promise<ProgressNotesSession> {
  let created: CreatedProgressNotes;
  try {
    created = await ProgressNotesStore.create(cwd, request, instruction);
  } catch (error) {
    absorbNotesFailure(error, { stepName: request.stepName });
    return WITHOUT_NOTES;
  }
  const { store } = created;
  let pending = '';
  let sawText = false;
  let available = true;
  // Creation already checked this log's source revision. Reuse it only for the first instruction
  // before any provider event; recovery after work must read and validate the sources again.
  let savedLog = created.log;
  // Some clients (Codex) turn a stream callback exception into a provider error response, which a
  // fresh retry would then repeat in a new session. A failure while observing is therefore kept
  // and thrown once the provider call has returned.
  let observedFailure: unknown;
  const stopRecording = (error: unknown): void => {
    available = false;
    pending = '';
    absorbNotesFailure(error, { path: store.path });
  };
  const flush = (): void => {
    if (observedFailure !== undefined) throw observedFailure;
    if (!available || pending.length === 0) return;
    try {
      savedLog = undefined;
      store.append(`${pending}\n`);
      pending = '';
    } catch (error) { stopRecording(error); }
  };
  return {
    flush,
    observe: (event: StreamEvent): void => {
      if (!available) return;
      try {
        // After any provider event, later recovery revalidates the current sources instead of
        // reusing the log read at creation; sibling steps may have changed them in between.
        savedLog = undefined;
        if (event.type === 'init') sawText = false;
        if (event.type === 'text') {
          sawText = true;
          pending += event.data.text;
          // Saving a revision-bound log re-fingerprints the repository, so streamed text waits for a
          // non-text event, the end of the call or a recovery instruction instead of each line.
          if (pending.length >= PROGRESS_NOTES_MAX_CHARS) flush();
          return;
        }
        if (event.type === 'result' && !sawText) {
          const output = event.data.success ? event.data.result : event.data.partialOutput;
          if (output !== undefined && output.length > 0) {
            pending += output;
            sawText = true;
          }
        }
        flush();
      } catch (error) {
        available = false;
        pending = '';
        observedFailure = error;
      }
    },
    finish: (response: AgentResponse): void => {
      if (observedFailure !== undefined) throw observedFailure;
      if (!available) return;
      if (!sawText) {
        const output = response.status === 'done' ? response.content : response.partialOutput;
        if (output !== undefined) pending += output;
      }
      flush();
      // A same-session recovery may start without another init event.
      sawText = false;
    },
    instruction: (requestInstruction: string): string => {
      flush();
      if (!available) return requestInstruction;
      let notes = savedLog;
      savedLog = undefined;
      if (notes === undefined) {
        try {
          notes = store.read();
        } catch (error) {
          stopRecording(error);
          return requestInstruction;
        }
      }
      return [
        requestInstruction,
        loadTemplate('parts/progress_notes_location', language, { path: store.path }).trim(),
        ...(notes === undefined ? [] : [
          '<progress_notes_data>',
          JSON.stringify({ target: store.target, log: notes })
            .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026'),
          '</progress_notes_data>',
        ]),
      ].join('\n\n');
    },
  };
}
