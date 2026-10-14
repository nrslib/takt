import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enqueueDueGoalPatrols, isGoalPatrolDue } from '../features/manager/patrol.js';
import { buildGoalTurnContext } from '../features/manager/turnContext.js';
import type { Goal } from '../infra/goals/schema.js';
import type { SavedManagerEvent } from '../infra/goals/events.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { list = doubles.list; } }));
vi.mock('../infra/goals/events.js', () => ({ readManagerEvents: doubles.read, saveManagerEvent: doubles.save }));
const now = Date.parse('2026-10-14T01:00:00Z');
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

it('measures first patrol from creation and subsequent patrols from completion', () => {
  const goal = { ...goalRecord(), createdAt: '2026-10-14T00:30:00Z' };
  expect(isGoalPatrolDue(goal, now - 1, 1800)).toBe(false);
  expect(isGoalPatrolDue(goal, now, 1800)).toBe(true);
  expect(isGoalPatrolDue({ ...goal, lastPatrolCompletedAt: '2026-10-14T00:45:00Z' }, now, 1800)).toBe(false);
  expect(isGoalPatrolDue(goalRecord(), now, 1800)).toBe(true);
});

it('enqueues due active unfinished goals once, excluding paused, aborted, completed and recent goals', async () => {
  const goals: Goal[] = [
    { ...goalRecord(), createdAt: '2026-10-14T00:00:00Z' },
    { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001', executionStatus: 'paused' },
    { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440002', executionStatus: 'aborted' },
    { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440003', status: 'completed' },
    { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440004', createdAt: '2026-10-14T00:45:00Z' },
    { ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440005', lastPatrolCompletedAt: '2026-10-14T00:45:00Z' },
  ];
  let inbox: SavedManagerEvent[] = [];
  doubles.list.mockResolvedValue({ goals, errors: [] });
  doubles.read.mockImplementation(() => inbox);
  doubles.save.mockImplementation((_cwd: string, input: { kind: 'patrol'; goalId: string }) => {
    inbox = [...inbox, { filePath: `/inbox/${input.goalId}`, event: { ...input, createdAt: new Date().toISOString() } }];
  });
  await enqueueDueGoalPatrols('/project', 1800);
  await enqueueDueGoalPatrols('/project', 1800);
  expect(doubles.save).toHaveBeenCalledExactlyOnceWith('/project', { kind: 'patrol', goalId: goals[0]!.id });
});

it('provides task and question times while excluding patrol records from last progress time', () => {
  const goal: Goal = { ...goalRecord(), createdAt: '2026-10-14T00:00:00Z',
    workLog: [
      { id: '550e8400-e29b-41d4-a716-446655440001', recordedAt: '2026-10-14T00:10:00Z', summary: '作業を投入' },
      { id: '550e8400-e29b-41d4-a716-446655440002', recordedAt: '2026-10-14T00:40:00Z', summary: '点検', kind: 'patrol' },
    ],
    questions: [{ id: '550e8400-e29b-41d4-a716-446655440003', recipient: 'human', body: '確認', status: 'pending', createdAt: '2026-10-14T00:05:00Z' }],
  };
  const context = JSON.parse(buildGoalTurnContext('/project', goal,
    { kind: 'patrol', goalId: goal.id, createdAt: new Date().toISOString() },
    [{ name: 'running', kind: 'running', status: 'running', goalId: goal.id, startedAt: '2026-10-14T00:20:00Z', createdAt: goal.createdAt!, filePath: '/task' }],
  ));
  expect(context.patrol).toEqual({ observedAt: '2026-10-14T01:00:00.000Z', lastProgressAt: '2026-10-14T00:10:00Z' });
  expect(context.tasks[0].startedAt).toBe('2026-10-14T00:20:00Z');
  expect(context.goal.questions[0].createdAt).toBe('2026-10-14T00:05:00Z');
});
