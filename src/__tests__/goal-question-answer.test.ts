import { beforeEach, expect, it, vi } from 'vitest';
import { answerTaktGoalQuestion } from '../features/mcp/goalQuestionOperations.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), allowed: vi.fn(), event: vi.fn(), run: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class {
  constructor(private readonly directory: string) {}
  get(id: string) { return doubles.get(this.directory, id); }
  update(id: string, transform: (goal: Goal) => Goal, onSaved?: () => void) { return doubles.update(this.directory, id, transform, onSaved); }
} }));
vi.mock('../infra/goals/events.js', async (original) => ({
  ...await original<typeof import('../infra/goals/events.js')>(), saveManagerEvent: doubles.event,
}));
vi.mock('../features/manager/autoRun.js', () => ({ ensureManagerRun: doubles.run }));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.allowed,
}));

const cwd = '/project';
const goalId = goalRecord().id;
const questionId = '650e8400-e29b-41d4-a716-446655440001';
const signal = new AbortController().signal;
let goal: Goal;

beforeEach(() => {
  vi.resetAllMocks();
  goal = goalRecord();
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.update.mockImplementation(async (_directory: string, _id: string, transform: (current: Goal) => Goal, onSaved?: () => void) => {
    goal = transform(structuredClone(goal));
    onSaved?.();
    return structuredClone(goal);
  });
});

it('saves a human answer with source mcp and the same manager event as the TUI flow', async () => {
  goal.questions = [{ id: questionId, body: '出力形式はどれですか', recipient: 'human', status: 'pending' }];
  const before = Date.now();

  const result = await answerTaktGoalQuestion({ cwd, goalId, questionId, answer: { text: 'CSV' } }, {}, signal);

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  const saved = goal.questions![0]!;
  expect(saved.status).toBe('answered');
  expect(saved.answer).toMatchObject({ text: 'CSV', source: 'mcp', answeredAt: expect.any(String) });
  expect(Date.parse(saved.answer!.answeredAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(saved.answer!.answeredAt)).toBeLessThanOrEqual(Date.now());
  expect(doubles.event).toHaveBeenCalledExactlyOnceWith(cwd, expect.objectContaining({
    kind: 'answer', goalId, questionId, answer: saved.answer,
  }));
  expect(doubles.run).not.toHaveBeenCalled();
  expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ questionId, answer: saved.answer });
});

it('saves a structured report answer for an operation request with source mcp', async () => {
  goal.questions = [{ id: questionId, kind: 'operation_request', body: 'ビルドを確認してください', recipient: 'human', status: 'pending' }];

  const result = await answerTaktGoalQuestion({ cwd, goalId, questionId, answer: { report: 'completed' } }, {}, signal);

  expect(result.isError, firstTextContent(result.content)).toBeUndefined();
  const saved = goal.questions![0]!;
  expect(saved.answer).toMatchObject({ text: '', report: 'completed', source: 'mcp', answeredAt: expect.any(String) });
  expect(doubles.event).toHaveBeenCalledExactlyOnceWith(cwd, expect.objectContaining({
    kind: 'answer', goalId, questionId, answer: saved.answer,
  }));
});

it.each(['answered', 'withdrawn'] as const)('rejects answering a %s question without saving an event', async (status) => {
  goal.questions = [{
    id: questionId, body: '出力形式はどれですか', recipient: 'human', status,
    ...(status === 'answered' ? { answer: { text: 'CSV', source: 'tui', answeredAt: '2026-10-19T01:00:00.000Z' } } : {}),
  }];
  const before = structuredClone(goal);

  const result = await answerTaktGoalQuestion({ cwd, goalId, questionId, answer: { text: 'JSON' } }, {}, signal);

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/not awaiting|pending/iu);
  expect(goal).toEqual(before);
  expect(doubles.event).not.toHaveBeenCalled();
  expect(doubles.run).not.toHaveBeenCalled();
});

it('rejects an answer for a missing question without saving an event', async () => {
  goal.questions = [{ id: questionId, body: '出力形式はどれですか', recipient: 'human', status: 'pending' }];

  const result = await answerTaktGoalQuestion({
    cwd, goalId, questionId: '650e8400-e29b-41d4-a716-446655440042', answer: { text: 'CSV' },
  }, {}, signal);

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/does not exist/iu);
  expect(goal.questions![0]!.status).toBe('pending');
  expect(doubles.event).not.toHaveBeenCalled();
});

it('rejects answering a retired approval inquiry instead of recording a decision', async () => {
  goal.questions = [{
    id: questionId, kind: 'approval', body: '操作を許可しますか', recipient: 'human', status: 'pending',
    operation: { toolName: 'Bash', args: 'ls', cwd, argsDigest: 'a'.repeat(64) },
  }];

  const result = await answerTaktGoalQuestion({ cwd, goalId, questionId, answer: { decision: 'allow' } }, {}, signal);

  expect(result.isError).toBe(true);
  expect(firstTextContent(result.content)).toMatch(/approval|承認/iu);
  expect(goal.questions![0]!.status).toBe('pending');
  expect(doubles.event).not.toHaveBeenCalled();
});

it('rejects a report answer for a plain question through the saved question contract', async () => {
  goal.questions = [{ id: questionId, body: '出力形式はどれですか', recipient: 'human', status: 'pending' }];

  const result = await answerTaktGoalQuestion({ cwd, goalId, questionId, answer: { report: 'completed' } }, {}, signal);

  expect(result.isError).toBe(true);
  expect(goal.questions![0]!.status).toBe('pending');
  expect(doubles.event).not.toHaveBeenCalled();
});

it('rejects a root outside the MCP scope before reading or answering', async () => {
  doubles.allowed.mockImplementation(() => { throw new Error('outside root'); });

  const result = await answerTaktGoalQuestion({ cwd, goalId, questionId, answer: { text: 'CSV' } }, {}, signal);

  expect(result.isError).toBe(true);
  expect(doubles.update).not.toHaveBeenCalled();
  expect(doubles.event).not.toHaveBeenCalled();
});

it('reports a persistence failure without saving a manager event', async () => {
  goal.questions = [{ id: questionId, body: '出力形式はどれですか', recipient: 'human', status: 'pending' }];
  doubles.update.mockRejectedValueOnce(new Error('publication failed'));

  const result = await answerTaktGoalQuestion({ cwd, goalId, questionId, answer: { text: 'CSV' } }, {}, signal);

  expect(result.isError).toBe(true);
  expect(doubles.event).not.toHaveBeenCalled();
  expect(doubles.run).not.toHaveBeenCalled();
});
