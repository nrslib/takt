import { beforeEach, expect, it, vi } from 'vitest';
import { goalRecord, legacyGoalRecord } from './helpers/goal-fixtures.js';
import { goalEventId } from '../infra/goals/events.js';
import { normalizeSavedGoal } from '../infra/goals/migration.js';
import { appendGoalDecision } from '../infra/goals/decisions.js';
import { transitionGoalExecution } from '../infra/goals/state.js';
import { beginGoalOperation, prepareGoalOperation, finishGoalOperation, saveGoalOperationRecovery, withGoalWrites } from '../infra/goals/operations.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal, GoalEvent } from '../infra/goals/schema.js';
import { buildGoalTurnContext } from '../features/manager/turnContext.js';
import { boundedRecords } from '../shared/utils/bounded-records.js';
import { recordTaktGoalDecision, listTaktGoalRecords } from '../features/mcp/goalDecisionOperations.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { TaskRecordSchema } from '../infra/task/schema.js';
import { toTaskInfo, toTaskState } from '../infra/task/mapper.js';

const doubles = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), lock: vi.fn(), page: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; update = doubles.update; readRecordPage = doubles.page; } }));
vi.mock('../shared/utils/private-file-lock.js', () => ({ runPrivateFileExclusiveAsync: doubles.lock }));
vi.mock('../infra/goals/turn-lock.js', () => ({
  withGoalTurns: async (_cwd: string, _ids: string[], action: () => Promise<unknown>) => action(),
}));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: vi.fn(),
}));
const event: GoalEvent = { id: 'event-a', kind: 'completion', taskName: 'task-a', runSlug: 'run-a',
  result: { success: true, interrupted: false, sha: 'a'.repeat(40) }, processed: false };
let goal: Goal;
beforeEach(() => {
  vi.resetAllMocks();
  goal = { ...goalRecord(), events: [event] };
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform(goal); return goal;
  });
  doubles.lock.mockImplementation(async (_path: string, action: () => Promise<unknown>) => action());
  doubles.page.mockImplementation(async (_id: string, kind: 'decisions' | 'operations', eventId: string | undefined, offset: number, limit: number, budget: number) => {
    const saved = goal[kind] ?? [];
    const filtered = saved.filter((record) => eventId === undefined || record.eventId === eventId);
    const page = boundedRecords(filtered, offset, limit, budget);
    return { ...page, ...(page.oversized ? { recordIndex: saved.findIndex((record) => record === filtered[offset]) } : {}) };
  });
});

it('uses stable structured references and distinguishes separators and goals', () => {
  expect(goalEventId(goal.id, 'completion', ['a:b', 'c'])).not.toBe(goalEventId(goal.id, 'completion', ['a', 'b:c']));
  expect(goalEventId(goal.id, 'completion', ['a:b', 'c'])).toBe(goalEventId(goal.id, 'completion', ['a:b', 'c']));
  expect(goalEventId(goal.id, 'completion', ['a:b', 'c'])).not.toBe(goalEventId('other', 'completion', ['a:b', 'c']));
});

it('retains operation metadata in both task state and executable task data', () => {
  const task = TaskRecordSchema.parse({ name: 'task-a', status: 'pending', content: 'Work', created_at: '2026-10-08T00:00:00Z', started_at: null, completed_at: null, goal_id: goal.id, goal_operation_id: 'saved-operation' });
  expect(toTaskState('/project/.takt/tasks.yaml', task)).toMatchObject({ goalOperationId: 'saved-operation' });
  expect(toTaskInfo('/project', '/project/.takt/tasks.yaml', task).data).toMatchObject({ goal_operation_id: 'saved-operation' });
});

it('migrates both legacy event kinds and unknown decision provenance without mutating input', () => {
  const legacy = { ...legacyGoalRecord(), events: [{ taskName: 'task-a', runSlug: 'run-a', result: event.result, processed: true, summary: 'saved' }],
    answerEvents: [{ questionId: '650e8400-e29b-41d4-a716-446655440001', processed: false,
      answer: { text: 'JSON', source: 'tui', answeredAt: '2026-10-08T00:00:00Z' } }],
    sessions: [{ provider: 'mock', sessionId: 'old' }],
    decisions: [{ decision: 'integrate', reason: 'old reason', recordedAt: '2026-10-08T00:00:00Z' }] };
  const before = JSON.stringify(legacy);
  const migrated = normalizeSavedGoal(legacy);
  expect(migrated.events).toEqual([expect.objectContaining({ id: goalEventId(goal.id, 'completion', ['task-a', 'run-a']), kind: 'completion', processed: true, summary: 'saved' }), expect.objectContaining({ kind: 'answer' })]);
  expect(migrated.decisions?.[0]).toMatchObject({ eventId: null, actor: null, acceptanceCriteriaVersion: 1 });
  expect(Reflect.get(migrated, 'sessions')).toBeUndefined();
  expect(normalizeSavedGoal(migrated)).toEqual(migrated);
  expect(JSON.stringify(legacy)).toBe(before);
  expect(() => normalizeSavedGoal({ ...legacy, executionStatus: 'invalid' })).toThrow();
});

