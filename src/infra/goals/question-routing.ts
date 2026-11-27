import type { GoalCreationOrigin, GoalQuestionRoute, GoalQuestionType } from './schema.js';

export function initialQuestionRoute(origin: GoalCreationOrigin): GoalQuestionRoute {
  return origin === 'director' ? 'director' : 'human';
}

export function questionRecipient(questionType: GoalQuestionType, route: GoalQuestionRoute): GoalQuestionRoute {
  return questionType === 'routine' ? route : 'human';
}
