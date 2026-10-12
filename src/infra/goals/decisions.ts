import { randomUUID } from 'node:crypto';
import { GoalDecisionInputSchema, type Goal } from './schema.js';
import type { z } from 'zod/v4';

export function appendGoalDecision(goal: Goal, raw: z.infer<typeof GoalDecisionInputSchema>): { goal: Goal; decision: NonNullable<Goal['decisions']>[number] } {
  const input = GoalDecisionInputSchema.parse(raw);
  if (!goal.events?.some((event) => event.id === input.eventId)) throw new Error('Decision event does not exist');
  if (input.acceptanceCriteriaVersion !== goal.acceptanceCriteriaVersion) throw new Error('Acceptance criteria version does not match');
  if (input.supersedesDecisionId !== undefined && !goal.decisions?.some((decision) => decision.id === input.supersedesDecisionId)) {
    throw new Error('Superseded decision does not exist');
  }
  const duplicate = goal.decisions?.find((decision) => {
    const saved = Object.fromEntries(Object.entries(decision).filter(([key]) => !['id', 'recordedAt'].includes(key)));
    return JSON.stringify(saved) === JSON.stringify(input);
  });
  if (duplicate !== undefined) return { goal, decision: duplicate };
  const id = randomUUID();
  if (goal.decisions?.some((decision) => decision.id === id)) throw new Error('Decision ID already exists');
  const decision = { ...input, id, recordedAt: new Date().toISOString() };
  return { goal: { ...goal, decisions: [...(goal.decisions ?? []), decision] }, decision };
}
