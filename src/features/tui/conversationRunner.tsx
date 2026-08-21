/**
 * The conversation phase of a TUI run, without anything that decides what the
 * conversation is about.
 *
 * Ink is mounted for the conversation and unmounted around every selector, so
 * the selectors keep the bare terminal they were written for. What survives a
 * hand-off — the session, the recall history, the transcript already in the
 * scrollback — is held here; each caller supplies the session, the selector for
 * a finished summary, and what to do with the decision.
 */

import { getLabel } from '../../shared/i18n/index.js';
import { info } from '../../shared/ui/index.js';
import type { PostSummaryAction } from '../interactive/interactive-summary.js';
import { selectRecentSession } from '../interactive/sessionSelector.js';
import type { InteractiveModeResult } from '../interactive/interactive.js';
import {
  ConversationView,
  type ConversationCarryOver,
  type ConversationExit,
} from './ConversationView.js';
import { mountInk } from './inkMount.js';
import type { TranscriptEntry } from './TranscriptEntryView.js';
import type { TuiConversation } from './tuiConversation.js';

export interface TuiConversationRunOptions {
  readonly cwd: string;
  readonly lang: 'en' | 'ja';
  readonly conversation: TuiConversation;
  /** Written into the transcript of the first mount only. */
  readonly initialEntries: readonly TranscriptEntry[];
  /** `summarize` turns the first input straight into an instruction. */
  readonly submitMode: 'chat' | 'summarize';
  readonly autoSubmit: boolean;
  /**
   * Provider and model of this session, formatted for the status row. Read per
   * mount, because a hand-off (exec's `/setup`) can replace the session.
   */
  readonly modelLabel: () => string;
  /** Runs the post-summary selector on the bare terminal. */
  readonly chooseAction: (task: string) => Promise<PostSummaryAction | null>;
  /** Printed when the selector says to keep editing. */
  readonly continuePrompt: string;
  /**
   * Carries out the decision with Ink unmounted and returns the line to greet
   * the session with. Left out by a caller that wants the decision handed back
   * instead — the run then ends there.
   */
  readonly dispatch?: (result: InteractiveModeResult) => Promise<string | null>;
  /**
   * Runs what a `handoff` command asked for, with Ink unmounted. It answers
   * with the line to greet the session with, or with the result that ends the
   * run.
   */
  readonly onHandoff?: (id: string) => Promise<TuiHandoffOutcome>;
}

export type TuiHandoffOutcome =
  /** The conversation continues; the line is written into the transcript. */
  | { readonly kind: 'continue'; readonly notice?: string }
  /** The run is over and this is what the caller asked for. */
  | { readonly kind: 'finished'; readonly result: InteractiveModeResult };

export async function runTuiConversation(
  options: TuiConversationRunOptions,
): Promise<InteractiveModeResult> {
  const exitedEarly = getLabel('tui.errors.exitedEarly', options.lang);
  let initialEntries: readonly TranscriptEntry[] = options.initialEntries;
  let autoSubmit = options.autoSubmit;
  let history: readonly string[] = [];
  // Lines the user submitted while the last mount was busy and that its exit cut
  // short: they were sent, so they are carried over rather than dropped.
  let queue: readonly string[] = [];

  /**
   * What happens once the conversation has decided on something. Leaving ends
   * the run, and so does a caller that only wanted one decision; otherwise the
   * decision is carried out and the session takes it up again.
   */
  const settleDecision = async (
    result: InteractiveModeResult,
  ): Promise<InteractiveModeResult | undefined> => {
    const dispatch = options.dispatch;
    if (dispatch === undefined || result.action === 'cancel') {
      return result;
    }
    const notice = await dispatch(result);
    initialEntries = notice === null ? [] : [{ role: 'system', content: notice }];
    return undefined;
  };

  while (true) {
    const settled = await mountInk<{
      readonly exit: Exclude<ConversationExit, { kind: 'failed' }>;
      readonly carried: ConversationCarryOver;
    }>(({ settle, fail }) => (
      <ConversationView
        ui={{
          thinking: getLabel('tui.ui.thinking', options.lang),
          hint: getLabel('tui.ui.hint', options.lang),
          placeholder: getLabel('tui.ui.placeholder', options.lang),
          queuedHint: getLabel('tui.ui.queuedHint', options.lang),
          queuedMore: getLabel('tui.ui.queuedMore', options.lang),
          interruptHint: getLabel('tui.ui.interruptHint', options.lang),
          responseInterrupted: getLabel('tui.ui.responseInterrupted', options.lang),
          instructionInterrupted: getLabel('tui.ui.instructionInterrupted', options.lang),
        }}
        lang={options.lang}
        conversation={options.conversation}
        initialEntries={initialEntries}
        submitMode={options.submitMode}
        autoSubmit={autoSubmit}
        initialHistory={history}
        initialQueue={queue}
        modelLabel={options.modelLabel()}
        // A caller that carries decisions out mounts this view again, so the
        // images it pasted have to stay available.
        residentSession={options.dispatch !== undefined}
        onExit={(exit, carried) => {
          // A failure ends the run rather than the mount, so it is reported as
          // the mount's own failure and outranks anything the teardown hits.
          if (exit.kind === 'failed') {
            fail(exit.error);
            return;
          }
          settle({ exit, carried });
        }}
      />
    ), exitedEarly);

    history = settled.carried.history;
    queue = settled.carried.queue;
    // The transcript is already in the scrollback; printing it again doubles it.
    initialEntries = [];
    autoSubmit = false;

    switch (settled.exit.kind) {
      case 'result': {
        const finished = await settleDecision(settled.exit.result);
        if (finished !== undefined) {
          return finished;
        }
        break;
      }
      case 'choose_action': {
        const action = await options.chooseAction(settled.exit.task);
        if (action === null || action === 'continue') {
          info(options.continuePrompt);
          break;
        }
        const finished = await settleDecision({ action, task: settled.exit.task });
        if (finished !== undefined) {
          return finished;
        }
        break;
      }
      case 'resume_session': {
        const selected = await selectRecentSession(options.cwd, options.lang);
        if (selected !== null) {
          options.conversation.resumeSession(selected);
          info(getLabel('interactive.resumeSessionLoaded', options.lang));
        }
        break;
      }
      case 'handoff': {
        const onHandoff = options.onHandoff;
        if (onHandoff === undefined) {
          throw new Error(`No handler for the "${settled.exit.id}" hand-off`);
        }
        const outcome = await onHandoff(settled.exit.id);
        if (outcome.kind === 'finished') {
          return outcome.result;
        }
        initialEntries = outcome.notice === undefined
          ? []
          : [{ role: 'system', content: outcome.notice }];
        break;
      }
    }
  }
}
