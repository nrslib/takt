import { beforeEach, expect, it, vi } from 'vitest';
import { goalRecord, legacyGoalRecord } from './helpers/goal-fixtures.js';
import { goalEventId } from '../infra/goals/events.js';
import { normalizeSavedGoal } from '../infra/goals/migration.js';
import { appendGoalDecision } from '../infra/goals/decisions.js';
import { transitionGoalExecution } from '../infra/goals/state.js';
import { beginGoalOperation, prepareGoalOperation, finishGoalOperation, saveGoalOperationRecovery, withGoalWrites } from '../infra/goals/operations.js';
import { GoalStore } from '../infra/goals/store.js';
import { GoalOperationSchema, type Goal, type GoalEvent } from '../infra/goals/schema.js';
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

it('prioritizes current operation names, states and results over overflowing prior operations', () => {
  const previous = Array.from({ length: 1000 }, (_, index) => ({ id: `prior-${index}`, eventId: 'prior-event',
    operationName: `work:prior-${index}`, tool: 'enqueue' as const, status: index % 2 === 0 ? 'pending' as const : 'failed' as const,
    arguments: {}, result: index % 2 === 0 ? undefined : { status: 'failed', reason: `prior failure ${index}` },
    recordedAt: '2026-10-08T00:00:00Z' }));
  const current = Array.from({ length: 40 }, (_, index) => ({ id: `current-${index}`, eventId: event.id,
    operationName: `notify:current-${index}`, tool: 'notify' as const, status: 'completed' as const,
    arguments: { body: 'body'.repeat(10000) }, result: { notificationId: `notification-${index}` },
    recordedAt: '2026-10-08T00:00:00Z' }));
  const failed = { ...current[0]!, id: 'current-failed', operationName: 'work:failed', status: 'failed' as const,
    result: { status: 'failed', reason: '日本語'.repeat(5000) } };
  goal.operations = [...previous.slice(0, 500), ...current, failed, ...previous.slice(500)];
  const before = JSON.stringify(goal);
  const prompt = buildGoalTurnContext('/project', goal, event, []);
  const context = JSON.parse(prompt);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
  expect(context.stateOverflow).toBe(true);
  current.forEach((operation, index) => {
    expect(context.goal.operations[index]).toMatchObject({ id: operation.id, operationName: operation.operationName,
      status: operation.status, result: operation.result, reference: { recordIndex: 500 + index } });
  });
  expect(context.goal.operations[40]).toMatchObject({ id: failed.id, operationName: failed.operationName,
    status: 'failed', result: { status: 'failed', reason: expect.stringMatching(/…$/) }, reference: { recordIndex: 540 } });
  expect(failed.result.reason.startsWith(context.goal.operations[40].result.reason.slice(0, -1))).toBe(true);
  expect(context.omissions.operationDetails.truncated).toBe(true);
  const includedPrior = context.goal.operations.length - 41;
  expect(context.goal.operations.slice(41).map((operation: { id: string }) => operation.id))
    .toEqual(previous.slice(0, includedPrior).map((operation) => operation.id));
  expect(context.omissions.operations).toMatchObject({ total: 1041, omitted: 1000 - includedPrior, nextOffset: null,
    currentEvent: { total: 41, omitted: 0, nextOffset: null },
    prior: { total: 1000, omitted: 1000 - includedPrior, field: 'operations', recordIndex: includedPrior } });
  expect(JSON.stringify(goal)).toBe(before);
});

