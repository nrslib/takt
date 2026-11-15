import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { answerTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import type { Goal } from '../infra/goals/schema.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const questionId = '650e8400-e29b-41d4-a716-446655440001';

let root: string;
let project: string;
let goalId: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-answer-publication-')));
  project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
  const goal: Goal = {
    ...goalRecord(),
    questions: [{
      id: questionId, body: '出力形式はどれですか', recipient: 'human', status: 'answered',
      answer: { text: 'CSV', source: 'mcp', answeredAt: '2026-01-01T00:00:00.000Z' }, answerPublicationPending: true,
    }],
  };
  goalId = goal.id;
  await new GoalStore(project).create(goal);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('publishes a pending answer exactly once under concurrent retries with the real store and lock', async () => {
  const input = { cwd: project, goalId, questionId, answer: { text: 'CSV' } };

  const [first, second] = await Promise.all([
    answerTaktGoalQuestion(input, {}, signal),
    answerTaktGoalQuestion(input, {}, signal),
  ]);

  expect(first.isError, firstTextContent(first.content)).toBeUndefined();
  expect(second.isError, firstTextContent(second.content)).toBeUndefined();
  const events = readManagerEvents(project)
    .filter(({ event }) => event.kind === 'answer' && event.questionId === questionId);
  expect(events).toHaveLength(1);
  const stored = await new GoalStore(project).get(goalId);
  expect(stored.questions![0]!.answerPublicationPending).toBeUndefined();
  expect(stored.questions![0]!.answer).toMatchObject({ text: 'CSV', source: 'mcp' });
});

it('does not save a second event when the answer event is still queued in the inbox', async () => {
  saveManagerEvent(project, {
    kind: 'answer', goalId, questionId, answer: { text: 'CSV', source: 'mcp', answeredAt: '2026-01-01T00:00:00.000Z' },
  });

  const result = await answerTaktGoalQuestion({ cwd: project, goalId, questionId, answer: { text: 'CSV' } }, {}, signal);

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  const events = readManagerEvents(project)
    .filter(({ event }) => event.kind === 'answer' && event.questionId === questionId);
  expect(events).toHaveLength(1);
  const stored = await new GoalStore(project).get(goalId);
  expect(stored.questions![0]!.answerPublicationPending).toBeUndefined();
});
