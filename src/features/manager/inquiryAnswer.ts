import type { GoalQuestion } from '../../infra/goals/schema.js';
import type { InquiryOwner } from '../../infra/goals/standalone-inquiries.js';

export type PendingQuestion = { readonly question: GoalQuestion } & (
  | { readonly goalId: string; readonly objective: string; readonly repositoryDirectory: string }
  | { readonly goalId: null; readonly owner: InquiryOwner }
);