it.each([35, 100])('keeps summaries of %i long current results before allocating the remaining space to prior state', (count) => {
  const previous = Array.from({ length: 1000 }, (_, index) => ({ id: `prior-${index}`, eventId: 'prior-event',
    operationName: `notify:prior-${index}`, tool: 'notify' as const, status: 'pending' as const,
    arguments: {}, recordedAt: '2026-10-08T00:00:00Z' }));
  const current = Array.from({ length: count }, (_, index) => ({ ...previous[0]!, id: `current-${index}`,
    eventId: event.id, operationName: `notify:current-${index}`, status: 'completed' as const,
    result: { notificationId: `notification-${index}`, body: '日本語'.repeat(5000) } }));
  goal.operations = [...previous, ...current];
  const prompt = buildGoalTurnContext('/project', goal, event, []);
  const context = JSON.parse(prompt);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
  current.forEach((operation, index) => {
    expect(context.goal.operations[index]).toMatchObject({ id: operation.id, operationName: operation.operationName,
      status: 'completed', result: { summary: expect.stringMatching(/…$/) }, reference: { recordIndex: 1000 + index } });
    expect(JSON.stringify(operation.result).startsWith(context.goal.operations[index].result.summary.slice(0, -1))).toBe(true);
  });
  expect(context.omissions.operations.currentEvent).toMatchObject({ total: count, omitted: 0, nextOffset: null });
});

it('retrieves omitted current operations with the exact continuation arguments from mixed input', async () => {
  const operation = { id: 'prior', eventId: 'prior-event', operationName: 'notify:prior', tool: 'notify' as const,
    arguments: {}, status: 'pending' as const, recordedAt: '2026-10-08T00:00:00Z' };
  const current = Array.from({ length: 1000 }, (_, index) => ({ ...operation, id: `current-${index}`,
    operationName: `notify:current-${index}`, eventId: event.id, status: 'completed' as const,
    result: { notificationId: `notification-${index}` } }));
  goal.operations = [operation, ...current];
  const context = JSON.parse(buildGoalTurnContext('/project', goal, event, []));
  const continuation = context.omissions.operations.currentEvent;
  expect(continuation).toMatchObject({ tool: 'takt_list_goal_operations',
    arguments: { cwd: '/project', goalId: goal.id, eventId: event.id, offset: context.goal.operations.length, limit: 20 } });
  expect(continuation.omitted).toBe(current.length - context.goal.operations.length);
  expect(context.omissions.operations.prior).toMatchObject({ total: 1, omitted: 1, recordIndex: 0 });
  const response = await listTaktGoalRecords(continuation.arguments,
    { goalEventContext: { goalId: goal.id, eventId: event.id } }, 'operations');
  expect(response.isError).toBeUndefined();
  const page = JSON.parse(firstTextContent(response.content));
  expect(page.operations).toEqual(current.slice(continuation.arguments.offset, continuation.arguments.offset + 20));
  expect(page.total).toBe(1000);
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
  const context = JSON.parse(prompt);
  expect(context.goal.workUnits.length).toBeGreaterThan(0);
  expect(context.goal.operations.length).toBeGreaterThan(0);
  expect(context.goal.operations[0]).toMatchObject({ status: 'completed', result: { notificationId: 'id-0' }, reference: { recordIndex: 0 } });
  expect(context).toMatchObject({ event: { id: event.id, runSlug: 'run-a' }, tasks: [{ name: 'task-a', sha: 'a'.repeat(40), references: { runSlug: 'run-a' } }], omissions: {
    objective: { truncated: true }, workUnits: { total: 1000, omitted: 1000 - context.goal.workUnits.length, source: expect.stringContaining('/goal.json') },
    operations: { total: 1000, omitted: 1000 - context.goal.operations.length, tool: 'takt_list_goal_operations', oversized: false },
  } });
});

