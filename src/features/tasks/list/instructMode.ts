/**
 * Instruct mode for branch-based tasks.
 *
 * Provides conversation loop for additional instructions on existing branches,
 * similar to interactive mode but with branch context and limited actions.
 */

import {
  displayAndClearSessionState,
  runConversationLoop,
  type ConversationStrategy,
} from '../../interactive/conversationLoop.js';
import {
  type InteractiveModeResult,
  type WorkflowContext,
} from '../../interactive/interactive.js';
import { createSelectActionWithoutExecute } from '../../interactive/interactive-summary.js';
import { attachImageAttachmentCleanup } from '../../interactive/imageAttachments.js';
import { runTuiTaskConversation } from '../../tui/runTuiTask.js';
import type { RunSessionContext } from '../../interactive/runSessionReader.js';
import { getLabelObject } from '../../../shared/i18n/index.js';
import type { InstructModeAction, InstructModeResult, InstructUIText } from '../../interactive/instructModeTypes.js';
import type { PullRequestContext } from '../../../core/workflow/pr-context.js';
import { hasInteractiveTerminal } from '../../../shared/utils/index.js';
import { createInstructConversationPlan } from '../../interactive/taskActionConversationPlan.js';

export type { InstructModeAction, InstructModeResult, InstructUIText } from '../../interactive/instructModeTypes.js';

export interface InstructModeOptions {
  readonly cwd: string;
  readonly branchContext: string;
  readonly branchName: string;
  readonly taskName: string;
  readonly taskContent: string;
  readonly retryNote: string;
  readonly workflowContext?: WorkflowContext;
  readonly runSessionContext?: RunSessionContext;
  readonly previousOrderContent?: string | null;
  readonly prContext?: PullRequestContext;
  readonly failedContext?: FailedInstructContext;
}

export interface FailedInstructContext {
  readonly reportSummary: string;
  readonly worktreeSummary: string;
}

function toInstructModeResult(result: InteractiveModeResult): InstructModeResult {
  if (result.action === 'cancel') {
    return attachImageAttachmentCleanup({
      action: 'cancel',
      task: '',
      ...(result.source ? { source: result.source } : {}),
      ...(result.attachments ? { attachments: result.attachments } : {}),
    }, result.cleanupAttachments);
  }

  return attachImageAttachmentCleanup({
    action: result.action as InstructModeAction,
    task: result.task,
    ...(result.source ? { source: result.source } : {}),
    ...(result.attachments ? { attachments: result.attachments } : {}),
  }, result.cleanupAttachments);
}

export async function runInstructMode(
  options: InstructModeOptions,
): Promise<InstructModeResult> {
  const {
    cwd,
    workflowContext,
  } = options;
  const plan = createInstructConversationPlan(cwd, options);
  const ctx = plan.ctx;

  displayAndClearSessionState(cwd, ctx.lang);

  const ui = getLabelObject<InstructUIText>('instruct.ui', ctx.lang);

  const strategy: ConversationStrategy = {
    ...plan.strategy,
    selectAction: createSelectActionWithoutExecute(ui),
  };

  const result = hasInteractiveTerminal()
    ? await runTuiTaskConversation({ cwd, plan: { ctx, strategy }, workflowContext })
    : await runConversationLoop(cwd, ctx, strategy, workflowContext, undefined);

  return toInstructModeResult(result);
}
