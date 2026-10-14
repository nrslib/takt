import { randomUUID } from 'node:crypto';
import { GoalQuestionInputSchema, GoalQuestionSchema, type Goal, type GoalQuestionInput } from './schema.js';

export function addGoalQuestion(goal: Goal, input: GoalQuestionInput): { goal: Goal; questionId: string } {
  const id = randomUUID();
  if (goal.questions?.some((question) => question.id === id)) throw new Error('Question ID already exists');
  const question = GoalQuestionSchema.parse({ ...GoalQuestionInputSchema.parse(input), id, status: 'pending', createdAt: new Date().toISOString() });
  return { goal: { ...goal, questions: [...(goal.questions ?? []), question] }, questionId: id };
}

export function withdrawGoalQuestion(goal: Goal, questionId: string): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  if (question.status !== 'pending') return goal;
  return { ...goal, questions: goal.questions?.map((candidate) => candidate.id === questionId
    ? { ...candidate, status: 'withdrawn' } : candidate) };
}

export function answerGoalQuestion(goal: Goal, questionId: string, text: string): Goal {
  const question = goal.questions?.find((candidate) => candidate.id === questionId);
  if (question === undefined) throw new Error('Question does not exist');
  if (question.status !== 'pending') throw new Error('Question is not awaiting an answer');
  if (question.recipient !== 'human') throw new Error('Question is not addressed to a human');
  const answered = GoalQuestionSchema.parse({
    ...question, status: 'answered', answer: { text, source: 'tui', answeredAt: new Date().toISOString() },
  });
  return {
    ...goal,
    questions: goal.questions?.map((candidate) => candidate.id === questionId ? answered : candidate),
  };
}