it('retains decisions and returns the original record when retrying after a later reversal', () => {
  const input = { eventId: event.id, operation: 'integrate', reason: 'verified', evidenceRefs: ['run-a/reports/test.md'], actor: 'manager' as const, acceptanceCriteriaVersion: 1 };
  const first = appendGoalDecision(goal, input);
  const second = appendGoalDecision(first.goal, { ...input, operation: 'requeue', reason: 'new evidence', supersedesDecisionId: first.decision.id });
  const replay = appendGoalDecision(second.goal, input);
  expect(replay.goal.decisions).toHaveLength(2);
  expect(replay.decision).toEqual(first.decision);
  expect(second.decision.supersedesDecisionId).toBe(first.decision.id);
  expect(() => appendGoalDecision(goal, { ...input, eventId: 'missing' })).toThrow();
  expect(() => appendGoalDecision(goal, { ...input, acceptanceCriteriaVersion: 2 })).toThrow();
  expect(() => appendGoalDecision(goal, { ...input, supersedesDecisionId: 'missing' })).toThrow();
});

it('preserves progress while transitioning the same goal and rejects resume after abort', () => {
  goal = transitionGoalExecution(goal, 'paused');
  expect(goal.status).toBe('created');
  goal = transitionGoalExecution(goal, 'active');
  goal = transitionGoalExecution(goal, 'aborted');
  expect(() => transitionGoalExecution(goal, 'active')).toThrow();
});

it('records decisions through MCP, returns the original replay and reads bounded saved records', async () => {
  const input = { cwd: '/project', goalId: goal.id, eventId: event.id, operation: 'integrate', reason: 'verified', evidenceRefs: ['run-a'], actor: 'manager' as const, acceptanceCriteriaVersion: 1 };
  const deps = { goalEventContext: { goalId: goal.id, eventId: event.id } };
  const signal = new AbortController().signal;
  const first = await recordTaktGoalDecision(input, deps, signal);
  const original = JSON.parse(firstTextContent(first.content)).decision;
  expect(first.isError).toBeUndefined();
  await recordTaktGoalDecision({ ...input, reason: 'changed', supersedesDecisionId: original.id }, deps, signal);
  expect(await recordTaktGoalDecision(input, deps, signal)).toEqual(first);
  const page = await listTaktGoalRecords({ cwd: input.cwd, goalId: goal.id, offset: 0, limit: 1 }, deps, 'decisions');
  expect(JSON.parse(firstTextContent(page.content))).toMatchObject({ decisions: [original], total: 2, nextOffset: 1 });
  expect((await recordTaktGoalDecision({ ...input, eventId: 'other' }, deps, signal)).isError).toBe(true);
  const operation = prepareGoalOperation(goal, deps.goalEventContext, 'notify:progress', 'notify', { body: 'saved' });
  goal = finishGoalOperation(goal, operation, { notificationId: 'saved-id' });
  const operations = await listTaktGoalRecords({ cwd: input.cwd, goalId: goal.id, offset: 0, limit: 20 }, deps, 'operations');
  expect(JSON.parse(firstTextContent(operations.content))).toMatchObject({ operations: [expect.objectContaining({ operationName: 'notify:progress', result: { notificationId: 'saved-id' } })] });
});

