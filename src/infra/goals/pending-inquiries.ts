import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { StandaloneInquiryStore, type InquiryOwner } from './standalone-inquiries.js';
import { GoalStore } from './store.js';
import type { Goal, GoalQuestion } from './schema.js';

type InquiryAssignment = InquiryOwner & { readonly repositoryDirectories: readonly string[] };

export type PendingInquiry = {
  readonly question: GoalQuestion;
  readonly kind: NonNullable<GoalQuestion['kind']>;
  readonly summary: string;
} & (
  | { readonly goalId: string; readonly repositoryDirectory: string; readonly objective: string }
  | { readonly goalId: null; readonly repositoryDirectory?: never; readonly objective?: never }
);

interface PendingInquiryResult {
  inquiries: PendingInquiry[];
  errors: { repositoryDirectory: string; goalId: string; error: Error }[];
}

const SUMMARY_MAX_BYTES = 512;

function pendingQuestions(questions: readonly GoalQuestion[]): Pick<PendingInquiry, 'question' | 'kind' | 'summary'>[] {
  return questions.filter((question) => question.status === 'pending').map((question) => ({
    question, kind: question.kind ?? 'question', summary: truncateUtf8(question.body, SUMMARY_MAX_BYTES).value,
  }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface InquiryPosition {
  question: { id: string; createdAt?: string };
  repositoryDirectory?: string;
  goalId: string | null;
}

export function compareInquiries(left: InquiryPosition, right: InquiryPosition): number {
  const leftTime = left.question.createdAt === undefined ? Infinity : Date.parse(left.question.createdAt);
  const rightTime = right.question.createdAt === undefined ? Infinity : Date.parse(right.question.createdAt);
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return compareText(left.repositoryDirectory ?? '', right.repositoryDirectory ?? '')
    || compareText(left.goalId ?? '', right.goalId ?? '')
    || compareText(left.question.id, right.question.id);
}

export async function listPendingInquiries(configDirectory: string, assignment: InquiryAssignment): Promise<PendingInquiryResult> {
  const inquiries: PendingInquiry[] = [];
  const errors: PendingInquiryResult['errors'] = [];
  for (const repositoryDirectory of assignment.repositoryDirectories) {
    const result = await new GoalStore(repositoryDirectory).list((goal) => {
      const pending = pendingQuestions(goal.questions ?? []);
      return pending.length === 0 ? undefined : pending.map((entry) => ({
        ...entry, goalId: goal.id, repositoryDirectory, objective: goal.objective,
      }));
    });
    inquiries.push(...result.goals.flat());
    errors.push(...result.errors.map((entry) => ({ ...entry, repositoryDirectory })));
  }
  const standalone = await new StandaloneInquiryStore(configDirectory, assignment).listPending();
  inquiries.push(...pendingQuestions(standalone).map((entry) => ({ ...entry, goalId: null })));
  return {
    inquiries: inquiries.sort(compareInquiries),
    errors: errors.sort((left, right) => compareText(left.repositoryDirectory, right.repositoryDirectory) || compareText(left.goalId, right.goalId)),
  };
}

export function* projectPendingGoalInquiries(goal: Goal, repositoryDirectory: string): Generator<PendingInquiry> {
  for (const question of goal.questions ?? []) {
    if (question.status !== 'pending' || question.recipient !== 'human') continue;
    yield { question, kind: question.kind ?? 'question', summary: truncateUtf8(question.body, SUMMARY_MAX_BYTES).value,
      goalId: goal.id, repositoryDirectory, objective: goal.objective };
  }
}

export async function* iterateStandalonePendingInquiries(configDirectory: string, assignment: InquiryAssignment): AsyncGenerator<PendingInquiry> {
  for await (const question of new StandaloneInquiryStore(configDirectory, assignment).iteratePending()) {
    yield { question, kind: question.kind ?? 'question', summary: truncateUtf8(question.body, SUMMARY_MAX_BYTES).value, goalId: null };
  }
}

export async function* iteratePendingInquiries(configDirectory: string, assignment: InquiryAssignment): AsyncGenerator<PendingInquiry> {
  const inquiries: PendingInquiry[] = [];
  for (const repositoryDirectory of assignment.repositoryDirectories) {
    for await (const goal of new GoalStore(repositoryDirectory).iterate()) {
      for (const inquiry of projectPendingGoalInquiries(goal, repositoryDirectory)) inquiries.push(inquiry);
    }
  }
  for await (const inquiry of iterateStandalonePendingInquiries(configDirectory, assignment)) inquiries.push(inquiry);
  yield* inquiries.sort(compareInquiries);
}
