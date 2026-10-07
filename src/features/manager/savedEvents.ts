import { GoalStore } from '../../infra/goals/store.js';
import { readManagerRunFailures } from '../../infra/task/manager-run-state.js';
import { getErrorMessage } from '../../shared/utils/error.js';

export async function readManagerDisplayEvents(cwd: string): Promise<{
  events: { id: string; message: string }[]; diagnostics: { id: string; message: string }[];
}> {
  const events: { id: string; message: string }[] = [];
  const diagnostics: { id: string; message: string }[] = [];
  try {
    const { goals, errors } = await new GoalStore(cwd).list();
    events.push(...goals.flatMap((goal) => (goal.events ?? []).flatMap((event) => event.summary === undefined ? [] : [{
      id: JSON.stringify([goal.id, event.taskName, event.runSlug]), message: event.summary,
    }])));
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
  return { events, diagnostics };
}
