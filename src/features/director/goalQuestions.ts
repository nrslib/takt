import type { AcceptedEvent } from '../../core/daemon/events.js';
import { GoalStore } from '../../infra/goals/store.js';
import { answerGoalQuestionForPublication } from '../../infra/goals/answer-publication.js';
import { escalateGoalQuestion, setGoalQuestionRoute } from '../../infra/goals/questions.js';
import type { GoalAnswerInput, GoalQuestionRoute } from '../../infra/goals/schema.js';
import type { DirectorMessageOrigin } from '../../infra/conversations/schema.js';
import { resolveDirectorManager } from './managers.js';

export interface DirectorGoalTarget { managerId: string; cwd: string; goalId: string }

export async function assertDirectorGoalTarget(configDirectory: string, target: DirectorGoalTarget): Promise<void> {
  const assignment = await resolveDirectorManager(configDirectory, target.managerId);
  if (!assignment.repositoryDirectories.includes(target.cwd)) throw new Error('Repository is outside manager assignment');
}

export async function changeDirectorGoalQuestionRoute(configDirectory: string, target: DirectorGoalTarget,
  route: GoalQuestionRoute, origin: DirectorMessageOrigin, event: AcceptedEvent, signal: AbortSignal) {
  if (origin !== 'human' || event.event.kind !== 'human_command' || event.event.command.kind !== 'message'
    || event.event.speaker.namespace === 'agent' || !['tui', 'slack'].includes(event.source)) {
    throw new Error('A current human instruction is required to change the question route');
  }
  await assertDirectorGoalTarget(configDirectory, target);
  signal.throwIfAborted();
  const goal = await new GoalStore(target.cwd).update(target.goalId, (current) => {
    signal.throwIfAborted();
    return setGoalQuestionRoute(current, route);
  });
  return { goalId: goal.id, creationOrigin: goal.creationOrigin, questionRoute: goal.questionRoute };
}

export async function answerDirectorGoalQuestion(configDirectory: string, target: DirectorGoalTarget,
  questionId: string, answer: GoalAnswerInput, signal: AbortSignal) {
  await assertDirectorGoalTarget(configDirectory, target);
  signal.throwIfAborted();
  let saved = false;
  try {
    return await answerGoalQuestionForPublication(target.cwd, target.goalId, questionId, answer, 'mcp', () => { saved = true; }, 'director');
  } catch (error) {
    if (saved) throw new Error('Answer saved; manager notification is pending and will be retried', { cause: error });
    throw error;
  }
}

export async function escalateDirectorGoalQuestion(configDirectory: string, target: DirectorGoalTarget,
  questionId: string, signal: AbortSignal) {
  await assertDirectorGoalTarget(configDirectory, target);
  signal.throwIfAborted();
  const goal = await new GoalStore(target.cwd).update(target.goalId, (current) => {
    signal.throwIfAborted();
    return escalateGoalQuestion(current, questionId);
  });
  return { goalId: goal.id, question: goal.questions!.find(({ id }) => id === questionId) };
}
