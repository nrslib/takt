import { listRegisteredGoals } from '../../infra/goals/registration.js';
import { readManagerRunFailures } from '../../infra/task/manager-run-state.js';
import { getErrorMessage } from '../../shared/utils/error.js';

export async function readManagerDisplayEvents(cwd: string): Promise<{
  events: { id: string; message: string }[]; diagnostics: string[];
}> {
  const events: { id: string; message: string }[] = [];
  const diagnostics: string[] = [];
  try {
    const { goals, errors } = await listRegisteredGoals(cwd);
    events.push(...goals.flatMap((goal) => (goal.events ?? []).flatMap((event) => event.summary === undefined ? [] : [{
      id: JSON.stringify([goal.id, event.taskName, event.runSlug]), message: event.summary,
    }])));
    diagnostics.push(...errors.map(({ goalId, error }) => `${goalId}: ${getErrorMessage(error)}`));
  } catch (error) { diagnostics.push(getErrorMessage(error)); }
  try {
    events.push(...readManagerRunFailures(cwd).map((failure) => ({ id: failure.id, message: failure.message })));
  } catch (error) { diagnostics.push(getErrorMessage(error)); }
  return { events, diagnostics };
}
