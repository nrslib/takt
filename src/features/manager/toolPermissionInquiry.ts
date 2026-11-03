import type { ToolPermissionDecisionRequest } from '../../core/workflow/types.js';
import { withInquiryLock } from '../../infra/goals/inquiry-lock.js';
import { createInquiry } from '../../infra/goals/inquiry.js';
import { addGoalQuestion, consumeGoalApproval, isSameGoalOperation } from '../../infra/goals/questions.js';
import type { Goal, GoalQuestion, GoalQuestionInput } from '../../infra/goals/schema.js';
import { resolveGoalBranchSha } from '../../infra/goals/git-command.js';
import { readWorkspace } from '../../infra/config/global/workspaceRegistry.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import { GoalStore } from '../../infra/goals/store.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import type { ManagerPermissionGoal } from './toolPermissionJudge.js';
import { readScopedPermissions, type ScopedPermissionFile } from './scopedPermissionStorage.js';
import { createPermissionProposal } from './inquiryAnswer.js';

export interface ManagerPermissionContext {
  candidate?: GoalQuestion;
  relatedInquiries: readonly GoalQuestion[];
  scopedPermissions: readonly ScopedPermissionFile[];
  readErrors: readonly string[];
}

function operationInput(request: ToolPermissionDecisionRequest): NonNullable<GoalQuestionInput['operation']> {
  return { toolName: request.toolName, args: JSON.stringify(request.toolInput) ?? 'null', cwd: request.cwd };
}

function readFailure(error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? `: ${readFailure(error.cause)}` : '';
  return sanitizeSensitiveText(getErrorMessage(error) + cause);
}

export async function resolveManagerPermissionContext(input: {
  request: ToolPermissionDecisionRequest;
  configDirectory: string;
  owner: InquiryOwner;
  goal?: ManagerPermissionGoal;
  abortSignal: AbortSignal;
}): Promise<ManagerPermissionContext> {
  const readErrors: string[] = [];
  let goal: Goal | undefined;
  let candidate: GoalQuestion | undefined;
  let relatedInquiries: GoalQuestion[] = [];
  try {
    goal = input.goal === undefined ? undefined : await new GoalStore(input.goal.repositoryDirectory).get(input.goal.id);
    const targetSha = goal === undefined ? undefined : await resolveGoalBranchSha(
      input.goal!.repositoryDirectory, goal.branch, input.request.abortSignal === undefined
        ? input.abortSignal : AbortSignal.any([input.abortSignal, input.request.abortSignal]),
    );
    candidate = createInquiry({ kind: 'approval', body: 'Permission operation', operation: operationInput(input.request), targetSha });
    const questions = goal === undefined
      ? await new StandaloneInquiryStore(input.configDirectory, input.owner).list() : goal.questions ?? [];
    relatedInquiries = questions.filter((question) => isSameGoalOperation(question, candidate!));
  } catch (error) {
    readErrors.push(readFailure(error));
    candidate = undefined;
  }

  let projectDirectory: string | undefined;
  const workspaceId = input.owner.kind === 'workspace' ? input.owner.workspaceId : undefined;
  try {
    if (input.goal !== undefined) projectDirectory = input.goal.repositoryDirectory;
    else if (input.owner.kind === 'repository') projectDirectory = input.owner.repositoryDirectory;
    else {
      const workspace = await readWorkspace(input.configDirectory, input.owner.workspaceId);
      if (workspace === undefined) throw new Error(`Workspace does not exist: ${input.owner.workspaceId}`);
      if (workspace.repositoryDirectories.length > 0) {
        const repository = await resolveGitRepositoryDirectory(input.request.cwd);
        if (workspace.repositoryDirectories.includes(repository)) projectDirectory = repository;
      }
    }
  } catch (error) {
    readErrors.push(readFailure(error));
  }
  const permissions = await readScopedPermissions({
    projectDirectory, workspaceId,
    goal: goal === undefined ? undefined : { repositoryDirectory: input.goal!.repositoryDirectory, record: goal },
  });
  if (!permissions.ok) readErrors.push(readFailure(permissions.error));
  return { candidate, relatedInquiries, scopedPermissions: permissions.ok ? permissions.files : [], readErrors };
}

export async function consumeManagerPermissionApproval(input: {
  configDirectory: string;
  owner: InquiryOwner;
  goal?: ManagerPermissionGoal;
  approval: GoalQuestion;
}): Promise<void> {
  const consumedAt = new Date().toISOString();
  if (input.goal === undefined) {
    await new StandaloneInquiryStore(input.configDirectory, input.owner).consumeApproval(input.approval, consumedAt);
    return;
  }
  await new GoalStore(input.goal.repositoryDirectory).update(input.goal.id, (current) => {
    const question = current.questions?.find(({ id }) => id === input.approval.id);
    if (question === undefined || !isSameGoalOperation(question, input.approval)) {
      throw new Error('Saved approval differs from the requested operation');
    }
    return consumeGoalApproval(current, input.approval.id, consumedAt);
  });
}

export async function saveManagerToolPermissionInquiry(input: {
  request: ToolPermissionDecisionRequest;
  reason: string;
  configDirectory: string;
  owner: InquiryOwner;
  goal?: ManagerPermissionGoal;
  targetSha?: string;
}): Promise<GoalQuestion> {
  const inquiry: GoalQuestionInput & { kind: 'approval' } = {
    kind: 'approval',
    body: sanitizeSensitiveText(input.reason),
    operation: operationInput(input.request),
    ...(input.targetSha === undefined ? {} : { targetSha: input.targetSha }),
  };
  inquiry.permissionProposal = createPermissionProposal(inquiry.operation!);
  if (input.goal !== undefined) {
    const candidate = createInquiry(inquiry);
    const matches = (question: GoalQuestion): boolean => question.kind === 'approval'
      && question.status === 'pending' && isSameGoalOperation(question, candidate);
    const saved = await withInquiryLock(input.configDirectory, () => new GoalStore(input.goal!.repositoryDirectory).update(input.goal!.id, (current) => {
      if (current.questions?.some(matches)) return current;
      return addGoalQuestion(current, inquiry).goal;
    }));
    return saved.questions!.find(matches)!;
  }
  const store = new StandaloneInquiryStore(input.configDirectory, input.owner);
  return store.getOrCreateApproval(inquiry);
}
