import { DaemonPersistedFiles, type DaemonInquiryOwner } from '../../infra/daemon/persistedFiles.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';

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
