import type { GoalAnswerInput, GoalQuestion } from '../../infra/goals/schema.js';
import type { InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import type { WritablePermissionScope } from './scopedPermissionStorage.js';
import type { ManagerAssignment } from './startupResolution.js';

export type PendingQuestion = { readonly question: GoalQuestion } & (
  | { readonly goalId: string; readonly objective: string; readonly repositoryDirectory: string }
  | { readonly goalId: null; readonly owner: InquiryOwner }
);

export type ManagerAnswerOptions = {
  readonly questionId: string;
  readonly answer: GoalAnswerInput;
  readonly abortSignal?: AbortSignal;
  readonly appendPermission?: AppendManagerAnswerPermission;
} & (
  | { readonly goalId: string; readonly repositoryDirectory: string }
  | { readonly goalId: null; readonly owner: InquiryOwner }
);

export type AppendManagerAnswerPermission = (assignment: ManagerAssignment) => Promise<void>;

export interface ApprovalScopeChoice {
  readonly value: NonNullable<GoalAnswerInput['scope']>;
  readonly label: string;
  readonly permission?: WritablePermissionScope;
}

export function approvalScopeChoices(target: PendingQuestion, assignment: ManagerAssignment): ApprovalScopeChoice[] {
  const choices: ApprovalScopeChoice[] = [{ value: 'once', label: 'once' }];
  if (target.goalId !== null) choices.push({ value: 'goal', label: 'goal' });
  const projectDirectory = target.goalId === null ? target.question.operation!.cwd : target.repositoryDirectory;
  choices.push({
    value: 'project', label: assignment.repositoryDirectories.length === 1 ? 'projectManager' : 'project',
    permission: { kind: 'project', projectDirectory },
  });
  if (assignment.kind === 'workspace' && assignment.repositoryDirectories.length > 1) {
    choices.push({ value: 'workspace', label: 'workspace', permission: { kind: 'workspace', workspaceId: assignment.workspaceId } });
  }
  choices.push({ value: 'global', label: 'global', permission: { kind: 'global' } });
  return choices;
}

// 各要素を残しながら、TUIで確認・編集できる長さに収める。
const PROPOSAL_ELEMENT_LIMIT = 1024;

function proposalExcerpt(value: string): string {
  const text = sanitizeSensitiveText(value).replace(/\s+/gu, ' ').trim();
  return text.length <= PROPOSAL_ELEMENT_LIMIT ? text : `${text.slice(0, PROPOSAL_ELEMENT_LIMIT - 1)}…`;
}

export function createPermissionProposal(operation: Pick<NonNullable<GoalQuestion['operation']>, 'toolName' | 'args' | 'cwd'>): string {
  return `Allow ${proposalExcerpt(operation.toolName)} with ${proposalExcerpt(operation.args)} in ${proposalExcerpt(operation.cwd)}.`;
}
