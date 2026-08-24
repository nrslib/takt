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
import type { EditorDraft } from './editorState.js';
import { mountInk } from './inkMount.js';
import type { TranscriptEntry } from './TranscriptEntryView.js';
import type { InteractiveResultSource, TuiConversation, TuiHandoffId } from './tuiConversation.js';

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
  /**
   * Runs the post-summary selector on the bare terminal. The task it answers
   * with is what the run returns: a mode may normalize the draft (Retry and
   * Instruct append the attachment list) before showing it for confirmation.
   * `origin` is the command path the task came from, which decides which of the
   * mode's selectors runs.
   */
  readonly chooseAction: (
    task: string,
    origin?: InteractiveResultSource,
  ) => Promise<{ action: PostSummaryAction; task: string } | null>;
  /** Printed when the selector says to keep editing. */
  readonly continuePrompt: string;
  /**
   * Carries out the decision with Ink unmounted and returns the line to greet
   * the session with. Left out by a caller that wants the decision handed back
   * instead — the run then ends there.
   */
  readonly dispatch?: (result: InteractiveModeResult) => Promise<string | null>;
  /**
   * Runs what a `handoff` command asked for, with Ink unmounted, together with
   * whatever was typed alongside the command. It answers with the line to greet
   * the session with, or with the result that ends the run.
   */
  readonly onHandoff?: (id: TuiHandoffId, text: string) => Promise<TuiHandoffOutcome>;
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
   * The line the last mount was in the middle of. A selector or a hand-off can
   * come out of the queue while the user is still typing, and the words they
   * had reached by then are theirs to keep.
   */
  let draft: EditorDraft | undefined;

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
        initialDraft={draft}
        initialQueue={queue}
        modelLabel={options.modelLabel}
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
    draft = settled.carried.draft;
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
        const origin = settled.exit.origin;
        const chosen = await options.chooseAction(settled.exit.task, origin);
        if (chosen === null || chosen.action === 'continue') {
          // Only a `/go` draft that was turned down goes back into the
          // conversation, exactly as the readline loop records it: it is the
          // proposal the next revision starts from. Leaving the selector
          // altogether records nothing, and neither does `/retry`, whose task is
          // the order the mode already has rather than something just drafted.
          if (chosen !== null && origin === 'go') {
            options.conversation.recordRejectedDraft?.(chosen.task);
          }
          info(options.continuePrompt);
          break;
        }
        const finished = await settleDecision({
          action: chosen.action,
          task: chosen.task,
          ...(options.conversation.tracksResultSource && origin ? { source: origin } : {}),
        });
        if (finished !== undefined) {
          return finished;
        }
        break;
      }
      case 'resume_session': {
        const selected = await selectRecentSession(options.cwd, options.lang);
        if (selected !== null) {
          const notice = await options.conversation.resumeSession(selected);
          initialEntries = notice === undefined
            ? []
            : [{ role: 'system', content: notice }];
          if (notice === undefined) {
            info(getLabel('interactive.resumeSessionLoaded', options.lang));
          }
        }
        break;
      }
      case 'handoff': {
        const onHandoff = options.onHandoff;
        if (onHandoff === undefined) {
          throw new Error(`No handler for the "${settled.exit.id}" hand-off`);
        }
        const outcome = await onHandoff(settled.exit.id, settled.exit.text ?? '');
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
