import type { ToolPermissionDecisionHandler } from '../../core/workflow/types.js';
import { classifyManagerToolPermission } from './toolPermissionClassifier.js';
import { judgeManagerToolPermission, type ManagerPermissionGoal, type ManagerPermissionJudgePlan } from './toolPermissionJudge.js';
import { notifyManagerToolPermission } from './toolPermissionNotification.js';

export function createManagerToolPermissionHandler(input: {
  plan: ManagerPermissionJudgePlan;
  cwd: string;
  instruction: string;
  goal?: ManagerPermissionGoal;
  abortSignal: AbortSignal;
  onNotification?: (message: string) => void;
  onDenial: (reason: string) => void;
}): ToolPermissionDecisionHandler {
  return async (request) => {
    const classification = classifyManagerToolPermission(request);
    const result = classification.decision === 'judge'
      ? await judgeManagerToolPermission(input.plan, request, input) : classification;
    if (result.decision === 'allow') return result;
    const reason = result.decision === 'ask'
      ? `人の確認待ち (${request.toolName}): ${result.reason}` : result.reason;
    input.onDenial(reason);
    if (result.decision === 'ask') {
      const message = await notifyManagerToolPermission({ cwd: input.cwd, goal: input.goal, message: reason });
      if (message !== undefined) input.onNotification?.(message);
    }
    return { decision: 'deny', reason };
  };
}
