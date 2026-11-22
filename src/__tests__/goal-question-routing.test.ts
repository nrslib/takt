import { expect, it } from 'vitest';
import { initialQuestionRoute, questionRecipient } from '../infra/goals/question-routing.js';
import { addGoalQuestion, answerGoalQuestion, escalateGoalQuestion, setGoalQuestionRoute } from '../infra/goals/questions.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import type { Goal } from '../infra/goals/schema.js';

it.each(['manager', 'director'] as const)('chooses the initial route for %s creation', (origin) => {
  expect(initialQuestionRoute(origin)).toBe(origin === 'director' ? 'director' : 'human');
});
it.each(['human', 'director'] as const)('gives the human question types priority over the %s route', (route) => {
  expect(questionRecipient('routine', route)).toBe(route);
  for (const type of ['permission', 'irreversible', 'agreement', 'humanTask', 'humanFact', 'unsure'] as const) {
    expect(questionRecipient(type, route)).toBe('human');
  }
});
it('reroutes all pending questions through promotion and return while preserving origin and past answers', () => {
  let goal: Goal = goalRecord();
  for (const questionType of ['routine', 'permission', 'irreversible', 'agreement', 'humanTask', 'humanFact', 'unsure'] as const) {
    goal = addGoalQuestion(goal, { body: questionType, questionType }).goal;
  }
  const history = addGoalQuestion(goal, { body: 'Earlier question' });
  goal = answerGoalQuestion(history.goal, history.questionId, 'Earlier answer', 'tui', 'human');
  const before = structuredClone(goal);
  const promoted = setGoalQuestionRoute(goal, 'director');
  expect(promoted.creationOrigin).toBe('manager');
  expect(promoted.questions?.filter(q => q.status === 'pending').map(q => [q.questionType, q.recipient])).toEqual([
    ['routine', 'director'], ['permission', 'human'], ['irreversible', 'human'], ['agreement', 'human'],
    ['humanTask', 'human'], ['humanFact', 'human'], ['unsure', 'human'],
  ]);
  expect(promoted.questions?.at(-1)).toEqual(before.questions?.at(-1));
  const returned = setGoalQuestionRoute(promoted, 'human');
  expect(returned.questions).toEqual(before.questions);
  expect(goal).toEqual(before);
});
it('escalates only the selected director question and keeps it human through later route changes', () => {
  const first = addGoalQuestion({ ...goalRecord(), questionRoute: 'director' }, { body: 'Unclear' });
  const second = addGoalQuestion(first.goal, { body: 'Clear' });
  const escalated = escalateGoalQuestion(second.goal, first.questionId);
  expect(escalated.questionRoute).toBe('director');
  expect(escalated.questions?.[0]).toMatchObject({ questionType: 'unsure', recipient: 'human', status: 'pending' });
  expect(escalated.questions?.[1]).toMatchObject({ recipient: 'director', status: 'pending' });
  expect(() => answerGoalQuestion(escalated, first.questionId, 'Guessed answer', 'mcp', 'director')).toThrow();
  expect(setGoalQuestionRoute(setGoalQuestionRoute(escalated, 'human'), 'director').questions?.[0]?.recipient).toBe('human');
});
it.each(['completed', 'aborted'] as const)('rejects new routing operations on a %s goal', (state) => {
  const pending = addGoalQuestion({ ...goalRecord(), questionRoute: 'director' }, { body: 'Pending' });
  const ended = state === 'completed' ? { ...pending.goal, status: 'completed' as const }
    : { ...pending.goal, executionStatus: 'aborted' as const };
  expect(() => setGoalQuestionRoute(ended, 'human')).toThrow();
  expect(() => escalateGoalQuestion(ended, pending.questionId)).toThrow();
});
