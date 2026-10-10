import { GoalStore } from '../../infra/goals/store.js';
import { readManagerRunFailures } from '../../infra/task/manager-run-state.js';
import { getErrorMessage } from '../../shared/utils/error.js';
import { formatGoalNotification, isDirectorQuestionNotification } from '../../infra/goals/notifications.js';
import type { Goal, GoalQuestion } from '../../infra/goals/schema.js';

export type ManagerDisplayGoal = Pick<Goal, 'id' | 'objective' | 'executionStatus'>;

export async function readManagerDisplayEvents(cwd: string): Promise<{
  events: { id: string; message: string }[]; diagnostics: { id: string; message: string }[];
  questions: { goalId: string; objective: string; question: GoalQuestion }[];
  goals: ManagerDisplayGoal[];
}> {
  const events: { id: string; message: string }[] = [];
  const diagnostics: { id: string; message: string }[] = [];
  const questions: { goalId: string; objective: string; question: GoalQuestion }[] = [];
  const displayGoals: ManagerDisplayGoal[] = [];
  try {
    const { goals, errors } = await new GoalStore(cwd).list();
    displayGoals.push(...goals.map(({ id, objective, executionStatus }) => ({ id, objective, executionStatus })));
    events.push(...goals.flatMap((goal) => (goal.events ?? []).flatMap((event) => event.summary === undefined ? [] : [{
      id: event.kind === 'completion' ? JSON.stringify([goal.id, event.taskName, event.runSlug])
        : event.kind === 'answer' ? JSON.stringify([goal.id, 'answer', event.questionId]) : JSON.stringify([goal.id, event.id]), message: event.summary,
    }])));
    for (const goal of goals) {
      questions.push(...(goal.questions ?? []).filter((question) => question.status === 'pending' && question.recipient === 'human')
        .map((question) => ({ goalId: goal.id, objective: goal.objective, question })));
      events.push(...(goal.notifications ?? []).filter((notification) => !isDirectorQuestionNotification(goal, notification)).map((notification) => ({
        id: JSON.stringify([goal.id, 'notification', notification.id]), message: formatGoalNotification(goal, notification),
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
