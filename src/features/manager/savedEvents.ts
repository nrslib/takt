import { basename } from 'node:path';
import type { Language } from '../../core/models/types.js';
import { resolveConfigValue } from '../../infra/config/resolveConfigValue.js';
import { GoalStore } from '../../infra/goals/store.js';
import { readManagerRunFailures } from '../../infra/task/manager-run-state.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { formatGoalNotification } from '../../infra/goals/notifications.js';
import type { Goal, GoalQuestion } from '../../infra/goals/schema.js';

export type ManagerDisplayGoal = Pick<Goal, 'id' | 'objective' | 'executionStatus'>;

export async function readManagerDisplayEvents(cwd: string, language: Language = resolveConfigValue(cwd, 'language')): Promise<{
  events: { id: string; message: string }[]; diagnostics: { id: string; message: string }[];
  questions: { goalId: string; objective: string; question: GoalQuestion }[];
  goals: ManagerDisplayGoal[];
}> {
  const events: { id: string; message: string }[] = [];
  const diagnostics: { id: string; message: string }[] = [];
  const questions: { goalId: string; objective: string; question: GoalQuestion }[] = [];
  const displayGoals: ManagerDisplayGoal[] = [];
  const project = basename(cwd);
  try {
    const { goals, errors } = await new GoalStore(cwd).list();
    displayGoals.push(...goals.map(({ id, objective, executionStatus }) => ({ id, objective, executionStatus })));
    for (const goal of goals) {
      questions.push(...(goal.questions ?? []).filter((question) => question.status === 'pending' && question.recipient === 'human')
        .map((question) => ({ goalId: goal.id, objective: goal.objective, question })));
      events.push(...(goal.notifications ?? []).map((notification) => ({
        id: JSON.stringify([goal.id, 'notification', notification.id]), message: formatGoalNotification(goal, notification, language, project, 'tui'),
      })));
    }
    diagnostics.push(...errors.map(({ goalId, error }) => ({
      id: JSON.stringify(['diagnostic', 'goal', goalId, getErrorMessage(error)]),
      message: `${goalId}: ${getErrorMessage(error)}`,
    })));
  } catch (error) {
    const message = getErrorMessage(error);
    diagnostics.push({ id: JSON.stringify(['diagnostic', 'goals', message]), message });
  }
  try {
    events.push(...readManagerRunFailures(cwd).map((failure) => ({ id: failure.id, message: failure.message })));
  } catch (error) {
    const message = getErrorMessage(error);
    diagnostics.push({ id: JSON.stringify(['diagnostic', 'run-failures', message]), message });
  }
  return { events, diagnostics, questions, goals: displayGoals };
}
