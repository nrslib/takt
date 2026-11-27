import { DaemonPersistedFiles, type DaemonInquiryOwner } from '../../infra/daemon/persistedFiles.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';

export interface PendingGoalAnswer {
  repositoryDirectory: string;
  goalId: string;
  question: GoalQuestion;
}

export async function publishPendingInquiryAnswers(configDirectory: string, owners: readonly DaemonInquiryOwner[],
  publish: (owner: DaemonInquiryOwner, question: GoalQuestion) => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  const files = new DaemonPersistedFiles(configDirectory);
  for (const owner of owners) {
    let questions: GoalQuestion[];
    try { questions = await files.listPendingInquiryAnswerPublications(owner); }
    catch (error) { onError(error); continue; }
    for (const question of questions) {
      try {
        await publish(owner, question);
        await files.markInquiryAnswerPublished(owner, question.id);
      } catch (error) { onError(error); }
    }
  }
}

export async function publishPendingGoalAnswers(configDirectory: string, answers: readonly PendingGoalAnswer[],
  onError: (error: unknown) => void): Promise<void> {
  const files = new DaemonPersistedFiles(configDirectory);
  for (const { repositoryDirectory, goalId, question } of answers) {
    try {
      // 保存形式の検証で、印の付いた質問は回答済みで回答を持つことが保証されている。
      await files.saveGoalAnswer(repositoryDirectory, goalId, question.id, question.answer!);
      await files.markGoalAnswerPublished(repositoryDirectory, goalId, question.id);
    } catch (error) { onError(error); }
  }
}
