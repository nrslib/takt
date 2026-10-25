import type { ManagerAssignment } from './startupResolution.js';
import type { ConversationCommand, OperationResult } from './conversationPort.js';
import { ConversationError, conversationErrorResult } from './conversationErrors.js';
import { GoalStore } from '../../infra/goals/store.js';
import { StandaloneInquiryStore } from '../../infra/goals/standalone-inquiries.js';
import { answerInquiry } from '../../infra/goals/inquiry.js';
import { answerGoalQuestion } from '../../infra/goals/questions.js';
import { saveManagerEvent } from '../../infra/goals/events.js';
import { appendScopedPermission } from './scopedPermissionStorage.js';
import { resolveAssignedProjectRoot } from './assignment.js';
import { ensureManagerRun } from './autoRun.js';
import { getLabel } from '../../shared/i18n/index.js';

export async function answerConversationInquiry(
  command: Extract<ConversationCommand, { kind: 'answer_question' }>, assignment: ManagerAssignment,
  configDirectory: string, signal: AbortSignal, language: 'ja' | 'en',
): Promise<OperationResult> {
  let answerSaved = false;
  let permissionAppended = false;
  try {
    signal.throwIfAborted();
    const target = command.target;
    if (target.goalId !== null && !assignment.repositoryDirectories.includes(target.repositoryDirectory)) throw new ConversationError('invalid_assignment');
    if (target.goalId === null && (target.owner.kind !== assignment.kind
      || (target.owner.kind === 'workspace' && assignment.kind === 'workspace' && target.owner.workspaceId !== assignment.workspaceId)
      || (target.owner.kind === 'repository' && assignment.kind === 'repository' && target.owner.repositoryDirectory !== assignment.repositoryDirectory))) {
      throw new ConversationError('invalid_assignment');
    }
    const standalone = target.goalId === null ? new StandaloneInquiryStore(configDirectory, target.owner) : undefined;
    const question = target.goalId === null ? await standalone!.get(command.questionId)
      : (await new GoalStore(target.repositoryDirectory).get(target.goalId)).questions?.find(({ id }) => id === command.questionId);
    if (question === undefined) throw new ConversationError('invalid_input');
    // Validate the complete answer against the saved inquiry before changing any permission file.
    answerInquiry(question, command.answer);
    const permission = command.permission;
    if (permission !== undefined) {
      let scope = permission.scope;
      if (question.kind !== 'approval' || command.answer.decision !== 'allow'
        || command.answer.scope !== permission.scope.kind || permission.sentence.trim().length === 0
        || /\p{Cc}/u.test(permission.sentence)) throw new ConversationError('invalid_input');
      if (permission.scope.kind === 'project') {
        const root = await resolveAssignedProjectRoot(permission.scope.projectDirectory, assignment);
        const operationRoot = await resolveAssignedProjectRoot(question.operation!.cwd, assignment);
        if (root !== operationRoot) throw new ConversationError('invalid_assignment');
        scope = { kind: 'project', projectDirectory: root };
      }
      if (permission.scope.kind === 'workspace'
        && (assignment.kind !== 'workspace' || permission.scope.workspaceId !== assignment.workspaceId)) throw new ConversationError('invalid_assignment');
      signal.throwIfAborted();
      await appendScopedPermission({ scope, heading: '許可', sentence: permission.sentence });
      permissionAppended = true;
    }
    signal.throwIfAborted();
    if (target.goalId === null) {
      await standalone!.answer(command.questionId, command.answer);
      answerSaved = true;
    } else {
      const saved = await new GoalStore(target.repositoryDirectory).update(target.goalId,
        (goal) => answerGoalQuestion(goal, command.questionId, command.answer), () => { answerSaved = true; });
      const answer = saved.questions!.find(({ id }) => id === command.questionId)!.answer!;
      saveManagerEvent(target.repositoryDirectory, { kind: 'answer', goalId: target.goalId, questionId: command.questionId, answer });
      await ensureManagerRun(target.repositoryDirectory);
    }
    return { kind: 'answer_saved', answerSaved, message: getLabel('manager.conversation.answer_saved', language) };
  } catch (error) {
    return { ...conversationErrorResult(error, language), answerSaved, permissionAppended };
  }
}