it.each(['merged', 'conflict', 'checked_out'] as const)('retains a single %s work unit and its SHAs despite an oversized purpose', (status) => {
  const purpose = '日本語"\\\n'.repeat(2000);
  goal.workUnits = [{ taskName: 'task-a', workKey: 'validation', purpose, integration: {
    status, sourceBranch: 'takt/result', expectedSha: 'a'.repeat(40), goalSha: 'b'.repeat(40),
    recordedAt: '2026-10-08T00:00:00Z', conflicts: ['file'], worktrees: ['/human'],
  } }];
  const prompt = buildGoalTurnContext('/project', goal, event, []);
  const context = JSON.parse(prompt);
  expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(64 * 1024);
  expect(context.goal.workUnits).toEqual([{ taskName: 'task-a', workKey: 'validation',
    purpose: expect.stringMatching(/…$/), integration: {
      status, sourceBranch: 'takt/result', expectedSha: 'a'.repeat(40), goalSha: 'b'.repeat(40), recordedAt: '2026-10-08T00:00:00Z',
      conflicts: ['file'], worktrees: ['/human'],
    } }]);
  expect(context.omissions).toMatchObject({ workUnits: { omitted: 0, oversized: false },
    workUnitDetails: { truncated: true, source: '/project/.takt/goals/' + goal.id + '/goal.json' } });
  expect(purpose.startsWith(context.goal.workUnits[0].purpose.slice(0, -1))).toBe(true);
});

it('retains integration state and SHAs when the conflict details also exceed the section budget', () => {
  const integration = { status: 'conflict' as const, sourceBranch: 'takt/result', expectedSha: 'a'.repeat(40),
    goalSha: 'b'.repeat(40), recordedAt: '2026-10-08T00:00:00Z' };
  goal.workUnits = [{ taskName: 'task-a', purpose: '入力検証', integration: { ...integration, conflicts: ['file'.repeat(10000)] } }];
  const context = JSON.parse(buildGoalTurnContext('/project', goal, event, []));
  expect(context.goal.workUnits).toEqual([{ taskName: 'task-a', purpose: '入力検証', integration }]);
  expect(context.omissions).toMatchObject({ workUnits: { omitted: 0 }, workUnitDetails: { truncated: true } });
});

it('retains prior event failures and their reasons even when the operation arguments exceed the section budget', () => {
  const operation = prepareGoalOperation(goal, { goalId: goal.id, eventId: event.id }, 'work:validation', 'enqueue', { task: '日本語'.repeat(5000) });
  goal.operations = [{ ...operation, status: 'failed', result: { status: 'failed', reason: 'Workflow is no longer allowed' } }];
  const nextEvent = { ...event, id: 'next-event' };
  goal.events!.push(nextEvent);
  const context = JSON.parse(buildGoalTurnContext('/project', goal, nextEvent, []));
  expect(context.goal.operations).toEqual([{ id: operation.id, eventId: event.id, operationName: operation.operationName,
    tool: 'enqueue', status: 'failed', recordedAt: operation.recordedAt,
    result: { status: 'failed', reason: 'Workflow is no longer allowed' },
    reference: { source: '/project/.takt/goals/' + goal.id + '/goal.json', recordIndex: 0 } }]);
  expect(GoalOperationSchema.parse(goal.operations[0])).toEqual(goal.operations[0]);
  expect(GoalOperationSchema.safeParse({ ...goal.operations[0], result: undefined }).success).toBe(false);
  expect(GoalOperationSchema.safeParse({ ...goal.operations[0], result: { status: 'failed' } }).success).toBe(false);
});


it('retains completion branches and SHAs when its summary exceeds the body budget', () => {
  goal.status = 'awaiting_merge';
  goal.completion = { goalBranch: goal.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
    summary: '日本語"\\\n'.repeat(2000), changeSummary: { filesChanged: 0, additions: 0, deletions: 0,
      files: [], truncated: false, totalsTruncated: false }, instructions: [] };
  const before = JSON.stringify(goal);
  const prompt = buildGoalTurnContext('/project', goal, event, []);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
  const context = JSON.parse(prompt);
  expect(context).toMatchObject({ stateOverflow: false, goal: { status: 'awaiting_merge', executionStatus: 'active',
    completion: [{ goalBranch: goal.branch, goalSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40),
      summary: expect.stringMatching(/…$/) }] }, omissions: { completion: { truncated: true, field: 'completion',
        source: '/project/.takt/goals/' + goal.id + '/goal.json' } } });
  expect(JSON.stringify(goal)).toBe(before);
});

