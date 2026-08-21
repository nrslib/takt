/**
 * The retry and instruct conversations, on the Ink TUI.
 *
 * These modes talk about one task and hand a single decision back to their
 * caller — there is no workflow to pick, no mode to choose, and nothing to
 * dispatch. What they do bring is their own action selector and their own
 * `/retry` / `/replay` wiring, which the strategy carries and the conversation
 * reads.
 */

import { getLabel } from '../../shared/i18n/index.js';
import type { ConversationPlan } from '../interactive/conversationPlan.js';
import type { WorkflowContext } from '../interactive/interactive-summary.js';
import {
  selectPostSummaryAction,
  type PostSummaryAction,
} from '../interactive/interactive-summary.js';
import type { InteractiveUIText } from '../interactive/interactive.js';
import { getLabelObject } from '../../shared/i18n/index.js';
import {
  buildInteractiveResultWithAttachments,
  cleanupImageAttachmentStore,
  cleanupImageAttachmentStoreOnProcessExit,
  createSessionImageAttachmentStore,
} from '../interactive/imageAttachments.js';
import type { InteractiveModeResult } from '../interactive/interactive.js';
import { handOverAttachments } from './attachmentHandover.js';
import { runTuiConversation } from './conversationRunner.js';
import { createTuiConversation } from './tuiConversation.js';
import { describeSessionModel } from './tuiSetup.js';

export interface RunTuiTaskConversationOptions {
  readonly cwd: string;
  /** Session context plus the mode's strategy, exactly as the readline modes build it. */
  readonly plan: ConversationPlan;
  /** Left out when the mode has no workflow to describe to the summary prompt. */
  readonly workflowContext?: WorkflowContext;
}

/** Runs one task conversation and returns what the user decided. */
export async function runTuiTaskConversation(
  options: RunTuiTaskConversationOptions,
): Promise<InteractiveModeResult> {
  const { ctx, strategy } = options.plan;
  const attachmentStore = createSessionImageAttachmentStore(options.cwd);
  // The selectors this run opens end the process themselves when interrupted,
  // so the temp files get a net that does not depend on this call finishing.
  const releaseExitCleanup = cleanupImageAttachmentStoreOnProcessExit(attachmentStore);
  let handedOver = false;

  const ui = getLabelObject<InteractiveUIText>('interactive.ui', ctx.lang);
  const chooseAction = (task: string): Promise<PostSummaryAction | null> => (
    strategy.selectAction
      ? strategy.selectAction(task, ctx.lang)
      : selectPostSummaryAction(task, ui.proposed, ui)
  );

  try {
    const result = await runTuiConversation({
      cwd: options.cwd,
      lang: ctx.lang,
      conversation: createTuiConversation({
        cwd: options.cwd,
        plan: options.plan,
        ...(options.workflowContext ? { workflowContext: options.workflowContext } : {}),
        attachmentStore,
      }),
      // The intro the readline mode prints before its loop, kept as the line the
      // conversation opens with.
      initialEntries: [{ role: 'system', content: strategy.introMessage }],
      submitMode: 'chat',
      autoSubmit: false,
      modelLabel: () => getLabel('tui.ui.model', ctx.lang, { value: describeSessionModel(ctx) }),
      chooseAction,
      continuePrompt: ui.continuePrompt,
    });
    const handedOverResult = handOverAttachments(
      buildInteractiveResultWithAttachments(result, attachmentStore),
      releaseExitCleanup,
    );
    handedOver = true;
    return handedOverResult;
  } catch (error) {
    // Nothing was handed to the caller, so nothing is left to clean the pasted
    // images up but this.
    cleanupImageAttachmentStore(attachmentStore);
    throw error;
  } finally {
    if (!handedOver) {
      releaseExitCleanup();
    }
  }
}
