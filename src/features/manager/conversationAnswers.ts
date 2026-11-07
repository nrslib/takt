import type { ManagerAssignment } from './startupResolution.js';
import type { ConversationCommand, OperationResult } from './conversationPort.js';
import { ConversationError, conversationErrorResult } from './conversationErrors.js';
import { GoalStore } from '../../infra/goals/store.js';
import { StandaloneInquiryStore } from '../../infra/goals/standalone-inquiries.js';
import { answerGoalQuestion } from '../../infra/goals/questions.js';
import { saveManagerEvent } from '../../infra/goals/events.js';
import { ensureManagerRun } from './autoRun.js';
import { getLabel } from '../../shared/i18n/index.js';
import type { TurnIo } from '../daemonTurn/processRuntime.js';

export async function answerConversationInquiry(
  command: Extract<ConversationCommand, { kind: 'answer_question' }>, assignment: ManagerAssignment,
  configDirectory: string, io: Pick<TurnIo, 'signal' | 'request'>, language: 'ja' | 'en',
): Promise<OperationResult> {
  let answerSaved = false;
  const { signal } = io;
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
    if (question === undefined || question.kind === 'approval') throw new ConversationError('invalid_input');
    signal.throwIfAborted();
    if (target.goalId === null) {
      const saved = await standalone!.answerForPublication(command.questionId, command.answer, command.source);
      answerSaved = true;
      if (assignment.kind === 'workspace') {
        const reply = await io.request({ kind: 'publish_workspace_inquiry_answer', questionId: command.questionId });
        if (reply.kind !== 'event_accepted' || reply.admission.kind !== 'accepted') throw new ConversationError('operation_failed');
      } else {
        const repository = question.operation?.cwd ?? assignment.repositoryDirectory;
        if (!assignment.repositoryDirectories.includes(repository)) throw new ConversationError('invalid_assignment');
        saveManagerEvent(repository, { kind: 'answer', goalId: null, questionId: command.questionId,
          questionBody: saved.body, answer: saved.answer! });
      }
      await standalone!.markAnswerPublished(command.questionId);
    } else {
      const saved = await new GoalStore(target.repositoryDirectory).update(target.goalId,
        (goal) => answerGoalQuestion(goal, command.questionId, command.answer, command.source), () => { answerSaved = true; });
      const answer = saved.questions!.find(({ id }) => id === command.questionId)!.answer!;
      saveManagerEvent(target.repositoryDirectory, { kind: 'answer', goalId: target.goalId, questionId: command.questionId, answer });
      await ensureManagerRun(target.repositoryDirectory);
    }
    return { kind: 'answer_saved', answerSaved, message: getLabel('manager.conversation.answer_saved', language) };
  } catch (error) {
    return { ...conversationErrorResult(error, language), answerSaved };
  }
}