it('retains every work unit state and SHA beyond the old per-section byte and count limits', () => {
  goal.workUnits = Array.from({ length: 80 }, (_, index) => ({ taskName: `task-${index}`,
    workKey: `work-${index}-` + '日本語"\\\n'.repeat(2000), purpose: 'purpose'.repeat(2000), integration: {
      status: index % 2 === 0 ? 'merged' : 'conflict', sourceBranch: `task/${index}`, expectedSha: 'a'.repeat(40),
      goalSha: 'b'.repeat(40), recordedAt: '2026-10-08T00:00:00Z',
    } }));
  const prompt = buildGoalTurnContext('/project', goal, event, []);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
  const context = JSON.parse(prompt);
  expect(context.stateOverflow).toBe(false);
  expect(context.goal.workUnits).toHaveLength(80);
  goal.workUnits.forEach((unit, index) => {
    expect(context.goal.workUnits[index]).toMatchObject({ taskName: unit.taskName,
      workKey: expect.stringMatching(/…$/), integration: unit.integration });
    expect(Buffer.byteLength(JSON.stringify(context.goal.workUnits[index].workKey))).toBeLessThanOrEqual(256);
  });
  expect(context.omissions.workUnits).toMatchObject({ total: 80, omitted: 0, nextOffset: null });
});

it('retains pending answer event and question IDs despite long answer bodies', () => {
  const questionId = '650e8400-e29b-41d4-a716-446655440001';
  const answer = { text: '日本語'.repeat(20000), source: 'tui' as const, answeredAt: '2026-10-08T00:00:00Z' };
  const answerEvent: GoalEvent = { id: 'answer-a', kind: 'answer', processed: false, questionId, answer };
  goal.events = [event, answerEvent, ...Array.from({ length: 40 }, (_, index) => ({ ...answerEvent, id: `answer-${index}` }))];
  goal.questions = [{ id: questionId, recipient: 'human', status: 'pending', body: answer.text }];
  const prompt = buildGoalTurnContext('/project', goal, answerEvent, []);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
  const context = JSON.parse(prompt);
  expect(context.stateOverflow).toBe(false);
  expect(context.goal.events.map(({ id, kind }: GoalEvent) => ({ id, kind })))
    .toEqual(goal.events.map(({ id, kind }) => ({ id, kind })));
  expect(context.goal.events[0].result.sha).toBe(event.kind === 'completion' ? event.result.sha : undefined);
  expect(context.goal.questions).toMatchObject([{ id: questionId, status: 'pending' }]);
  expect(context.event).toMatchObject({ id: answerEvent.id, kind: 'answer', questionId, answer: { text: expect.stringMatching(/…$/) } });
  expect(context.omissions.eventDetails).toMatchObject({ truncated: true, field: 'events' });
});

it('retains prior pending and failed operation identities even with long names and results', () => {
  goal.operations = Array.from({ length: 40 }, (_, index) => ({ id: `op-${index}`, eventId: 'prior-event',
    operationName: `work:${index}:` + '日本語'.repeat(3000), tool: 'enqueue', status: index % 2 === 0 ? 'pending' : 'failed',
    recordedAt: '2026-10-08T00:00:00Z', arguments: { task: 'task'.repeat(20000) },
    result: index % 2 === 0 ? undefined : { status: 'failed', reason: 'reason'.repeat(20000) },
  }));
  const prompt = buildGoalTurnContext('/project', goal, event, []);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
  const context = JSON.parse(prompt);
  expect(context.stateOverflow).toBe(false);
  expect(context.goal.operations).toHaveLength(40);
  goal.operations.forEach((operation, index) => {
    expect(context.goal.operations[index]).toMatchObject({ id: operation.id, eventId: operation.eventId,
      operationName: expect.stringMatching(/…$/), status: operation.status, tool: operation.tool,
      reference: { recordIndex: index } });
  });
});

