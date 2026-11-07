import { DaemonPersistedFiles, type DaemonInquiryOwner } from '../../infra/daemon/persistedFiles.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';

export async function publishPendingInquiryAnswers(configDirectory: string, owners: readonly DaemonInquiryOwner[],
  publish: (owner: DaemonInquiryOwner, question: GoalQuestion) => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  const files = new DaemonPersistedFiles(configDirectory);
  for (const owner of owners) {
    for (const question of await files.listPendingInquiryAnswerPublications(owner)) {
      try {
        await publish(owner, question);
        await files.markInquiryAnswerPublished(owner, question.id);
      } catch (error) { onError(error); }
    }
  }
}
