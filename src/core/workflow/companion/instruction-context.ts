import type { InstructionContext } from '../instruction/instruction-context.js';
import type { CompanionReviewMode } from '../../models/companion-types.js';
import { isNormalOrTeamLeaderWorkflowStep, type WorkflowStep } from '../../models/workflow-types.js';
import { buildCompanionMailboxDirectory } from './mailbox.js';

export function buildCompanionInstructionContext(input: {
  readonly companionEnabled: boolean;
  readonly companionReviewMode: CompanionReviewMode;
  readonly cwd: string;
  readonly step: WorkflowStep;
  readonly runSlug: string;
  readonly runPathNamespace: readonly string[];
}): InstructionContext['companion'] | undefined {
  if (
    !input.companionEnabled
    || !isNormalOrTeamLeaderWorkflowStep(input.step)
    || input.step.companion === undefined
  ) {
    return undefined;
  }
  return {
    mailboxDirectory: buildCompanionMailboxDirectory({
      cwd: input.cwd,
      runSlug: input.runSlug,
      runPathNamespace: input.runPathNamespace,
      stepName: input.step.name,
    }),
    reviewMode: input.companionReviewMode,
  };
}