it.each([1000, 10000])('explicitly pages a state-only overflow with %i work units without growing input', (count) => {
  goal.workUnits = Array.from({ length: count }, (_, index) => ({ taskName: `task-${index}`, workKey: `work-${index}`,
    purpose: 'body'.repeat(2000), integration: { status: 'merged', sourceBranch: `task/${index}`,
      expectedSha: 'a'.repeat(40), goalSha: 'b'.repeat(40), recordedAt: '2026-10-08T00:00:00Z' } }));
  const prompt = buildGoalTurnContext('/project', goal, event, []);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
  const context = JSON.parse(prompt);
  expect(context.stateOverflow).toBe(true);
  expect(context.goal.workUnits.length).toBeGreaterThan(0);
  context.goal.workUnits.forEach((unit: { integration: unknown }, index: number) => {
    expect(unit.integration).toEqual(goal.workUnits![index]!.integration);
  });
  expect(context.omissions.workUnits).toMatchObject({ total: count, omitted: count - context.goal.workUnits.length,
    nextOffset: context.goal.workUnits.length, source: '/project/.takt/goals/' + goal.id + '/goal.json', field: 'workUnits' });
  expect(context.event).toMatchObject({ id: event.id, kind: event.kind, result: { sha: 'a'.repeat(40) } });
});


it('bounds state overflow and references even with long paths and identifiers in every collection', () => {
  const long = '日本語"\\\n'.repeat(2000);
  const count = 1000;
  goal.workUnits = Array.from({ length: count }, (_, index) => ({ taskName: `task-${index}-${long}`, workKey: long, purpose: long,
    integration: { status: 'merged', sourceBranch: long, expectedSha: 'a'.repeat(40), goalSha: 'b'.repeat(40), recordedAt: '2026-10-08T00:00:00Z' } }));
  goal.events = Array.from({ length: count }, (_, index) => ({ ...event, id: `event-${index}-${long}` }));
  goal.questions = Array.from({ length: count }, () => ({ id: '650e8400-e29b-41d4-a716-446655440001', status: 'pending', recipient: 'human', body: long }));
  goal.operations = Array.from({ length: count }, (_, index) => ({ id: `op-${index}-${long}`, eventId: event.id, operationName: long,
    tool: 'notify', status: 'pending', arguments: { body: long }, recordedAt: '2026-10-08T00:00:00Z' }));
  const tasks = Array.from({ length: count }, (_, index) => ({ name: `task-${index}-${long}`, goalId: goal.id,
    kind: 'completed' as const, status: 'completed' as const, createdAt: '2026-10-08T00:00:00Z', completion: event.kind === 'completion' ? event.result : undefined,
    filePath: '/project/' + long, taskDir: '/project/' + long, worktreePath: '/project/' + long, runSlug: long }));
  const prompt = buildGoalTurnContext('/project/' + long, goal, event, tasks);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(64 * 1024);
  const context = JSON.parse(prompt);
  expect(context.stateOverflow).toBe(true);
  for (const field of ['workUnits', 'events', 'questions', 'operations', 'tasks']) {
    const records = field === 'tasks' ? context.tasks : context.goal[field];
    expect(records.length).toBeGreaterThan(0);
    expect(context.omissions[field]).toMatchObject({ total: count, omitted: count - records.length, nextOffset: records.length });
  }
  expect(context.goal.workUnits[0].integration).toMatchObject({ status: 'merged', expectedSha: 'a'.repeat(40), goalSha: 'b'.repeat(40) });
  expect(context.tasks[0].sha).toBe('a'.repeat(40));
  expect(context.goal.events[0].id).toMatch(/…$/);
  expect(context.goal.operations[0]).toMatchObject({ id: expect.stringMatching(/…$/), operationName: expect.stringMatching(/…$/), status: 'pending' });
});
