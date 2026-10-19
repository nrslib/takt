import type { ToolPermissionDecisionRequest } from '../../core/workflow/types.js';
import { createInquiry } from '../../infra/goals/inquiry.js';
import { addGoalQuestion, isSameGoalOperation } from '../../infra/goals/questions.js';
import type { GoalQuestion, GoalQuestionInput } from '../../infra/goals/schema.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import { GoalStore } from '../../infra/goals/store.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import type { ManagerPermissionGoal } from './toolPermissionJudge.js';

export async function saveManagerToolPermissionInquiry(input: {
  request: ToolPermissionDecisionRequest;
  reason: string;
  configDirectory: string;
  owner: InquiryOwner;
  goal?: ManagerPermissionGoal;
}): Promise<GoalQuestion> {
  const inquiry: GoalQuestionInput & { kind: 'approval' } = {
    kind: 'approval',
    body: sanitizeSensitiveText(input.reason),
    operation: {
      toolName: input.request.toolName,
      args: JSON.stringify(input.request.toolInput) ?? 'null',
      cwd: input.request.cwd,
    },
  };
  if (input.goal !== undefined) {
    const candidate = createInquiry(inquiry);
    const matches = (question: GoalQuestion): boolean => question.kind === 'approval'
      && question.status === 'pending' && isSameGoalOperation(question, candidate);
    const saved = await new GoalStore(input.goal.repositoryDirectory).update(input.goal.id, (current) => {
      if (current.questions?.some(matches)) return current;
      return addGoalQuestion(current, inquiry).goal;
    });
    return saved.questions!.find(matches)!;
  }
  const store = new StandaloneInquiryStore(input.configDirectory, input.owner);
  return store.getOrCreateApproval(inquiry);
}
