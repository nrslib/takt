import { ReviewCheckpointStore, ReviewCheckpointUnavailableError, REVIEW_LOG_MAX_CHARS } from './store.js';
import type { ReviewCheckpointContext } from '../../core/workflow/review-checkpoint.js';
import type { AgentResponse, Language } from '../../core/models/index.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import { loadTemplate } from '../../shared/prompts/index.js';

export interface ReviewCheckpointRecorder {
  observe(event: StreamEvent): void;
  finish(response: AgentResponse): void;
}

/** Record ordinary agent notes, not tool calls or private reasoning. No provider write access is needed. */
export async function startReviewCheckpoint(cwd: string, context: ReviewCheckpointContext, instruction: string, language: Language) {
  const store = await ReviewCheckpointStore.create(cwd, context, instruction);
  let pending = '';
  let sawText = false;
  let available = true;
  let failure: unknown;
  const disableUnsafeCheckpoint = (error: unknown): void => {
    if (!(error instanceof ReviewCheckpointUnavailableError)) throw error;
    // A path may become unsafe after creation. Continue the review without
    // reading or writing that checkpoint, but never hide operational failures.
    available = false;
    pending = '';
  };
  const flush = (): void => {
    if (failure !== undefined) throw failure;
    if (!available || pending.length === 0) return;
    try {
      store.append(`${pending}\n`);
      pending = '';
    } catch (error) { disableUnsafeCheckpoint(error); }
  };
  return {
    flush,
    observe: (event: StreamEvent): void => {
      // Some clients turn callback exceptions into provider errors. Retain storage failures
      // so the runner also surfaces them outside that provider boundary.
      if (!available || failure !== undefined) return;
      try {
        if (event.type === 'init') sawText = false;
        if (event.type === 'text') {
          sawText = true;
          pending += event.data.text;
          if (pending.includes('\n') || pending.length >= REVIEW_LOG_MAX_CHARS) flush();
        } else {
          if (event.type === 'result' && !sawText) {
            const output = event.data.success ? event.data.result : event.data.partialOutput;
            if (output !== undefined && output.length > 0) {
              pending += output;
              sawText = true;
            }
          }
          flush();
        }
      } catch (error) { failure = error; }
    },
    finish: (response: AgentResponse): void => {
      if (!available) return;
      if (!sawText) {
        const output = response.status === 'done' ? response.content : response.partialOutput;
        if (output !== undefined) pending += output;
      }
      flush();
      // A same-session recovery may start without another init event.
      sawText = false;
    },
    instruction: (requestInstruction: string = instruction): string => {
      flush();
      if (!available) return requestInstruction;
      let log: string | undefined;
      try { log = store.read(); }
      catch (error) {
        disableUnsafeCheckpoint(error);
        return requestInstruction;
      }
      return [
        requestInstruction,
        loadTemplate('review_checkpoint', language),
        `Work log (TAKT records your ordinary text output here): ${store.path}`,
        ...(log === undefined ? [] : [
          '<review_checkpoint_data>',
          JSON.stringify({ target: store.target, log })
            .replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026'),
          '</review_checkpoint_data>',
        ]),
      ].join('\n\n');
    },
  };
}
