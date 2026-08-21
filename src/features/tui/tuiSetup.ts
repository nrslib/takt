/**
 * Everything a mounted view needs once a workflow and a mode are chosen.
 *
 * Building these is a side-effecting job (session init, prompt loading, image
 * store ownership), so the orchestrator prepares them and the React tree only
 * consumes them.
 */

import type { SessionContext } from '../interactive/aiCaller.js';
import type { TranscriptEntry } from './TranscriptEntryView.js';
import type { TuiConversation } from './tuiConversation.js';
import type { ImagePasteSink } from './useImagePaste.js';

/**
 * How the session's own provider and model read on screen. Taken from the
 * context the session was built with, so what is shown is what will be called —
 * there is no second resolution behind the display.
 *
 * A model is not always resolved: some providers are called without one and use
 * whatever the provider itself defaults to, and there is nothing to show then.
 */
export function describeSessionModel(ctx: SessionContext): string {
  return ctx.model === undefined ? ctx.providerType : `${ctx.providerType}/${ctx.model}`;
}

export interface TuiChatSetup {
  /** `summarize` turns the first input straight into an instruction (quiet mode). */
  readonly kind: 'chat' | 'summarize';
  readonly conversation: TuiConversation;
  /** Provider and model of this session, already formatted for the status row. */
  readonly modelLabel: string;
  readonly initialEntries: readonly TranscriptEntry[];
  /** Summarize the seeded input immediately, without waiting for a keystroke. */
  readonly autoSubmit: boolean;
}

export interface TuiPassthroughSetup {
  readonly kind: 'passthrough';
  readonly intro: string;
  readonly seedText: string;
  /** Passthrough has no session, so its image saves come straight from the store. */
  readonly images: ImagePasteSink;
}