it('saves normalized operations before effects and retains recovery and compact results', async () => {
  const store = new GoalStore('/project');
  const context = { goalId: goal.id, eventId: event.id };
  const first = prepareGoalOperation(goal, context, 'notify:progress', 'notify', { body: 'done', unused: undefined, nested: { b: 2, a: 1 } });
  expect(goal.operations).toBeUndefined();
  expect(doubles.update).not.toHaveBeenCalled();
  await beginGoalOperation(store, goal.id, first);
  expect(goal.operations).toEqual([first]);
  expect(first.status).toBe('pending');
  expect(prepareGoalOperation(goal, context, 'notify:progress', 'notify', { nested: { a: 1, b: 2 }, body: 'done' })).toEqual(first);
  expect(doubles.update).toHaveBeenCalledOnce();
  expect(() => prepareGoalOperation(goal, context, 'notify:progress', 'notify', { body: 'different' })).toThrow();
  expect(() => prepareGoalOperation(goal, context, 'notify:progress', 'question', first.arguments)).toThrow();
  expect(() => prepareGoalOperation(goal, context, undefined, 'notify', {})).toThrow();
  expect(() => prepareGoalOperation(goal, { ...context, eventId: 'missing' }, 'new', 'notify', {})).toThrow();
  await saveGoalOperationRecovery(store, goal.id, first, { beforeSha: 'a'.repeat(40) });
  goal = finishGoalOperation(goal, first, { notificationId: 'saved-id' });
  expect(goal.operations?.[0]).toMatchObject({ status: 'completed', result: { notificationId: 'saved-id' }, recovery: { beforeSha: 'a'.repeat(40) } });
  expect(await withGoalWrites('/project', goal.id, async () => 42)).toBe(42);
  expect(doubles.lock).toHaveBeenCalledWith(expect.stringContaining('/operations.lock'), expect.any(Function));
});

it('pages records by bytes and exposes oversized records through storage references', () => {
  const records = [{ text: 'small' }, { text: '日本語'.repeat(100) }, { text: 'end' }];
  expect(boundedRecords(records, 0, 20, 100)).toMatchObject({ records: [records[0]], total: 3, nextOffset: 1, omitted: 2 });
  expect(boundedRecords(records, 1, 20, 100)).toMatchObject({ records: [], nextOffset: 1, oversized: true });
  expect(boundedRecords(records, 2, 20, 100)).toMatchObject({ records: [records[2]], nextOffset: null });
});

it('locates oversized filtered operations in the saved source array', async () => {
  const saved = { id: 'op-a', eventId: 'other', operationName: 'notify:other', tool: 'notify' as const,
    arguments: {}, status: 'pending' as const, recordedAt: '2026-10-08T00:00:00Z' };
  goal.operations = [saved, { ...saved, id: 'op-b', eventId: event.id, arguments: { body: '日本語'.repeat(10000) } }];
  const result = await listTaktGoalRecords({ cwd: '/project', goalId: goal.id, offset: 0, limit: 20 },
    { goalEventContext: { goalId: goal.id, eventId: event.id } }, 'operations');
  expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ operations: [], total: 1,
    oversized: true, recordIndex: 1, source: expect.stringContaining('/goal.json'), instruction: expect.stringContaining('operations[recordIndex]') });
});

it('bounds all populated sections while retaining task SHA, run references and explicit omissions', () => {
  goal.objective = '日本語"\\\n'.repeat(20000);
  const long = '日本語"\\\n'.repeat(1000);
  goal.events = [event, ...Array.from({ length: 1000 }, (_, index) => ({ ...event, id: `event-${index}`, taskName: `task-${index}` }))];
  goal.workUnits = Array.from({ length: 1000 }, (_, index) => ({ taskName: `task-${index}`, purpose: long }));
  goal.questions = Array.from({ length: 1000 }, () => ({ id: '650e8400-e29b-41d4-a716-446655440001', recipient: 'human', status: 'pending', body: long }));
  goal.operations = Array.from({ length: 1000 }, (_, index) => ({ id: `op-${index}`, eventId: event.id, operationName: `notify:${index}`, tool: 'notify', arguments: { body: long }, status: 'completed', result: { notificationId: `id-${index}` }, recordedAt: '2026-10-08T00:00:00Z' }));
  const prompt = buildGoalTurnContext('/project', goal, event, [{ name: 'task-a', goalId: goal.id, kind: 'completed', status: 'completed', createdAt: '2026-10-08T00:00:00Z', filePath: '/project/.takt/tasks.yaml', runSlug: 'run-a', taskDir: '/project/.takt/tasks/task-a', completion: event.result }]);
  expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  expect(JSON.parse(prompt)).toMatchObject({ event: { id: event.id, runSlug: 'run-a' }, tasks: [{ name: 'task-a', sha: 'a'.repeat(40), references: { runSlug: 'run-a' } }], omissions: {
    objective: { truncated: true }, workUnits: { total: 1000, omitted: 1000, source: expect.stringContaining('/goal.json') },
    operations: { total: 1000, tool: 'takt_list_goal_operations', oversized: true },
  } });
});
