import type { ToolPermissionDecisionHandler, ToolPermissionDecisionRequest } from '../../core/workflow/types.js';
import type { ProviderType } from '../../shared/types/provider.js';
import { getLabel } from '../../shared/i18n/index.js';
import { classifyManagerToolPermission } from './toolPermissionClassifier.js';
import { judgeManagerToolPermission, type Judgment, type ManagerPermissionGoal, type ManagerPermissionJudgePlan } from './toolPermissionJudge.js';
import { notifyManagerToolPermission } from './toolPermissionNotification.js';
import { consumeManagerPermissionApproval, resolveManagerPermissionContext, saveManagerToolPermissionInquiry, type ManagerPermissionContext } from './toolPermissionInquiry.js';
import type { InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import { isGoalApprovalUsable } from '../../infra/goals/questions.js';

interface ManagerPermissionHandlerInput {
  plan: ManagerPermissionJudgePlan;
  provider: ProviderType;
  cwd: string;
  configDirectory: string;
  owner: InquiryOwner;
  instruction: string;
  goal?: ManagerPermissionGoal;
  abortSignal: AbortSignal;
  onNotification?: (message: string) => void;
  onDenial: (reason: string) => void;
}

function awaitingConfirmation(input: ManagerPermissionHandlerInput, request: ToolPermissionDecisionRequest, confirmation: string): string {
  return getLabel('manager.toolPermission.awaitingConfirmation', input.plan.language, { toolName: request.toolName, reason: confirmation });
}

async function decidePermission(
  input: ManagerPermissionHandlerInput, request: ToolPermissionDecisionRequest, context: ManagerPermissionContext,
): Promise<Judgment> {
  if (input.abortSignal.aborted || request.abortSignal?.aborted) {
    return { decision: 'deny', reason: getLabel('manager.toolPermission.judgeInterrupted', input.plan.language) };
  }
  const approvals = context.relatedInquiries.filter((question) => question.kind === 'approval');
  const denied = approvals.find((question) => question.status === 'answered' && question.answer?.decision === 'deny');
  if (denied !== undefined) {
    return { decision: 'deny', reason: denied.answer!.text.trim().length > 0
      ? denied.answer!.text : getLabel('manager.toolPermission.savedDenial', input.plan.language) };
  }
  const pending = approvals.find((question) => question.status === 'pending');
  if (pending !== undefined && context.readErrors.length === 0) {
    return { decision: 'deny', reason: awaitingConfirmation(input, request, `${pending.id}: ${pending.body}`) };
  }
  const allowed = approvals.find(isGoalApprovalUsable);
  if (allowed !== undefined && context.readErrors.length === 0) {
    if (allowed.answer!.scope === 'once') {
      try {
        await consumeManagerPermissionApproval({ ...input, approval: allowed });
        if (input.abortSignal.aborted || request.abortSignal?.aborted) {
          return { decision: 'deny', reason: getLabel('manager.toolPermission.judgeInterrupted', input.plan.language) };
        }
      } catch {
        return { decision: 'deny', reason: getLabel('manager.toolPermission.consumptionFailed', input.plan.language) };
      }
    }
    return { decision: 'allow' };
  }
  const result = await judgeManagerToolPermission(input.plan, request, { ...input, context });
  if (result.decision === 'deny') return result;
  if (context.readErrors.length > 0) {
    return { decision: 'ask', reason: getLabel('manager.toolPermission.contextReadFailed', input.plan.language, { reason: context.readErrors.join('; ') }) };
  }
  if (approvals.some((question) => question.consumedAt !== undefined && question.answer?.scope === 'once')) {
    return { decision: 'ask', reason: getLabel('manager.toolPermission.approvalConsumed', input.plan.language) };
  }
  return result;
}

export function createManagerToolPermissionHandler(input: ManagerPermissionHandlerInput): ToolPermissionDecisionHandler {
  return async (request) => {
    const classification = classifyManagerToolPermission(request, input.plan.language, input.provider);
    const turn = { ...input };
    const context = classification.decision === 'judge' ? await resolveManagerPermissionContext({ ...turn, request }) : undefined;
    const result = classification.decision === 'judge'
      ? await decidePermission(turn, request, context!) : classification;
    if (result.decision === 'allow') return result;
    let reason = result.reason;
    if (result.decision === 'ask') {
      let confirmation: string;
      try {
        if (turn.goal !== undefined && context?.candidate === undefined) throw new Error('Goal operation could not be resolved');
        const saved = await saveManagerToolPermissionInquiry({
          request, reason: result.reason, configDirectory: turn.configDirectory, owner: turn.owner, goal: turn.goal,
          targetSha: context?.candidate?.targetSha,
        });
        confirmation = `${saved.id}: ${result.reason}`;
      } catch {
        const failure = getLabel('manager.toolPermission.inquirySaveFailed', input.plan.language);
        confirmation = `${failure} ${result.reason}`;
      }
      reason = awaitingConfirmation(turn, request, confirmation);
    }
    turn.onDenial(reason);
    if (result.decision === 'ask') {
      const message = await notifyManagerToolPermission({ cwd: turn.cwd, goal: turn.goal, message: reason });
      if (message !== undefined) turn.onNotification?.(message);
    }
    return { decision: 'deny', reason };
  };
}
