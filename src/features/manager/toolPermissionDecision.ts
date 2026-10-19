import type { ToolPermissionDecisionHandler } from '../../core/workflow/types.js';
import type { ProviderType } from '../../shared/types/provider.js';
import { getLabel } from '../../shared/i18n/index.js';
import { classifyManagerToolPermission } from './toolPermissionClassifier.js';
import { judgeManagerToolPermission, type ManagerPermissionGoal, type ManagerPermissionJudgePlan } from './toolPermissionJudge.js';
import { notifyManagerToolPermission } from './toolPermissionNotification.js';
import { saveManagerToolPermissionInquiry } from './toolPermissionInquiry.js';
import type { InquiryOwner } from '../../infra/goals/standalone-inquiries.js';

export function createManagerToolPermissionHandler(input: {
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
}): ToolPermissionDecisionHandler {
  return async (request) => {
    const classification = classifyManagerToolPermission(request, input.plan.language, input.provider);
    const result = classification.decision === 'judge'
      ? await judgeManagerToolPermission(input.plan, request, input) : classification;
    if (result.decision === 'allow') return result;
    let reason = result.reason;
    if (result.decision === 'ask') {
      let confirmation: string;
      try {
        const saved = await saveManagerToolPermissionInquiry({
          request, reason: result.reason, configDirectory: input.configDirectory, owner: input.owner, goal: input.goal,
        });
        confirmation = `${saved.id}: ${result.reason}`;
      } catch {
        const failure = input.plan.language === 'ja' ? '承認問い合わせの保存に失敗しました。' : 'Failed to save the approval inquiry.';
        confirmation = `${failure} ${result.reason}`;
      }
      reason = getLabel('manager.toolPermission.awaitingConfirmation', input.plan.language, { toolName: request.toolName, reason: confirmation });
    }
    input.onDenial(reason);
    if (result.decision === 'ask') {
      const message = await notifyManagerToolPermission({ cwd: input.cwd, goal: input.goal, message: reason });
      if (message !== undefined) input.onNotification?.(message);
    }
    return { decision: 'deny', reason };
  };
}
