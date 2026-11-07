import { StandaloneInquiryStore, type InquiryOwner } from '../../infra/goals/standalone-inquiries.js';
import type { GoalQuestion } from '../../infra/goals/schema.js';

export async function publishPendingInquiryAnswers(configDirectory: string, owners: readonly InquiryOwner[],
  publish: (owner: InquiryOwner, question: GoalQuestion) => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  for (const owner of owners) {
    const store = new StandaloneInquiryStore(configDirectory, owner);
    for (const question of await store.listPendingPublications()) {
      try {
        await publish(owner, question);
        await store.markAnswerPublished(question.id);
      } catch (error) { onError(error); }
    }
  }
}
