import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTaktGoal, listTaktGoals, listTaktTasks, enqueueTaktTask, type McpOperationDependencies } from '../features/mcp/operations.js';
import { TaskRunner, type TaskState } from '../infra/task/index.js';
import * as goalGit from '../infra/goals/git-command.js';
import * as runMeta from '../core/workflow/run/run-meta.js';
import { listGoalsInputSchema, type EnqueueTaskInput } from '../features/mcp/schemas.js';
import { firstTextContent } from './helpers/mcp-content.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { goalSummary } from '../features/mcp/goalResponse.js';
import { MCP_RESPONSE_MAX_BYTES, responseBytes } from '../features/mcp/response.js';
import type { Goal } from '../infra/goals/schema.js';

const goalDoubles = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({
  GoalStore: class {
    async list(project?: (goal: Goal) => unknown) {
      const result = await goalDoubles.list();
      return { ...result, goals: project === undefined ? result.goals : result.goals.flatMap((goal: Goal) => {
        const value = project(goal); return value === undefined ? [] : [value];
      }) };
    }
    get = goalDoubles.get;
  },
}));

function invalidGoalErrors(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    goalId: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    error: new Error('Invalid goal file: /Users/reviewer/secret/goal.json'),
  }));
}

describe('MCP task goal integration', () => {
  const cwd = '/repo';
  const completionSha = 'a'.repeat(40);
  const goalSha = 'b'.repeat(40);

  function task(overrides: Partial<TaskState> = {}): TaskState {
    return {
      name: 'completed-task', kind: 'completed', status: 'completed', goalId,
      createdAt: '2026-10-30T00:00:00Z', filePath: '/repo/.takt/tasks.yaml',
      completion: { success: true, interrupted: false, sha: completionSha },
      ...overrides,
    };
  }

  async function list(input: { offset?: number; limit?: number } = {}) {
    const result = await listTaktTasks({ cwd, ...input });
    expect(result.isError).toBeUndefined();
    return JSON.parse(firstTextContent(result.content)) as {
      tasks: Record<string, unknown>[]; totalCount: number; returnedCount: number;
      offset: number; nextOffset: number | null;
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(TaskRunner.prototype, 'listTaskStateItems').mockReturnValue([task()]);
    goalDoubles.get.mockResolvedValue(goalRecord());
    vi.spyOn(goalGit, 'resolveGoalBranchSha').mockResolvedValue(goalSha);
    vi.spyOn(goalGit, 'isGoalCommitIncluded').mockResolvedValue(true);
    vi.spyOn(goalGit, 'runGoalGit').mockResolvedValue({ output: Buffer.alloc(0), code: 0, truncated: false });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('returns integrated for a completion commit reachable from the goal branch', async () => {
    const output = await list();
    expect(output.tasks[0]).toMatchObject({ status: 'completed', goalIntegration: 'integrated' });
    expect(output.tasks[0]).not.toHaveProperty('goalIntegrationReason');
    expect(goalDoubles.get).toHaveBeenCalledWith(goalId);
    expect(goalGit.resolveGoalBranchSha).toHaveBeenCalledWith(cwd, goalRecord().branch, undefined);
    expect(goalGit.isGoalCommitIncluded).toHaveBeenCalledWith(cwd, completionSha, goalSha, undefined);
    expect(goalGit.runGoalGit).not.toHaveBeenCalled();
  });

  it('returns not_integrated for an existing completion commit outside the goal history', async () => {
    vi.mocked(goalGit.isGoalCommitIncluded).mockResolvedValue(false);
    const output = await list();
    expect(output.tasks[0]).toMatchObject({ status: 'completed', goalIntegration: 'not_integrated' });
    expect(output.tasks[0]).not.toHaveProperty('goalIntegrationReason');
    expect(goalGit.runGoalGit).not.toHaveBeenCalled();
  });

  it.each(['pending', 'running', 'failed', 'exceeded', 'pr_failed', 'completed'] as const)(
    'returns not_integrated without Git for a %s task without a completion SHA', async (status) => {
      vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([task({
        status, kind: status, completion: { success: status === 'completed', interrupted: false },
      })]);
      const output = await list();
      expect(output.tasks[0]).toMatchObject({ status, goalIntegration: 'not_integrated' });
      expect(output.tasks[0]).not.toHaveProperty('goalIntegrationReason');
      expect(goalDoubles.get).not.toHaveBeenCalled();
      expect(goalGit.resolveGoalBranchSha).not.toHaveBeenCalled();
      expect(goalGit.isGoalCommitIncluded).not.toHaveBeenCalled();
      expect(goalGit.runGoalGit).not.toHaveBeenCalled();
    },
  );

  it.each(['pending', 'running', 'failed'] as const)(
    'does not infer integration from a stale completion SHA on a %s task', async (status) => {
      vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([task({ status, kind: status })]);
      expect((await list()).tasks[0]).toMatchObject({ status, goalIntegration: 'not_integrated' });
      expect(goalGit.isGoalCommitIncluded).not.toHaveBeenCalled();
      expect(goalGit.resolveGoalBranchSha).not.toHaveBeenCalled();
    },
  );

  it('keeps a task without a completion record not_integrated', async () => {
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([task({ completion: undefined })]);
    expect((await list()).tasks[0]).toMatchObject({ goalIntegration: 'not_integrated' });
    expect(goalDoubles.get).not.toHaveBeenCalled();
    expect(goalGit.isGoalCommitIncluded).not.toHaveBeenCalled();
  });

  it('localizes a missing completion commit and explains it while preserving a healthy task', async () => {
    const missingSha = 'c'.repeat(40);
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([
      task({ name: 'missing', completion: { success: true, interrupted: false, sha: missingSha } }), task(),
    ]);
    vi.mocked(goalGit.isGoalCommitIncluded).mockImplementation(async (_cwd, source) => {
      if (source === missingSha) throw new Error('Goal Git merge-base failed (128)');
      return true;
    });
    vi.mocked(goalGit.runGoalGit).mockImplementation(async (_cwd, _args, _limit, _signal, acceptedCodes = [0]) => {
      if (!acceptedCodes.includes(128)) throw new Error('Goal Git cat-file failed (128)');
      return { output: Buffer.alloc(0), code: 128, truncated: false };
    });
    const output = await list();
    expect(output.tasks[0]).toMatchObject({ name: 'missing', goalIntegration: 'unknown' });
    expect(output.tasks[0]?.goalIntegrationReason).toEqual(expect.stringMatching(/commit.*(?:missing|not found|unavailable|cannot|could not)|コミット.*(?:見つから|存在し|読み取れ)/i));
    expect(output.tasks[1]).toMatchObject({ goalIntegration: 'integrated' });
    expect(vi.mocked(goalGit.runGoalGit).mock.calls[0]?.slice(0, 2)).toEqual([
      cwd, ['cat-file', '-e', '--', `${missingSha}^{commit}`],
    ]);
  });

  it('returns unknown with the Git failure reason when the completion commit exists', async () => {
    vi.mocked(goalGit.isGoalCommitIncluded).mockRejectedValue(new Error('ancestry check unavailable'));
    const output = await list();
    expect(output.tasks[0]).toMatchObject({ goalIntegration: 'unknown',
      goalIntegrationReason: expect.stringContaining('ancestry check unavailable') });
  });

  it('reports a failed commit check as a Git failure without asserting that the commit is missing', async () => {
    vi.mocked(goalGit.isGoalCommitIncluded).mockRejectedValue(new Error('ancestry process unavailable'));
    vi.mocked(goalGit.runGoalGit).mockRejectedValue(new Error('commit check process unavailable'));
    const output = await list();
    expect(output.tasks[0]).toMatchObject({ goalIntegration: 'unknown',
      goalIntegrationReason: expect.stringContaining('commit check process unavailable') });
  });

  it('sanitizes external branch errors before including them in the task response', async () => {
    vi.mocked(goalGit.resolveGoalBranchSha).mockRejectedValue(
      new Error("EACCES: permission denied, open '/Users/reviewer/secret/goal.json'"),
    );
    const output = await list();
    expect(output.tasks[0]).toMatchObject({ goalIntegration: 'unknown',
      goalIntegrationReason: expect.stringContaining('permission denied') });
    expect(output.tasks[0]?.goalIntegrationReason).not.toContain('/Users/reviewer/secret');
  });

  it('localizes goal read failures and still returns tasks from another goal', async () => {
    const otherGoalId = '650e8400-e29b-41d4-a716-446655440000';
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([task(), task({ name: 'healthy', goalId: otherGoalId })]);
    goalDoubles.get.mockImplementation(async (id: string) => {
      if (id === goalId) throw new Error('goal unavailable');
      return { ...goalRecord(), id: otherGoalId };
    });
    const output = await list();
    expect(output.tasks[0]).toMatchObject({ goalIntegration: 'unknown', goalIntegrationReason: expect.any(String) });
    expect(output.tasks[0]?.goalIntegrationReason).not.toBe('');
    expect(output.tasks[1]).toMatchObject({ name: 'healthy', goalIntegration: 'integrated' });
  });

  it('shares a branch resolution failure only within one list call and retries on the next call', async () => {
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([task(), task({ name: 'second' })]);
    vi.mocked(goalGit.resolveGoalBranchSha).mockRejectedValueOnce(new Error('goal branch unavailable')).mockResolvedValue(goalSha);
    const first = await list();
    expect(first.tasks).toHaveLength(2);
    for (const entry of first.tasks) {
      expect(entry).toMatchObject({ goalIntegration: 'unknown', goalIntegrationReason: expect.any(String) });
      expect(entry.goalIntegrationReason).not.toBe('');
    }
    expect(goalGit.resolveGoalBranchSha).toHaveBeenCalledTimes(1);
    expect(goalGit.isGoalCommitIncluded).not.toHaveBeenCalled();
    expect((await list()).tasks.map((entry) => entry.goalIntegration)).toEqual(['integrated', 'integrated']);
    expect(goalGit.resolveGoalBranchSha).toHaveBeenCalledTimes(2);
  });

  it('keeps the existing summary and omits integration fields for tasks without a goal', async () => {
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([task({ goalId: undefined, summary: 'ordinary task' })]);
    const output = await list();
    expect(output.tasks).toEqual([{ name: 'completed-task', summary: 'ordinary task', status: 'completed' }]);
    expect(goalDoubles.get).not.toHaveBeenCalled();
    expect(goalGit.resolveGoalBranchSha).not.toHaveBeenCalled();
    expect(goalGit.isGoalCommitIncluded).not.toHaveBeenCalled();
    expect(goalGit.runGoalGit).not.toHaveBeenCalled();
  });

  it('checks only the selected page and resolves each goal tip once per call', async () => {
    const tasks = Array.from({ length: 20 }, (_, index) => task({ name: `task-${index}`,
      completion: { success: true, interrupted: false, sha: index.toString(16).padStart(40, '0') } }));
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue(tasks);
    const output = await list({ offset: 7, limit: 2 });
    expect(output).toMatchObject({ totalCount: 20, returnedCount: 2, offset: 7, nextOffset: 9 });
    expect(output.tasks.map((entry) => entry.name)).toEqual(['task-7', 'task-8']);
    expect(output.tasks.map((entry) => entry.goalIntegration)).toEqual(['integrated', 'integrated']);
    expect(goalDoubles.get).toHaveBeenCalledTimes(1);
    expect(goalGit.resolveGoalBranchSha).toHaveBeenCalledTimes(1);
    expect(vi.mocked(goalGit.isGoalCommitIncluded).mock.calls.map((args) => args.slice(0, 3))).toEqual([
      [cwd, tasks[7]!.completion!.sha, goalSha], [cwd, tasks[8]!.completion!.sha, goalSha],
    ]);
    expect(goalGit.runGoalGit).not.toHaveBeenCalled();
  });

  it('reads the current goal tip again on every list call', async () => {
    const newGoalSha = 'd'.repeat(40);
    vi.mocked(goalGit.resolveGoalBranchSha).mockResolvedValueOnce(goalSha).mockResolvedValueOnce(newGoalSha);
    vi.mocked(goalGit.isGoalCommitIncluded).mockImplementation(async (_cwd, _source, target) => target === newGoalSha);
    expect((await list()).tasks[0]?.goalIntegration).toBe('not_integrated');
    expect((await list()).tasks[0]?.goalIntegration).toBe('integrated');
    expect(goalGit.resolveGoalBranchSha).toHaveBeenCalledTimes(2);
  });

  it('bounds integration reasons to 64 KiB and preserves pagination without gaps', async () => {
    const tasks = Array.from({ length: 12 }, (_, index) => task({ name: `task-${index}`, summary: '説明'.repeat(1000) }));
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue(tasks);
    vi.mocked(goalGit.resolveGoalBranchSha).mockRejectedValue(new Error('branch unavailable: ' + '理由'.repeat(1000)));
    const names: unknown[] = [];
    let offset = 0;
    for (let pageIndex = 0; pageIndex < tasks.length; pageIndex++) {
      const result = await listTaktTasks({ cwd, offset, limit: 12 });
      expect(result.isError).toBeUndefined();
      expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      const output = JSON.parse(firstTextContent(result.content));
      expect(output).toMatchObject({ totalCount: tasks.length, offset, returnedCount: output.tasks.length });
      expect(output.tasks.length).toBeGreaterThan(0);
      for (const entry of output.tasks) {
        expect(entry).toMatchObject({ goalIntegration: 'unknown', goalIntegrationReason: expect.any(String) });
      }
      names.push(...output.tasks.map((entry: { name: string }) => entry.name));
      if (output.nextOffset === null) break;
      expect(output.nextOffset).toBe(offset + output.tasks.length);
      expect(output.nextOffset).toBeGreaterThan(offset);
      offset = output.nextOffset;
    }
    expect(names).toEqual(tasks.map((entry) => entry.name));
  });

  it('preserves a run metadata error alongside the integration result', async () => {
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockReturnValue([task({ runSlug: 'missing-run' })]);
    vi.spyOn(runMeta, 'readRunMetaBySlug').mockReturnValue(null);
    expect((await list()).tasks[0]).toMatchObject({ runSlug: 'missing-run',
      error: expect.stringMatching(/\S/), goalIntegration: 'integrated' });
  });

  it('preserves whole-tool errors when reading the task queue fails', async () => {
    vi.mocked(TaskRunner.prototype.listTaskStateItems).mockImplementation(() => { throw new Error('queue unavailable'); });
    const result = await listTaktTasks({ cwd });
    expect(result.isError).toBe(true);
    expect(firstTextContent(result.content)).toContain('Task list failed');
    expect(goalGit.resolveGoalBranchSha).not.toHaveBeenCalled();
  });
});

describe('MCP goal operations', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it.each([false, true])('returns persisted list and selected detail with readOnly=%s', async (readOnly) => {
    goalDoubles.list.mockResolvedValue({ goals: [goalRecord()], errors: [] });
    goalDoubles.get.mockResolvedValue(goalRecord());
    const listed = await listTaktGoals({ cwd: '/repo' }, { readOnly });
    const detail = await getTaktGoal({ cwd: '/repo', goalId }, { readOnly });
    expect(listed.isError).toBeUndefined();
    expect(detail.isError).toBeUndefined();
    expect(JSON.parse(firstTextContent(listed.content))).toMatchObject({ goals: [goalSummary(goalRecord())], totalCount: 1 });
    expect(JSON.parse(firstTextContent(listed.content))).not.toHaveProperty('errors');
    expect(JSON.parse(firstTextContent(listed.content))).not.toHaveProperty('errorPage');
    expect(JSON.parse(firstTextContent(detail.content))).toEqual({ goal: goalSummary(goalRecord()) });
    expect(goalDoubles.get).toHaveBeenCalledWith(goalId);
  });
  it('returns healthy goals and sanitized individual corruption errors together', async () => {
    goalDoubles.list.mockResolvedValue({
      goals: [goalRecord()],
      errors: [{ goalId, error: new Error('Invalid goal file: /Users/reviewer/secret/goal.json') }],
    });
    const result = await listTaktGoals({ cwd: '/repo' }, {});
    expect(result.isError).toBe(true);
    const output = JSON.parse(firstTextContent(result.content)) as {
      goals: unknown[]; errors: { goalId: string; error: string }[];
    };
    expect(output.goals).toEqual([goalSummary(goalRecord())]);
    expect(output.errors).toEqual([{ goalId, error: expect.stringMatching(/Invalid goal file/) }]);
    expect(output.errors[0]!.error).not.toContain('/Users/reviewer/secret');
  });
  it.each([0, 1, 50, 51])('pages %i individual errors and preserves their order through exhaustion', async (count) => {
    const errors = invalidGoalErrors(count);
    goalDoubles.list.mockResolvedValue({ goals: [], errors });
    const first = await listTaktGoals({ cwd: '/repo' }, {});
    const output = JSON.parse(firstTextContent(first.content));
    expect(responseBytes(first)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
    if (count === 0) {
      expect(first.isError).toBeUndefined();
      expect(output).not.toHaveProperty('errors');
      expect(output).not.toHaveProperty('errorPage');
      return;
    }
    expect(first.isError).toBe(true);
    expect(output.truncated).toBe(false);
    expect(output.errors.map((error: { goalId: string }) => error.goalId)).toEqual(errors.slice(0, 50).map(({ goalId }) => goalId));
    expect(output.errorPage).toMatchObject({ collection: 'errors', totalCount: count,
      returnedCount: Math.min(count, 50), omittedCount: Math.max(0, count - 50), offset: 0,
      nextOffset: count > 50 ? 50 : null, truncated: count > 50 });
    expect(output.errorPage.retrieval).toContain('errorOffset');
    if (output.errorPage.nextOffset !== null) {
      const next = await listTaktGoals({ cwd: '/repo', errorOffset: output.errorPage.nextOffset }, {});
      const page = JSON.parse(firstTextContent(next.content));
      expect(next.isError).toBe(true);
      expect(responseBytes(next)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      expect(page.errors.map((error: { goalId: string }) => error.goalId)).toEqual(errors.slice(50).map(({ goalId }) => goalId));
      expect(page.errorPage).toMatchObject({ totalCount: count, returnedCount: 1, omittedCount: 50, offset: 50, nextOffset: null, truncated: true });
    }
    for (const errorOffset of [count, count + 1]) {
      const exhausted = await listTaktGoals({ cwd: '/repo', errorOffset }, {});
      const page = JSON.parse(firstTextContent(exhausted.content));
      expect(exhausted.isError).toBe(true);
      expect(page.errors).toEqual([]);
      expect(page.errorPage).toMatchObject({ totalCount: count, returnedCount: 0, omittedCount: count, offset: errorOffset, nextOffset: null, truncated: true });
    }
  });
  it('keeps healthy goal and individual error offsets independent', async () => {
    const goals = [goalRecord(), { ...goalRecord(), id: '750e8400-e29b-41d4-a716-446655440000' }];
    const errors = invalidGoalErrors(2);
    goalDoubles.list.mockResolvedValue({ goals, errors });
    const first = JSON.parse(firstTextContent((await listTaktGoals({ cwd: '/repo', limit: 1, offset: 0, errorOffset: 0 }, {})).content));
    const nextGoal = JSON.parse(firstTextContent((await listTaktGoals({ cwd: '/repo', limit: 1, offset: 1, errorOffset: 0 }, {})).content));
    const nextError = JSON.parse(firstTextContent((await listTaktGoals({ cwd: '/repo', limit: 1, offset: 0, errorOffset: 1 }, {})).content));
    expect(first).toMatchObject({ totalCount: 2, returnedCount: 1, nextOffset: 1,
      goals: [{ id: goals[0]!.id }], errors: [{ goalId: errors[0]!.goalId }],
      errorPage: { totalCount: 2, returnedCount: 1, omittedCount: 1, nextOffset: 1 } });
    expect(nextGoal.goals.map((goal: { id: string }) => goal.id)).toEqual([goals[1]!.id]);
    expect(nextGoal).toMatchObject({ totalCount: 2, offset: 1, nextOffset: null });
    expect(nextGoal.errors).toEqual(first.errors);
    expect(nextGoal.errorPage).toEqual(first.errorPage);
    expect(nextError.goals).toEqual(first.goals);
    expect(nextError).toMatchObject({ totalCount: 2, offset: 0, nextOffset: 1,
      errors: [{ goalId: errors[1]!.goalId }], errorPage: { offset: 1, nextOffset: null } });
  });
  it('retrieves every error from an oversized list without duplicates or gaps', async () => {
    const errors = invalidGoalErrors(2000);
    goalDoubles.list.mockResolvedValue({ goals: [], errors });
    expect(Buffer.byteLength(JSON.stringify({ errors: errors.map(({ goalId }) => ({ goalId, error: 'Invalid goal file' })) }))).toBeGreaterThan(MCP_RESPONSE_MAX_BYTES);
    const ids: string[] = [];
    let errorOffset = 0;
    for (;;) {
      const result = await listTaktGoals({ cwd: '/repo', errorOffset, limit: 50 }, {});
      const page = JSON.parse(firstTextContent(result.content));
      expect(result.isError).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      expect(page.errorPage).toMatchObject({ totalCount: errors.length, offset: errorOffset,
        returnedCount: page.errors.length, omittedCount: errors.length - page.errors.length, truncated: true });
      ids.push(...page.errors.map((error: { goalId: string }) => error.goalId));
      if (page.errorPage.nextOffset === null) break;
      expect(page.errorPage.nextOffset).toBe(errorOffset + page.errors.length);
      expect(page.errorPage.nextOffset).toBeGreaterThan(errorOffset);
      errorOffset = page.errorPage.nextOffset;
    }
    expect(ids).toEqual(errors.map(({ goalId }) => goalId));
    expect(new Set(ids).size).toBe(errors.length);
  });
  it('validates the error offset and shared item limit with the existing read rules', () => {
    for (const errorOffset of [undefined, 0, 1]) {
      expect(listGoalsInputSchema.safeParse({ cwd: '/repo', errorOffset }).success).toBe(true);
    }
    for (const errorOffset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(listGoalsInputSchema.safeParse({ cwd: '/repo', errorOffset }).success).toBe(false);
    }
    for (const limit of [1, 50]) expect(listGoalsInputSchema.safeParse({ cwd: '/repo', limit }).success).toBe(true);
    for (const limit of [0, 51]) expect(listGoalsInputSchema.safeParse({ cwd: '/repo', limit }).success).toBe(false);
  });
  it('converts store failures to MCP errors', async () => {
    goalDoubles.list.mockRejectedValue(new Error('corrupt'));
    goalDoubles.get.mockRejectedValue(new Error('missing'));
    expect((await listTaktGoals({ cwd: '/repo' }, {})).isError).toBe(true);
    expect((await getTaktGoal({ cwd: '/repo', goalId }, {})).isError).toBe(true);
  });
  it.each([false, true])('bounds large patrol responses and allows saved text retrieval with readOnly=%s', async (readOnly) => {
    const goal: Goal = { ...goalRecord(), objective: '日本語'.repeat(30000),
      workLog: Array.from({ length: 100 }, (_, index) => ({ id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, summary: '記録'.repeat(20000), recordedAt: '2026-10-14T00:00:00Z' })),
      questions: Array.from({ length: 100 }, (_, index) => ({ id: `650e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, body: '質問'.repeat(20000), recipient: 'human', status: 'pending' })),
      notifications: Array.from({ length: 100 }, (_, index) => ({ id: `750e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, body: '通知'.repeat(20000), kind: 'custom', recordedAt: '2026-10-14T00:00:00Z' })) };
    goalDoubles.get.mockResolvedValue(goal);
    goalDoubles.list.mockResolvedValue({ goals: Array.from({ length: 60 }, () => goal), errors: [] });
    for (const result of [await getTaktGoal({ cwd: '/repo', goalId }, { readOnly }), await listTaktGoals({ cwd: '/repo', limit: 50 }, { readOnly })]) {
      expect(result.isError).toBeUndefined();
      expect(responseBytes(result)).toBeLessThanOrEqual(MCP_RESPONSE_MAX_BYTES);
      const data = JSON.parse(firstTextContent(result.content));
      const selected = data.goal ?? data.goals[0];
      expect(selected).toMatchObject({ status: 'created', executionStatus: 'active', branch: goal.branch, integrationBranch: 'main', workLogCount: 100 });
      expect(selected.questions[0].status).toBe('pending');
      expect(selected.workLog[0].id).toBe(goal.workLog[99]!.id);
    }
    const page = await getTaktGoal({ cwd: '/repo', goalId, path: 'workLog.summary', recordId: goal.workLog[99]!.id, maxBytes: 12 }, {});
    const first = JSON.parse(firstTextContent(page.content));
    expect(first).toMatchObject({ content: '記録記録', totalBytes: 120000, nextOffset: 12, truncated: true });
    const next = JSON.parse(firstTextContent((await getTaktGoal({ cwd: '/repo', goalId, path: 'objective', textOffset: 12, maxBytes: 12 }, {})).content));
    expect(next.offset).toBe(12);
    expect(next.content).toBe('本語日本');
  });
});

const { mockInitGitProvider, mockGetGitProvider, mockGitProvider } = vi.hoisted(() => {
  const gitProvider = {
    createIssue: vi.fn(),
    closeIssue: vi.fn(),
  };
  return {
    mockInitGitProvider: vi.fn(),
    mockGetGitProvider: vi.fn(() => gitProvider),
    mockGitProvider: gitProvider,
  };
});

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initGitProvider: (...args: unknown[]) => mockInitGitProvider(...args),
  getGitProvider: () => mockGetGitProvider(),
}));

const baseInput: EnqueueTaskInput = {
  cwd: '/repo',
  task: 'Implement MCP support',
  workflow: 'default',
  autoPr: false,
};

function text(result: Awaited<ReturnType<typeof enqueueTaktTask>>): string {
  return firstTextContent(result.content);
}

function json(result: Awaited<ReturnType<typeof enqueueTaktTask>>): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

function enqueue(
  extra: Partial<EnqueueTaskInput> = {},
  deps: McpOperationDependencies = {},
  signal?: AbortSignal,
) {
  return enqueueTaktTask({ ...baseInput, ...extra }, deps, signal);
}

describe('MCP enqueue operation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitProvider.mockReturnValue(mockGitProvider);
  });

  it.each([
    { worktree: undefined, autoPr: true, draftPr: false, storedWorktree: true },
    { worktree: false, autoPr: false, draftPr: true, storedWorktree: false },
    { worktree: true, autoPr: false, draftPr: undefined, storedWorktree: true },
  ])('returns saved settings without resolving configuration %#', async ({ storedWorktree, ...input }) => {
    const saveTaskFile = vi.fn<NonNullable<McpOperationDependencies['saveTaskFile']>>()
      .mockResolvedValue({ taskName: 'settings-task', tasksFile: '/repo/.takt/tasks.yaml' });

    const result = await enqueue(input, { saveTaskFile });

    expect(result.isError).toBeUndefined();
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', baseInput.task, expect.objectContaining({
      workflow: 'default',
      worktree: storedWorktree,
      autoPr: input.autoPr,
      ...(input.draftPr === undefined ? {} : { draftPr: input.draftPr }),
    }));
    expect(json(result)).toEqual({
      taskName: 'settings-task',
      tasksFile: '/repo/.takt/tasks.yaml',
      workflow: 'default',
      worktree: storedWorktree,
      autoPr: input.autoPr,
      draftPr: input.draftPr ?? null,
    });
  });

  it('enqueues a normal task without initializing an issue provider', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'normal-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });

    const result = await enqueue({}, { saveTaskFile });

    expect(result.isError).toBeUndefined();
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement MCP support', expect.objectContaining({
      workflow: 'default',
      worktree: true,
      autoPr: false,
    }));
    expect(mockInitGitProvider).not.toHaveBeenCalled();
  });

  it('links an existing issue without creating another issue', async () => {
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'existing-issue-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });

    const result = await enqueue({ issue: { number: 938 } }, { saveTaskFile });

    expect(result.isError).toBeUndefined();
    expect(json(result)).toEqual(expect.objectContaining({ issueNumber: 938 }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', 'Implement MCP support', expect.objectContaining({
      workflow: 'default',
      worktree: true,
      autoPr: false,
      issue: 938,
    }));
    expect(mockInitGitProvider).not.toHaveBeenCalled();
  });

  it('creates an issue from the unchanged task body, explicit title, and labels', async () => {
    const task = '\n# Implement MCP support\n\nKeep whitespace.  \n';
    const saveTaskFile = vi.fn().mockResolvedValue({
      taskName: 'created-issue-task',
      tasksFile: '/repo/.takt/tasks.yaml',
    });
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
      issueUrl: 'https://example.test/issues/938',
    });

    const result = await enqueue({
      task,
      issue: { create: true, title: 'MCP consolidation', labels: ['enhancement'] },
    }, { saveTaskFile, createIssueFromTaskResult });

    expect(result.isError).toBeUndefined();
    expect(mockInitGitProvider).toHaveBeenCalledWith('/repo');
    expect(createIssueFromTaskResult).toHaveBeenCalledWith(task, expect.objectContaining({
      cwd: '/repo',
      explicitTitle: 'MCP consolidation',
      labels: ['enhancement'],
      outputMode: 'silent',
      gitProvider: mockGitProvider,
    }));
    expect(saveTaskFile).toHaveBeenCalledWith('/repo', task, expect.objectContaining({
      workflow: 'default',
      worktree: true,
      autoPr: false,
      issue: 938,
    }));
  });

  it('returns a structured issue creation error and skips saving', async () => {
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      error: 'GitHub CLI is not authenticated',
    });

    const result = await enqueue({ autoPr: true, draftPr: false, issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(result.isError).toBe(true);
    expect(json(result)).toEqual({
      issueCreated: false,
      taskEnqueued: false,
      stage: 'issue_creation',
      error: 'GitHub CLI is not authenticated',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('keeps a created issue open and returns sanitized retry details when saving fails', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, open '/Users/reviewer/secret/.takt/tasks.yaml'"),
    );
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: true,
      issueNumber: 938,
      issueUrl: 'https://user:secret@example.test/issues/938?token=secret#fragment',
    });

    const result = await enqueue({ autoPr: true, draftPr: false, issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(result.isError).toBe(true);
    expect(json(result)).toEqual({
      issueCreated: true,
      issueNumber: 938,
      issueUrl: 'https://example.test/issues/938',
      taskEnqueued: false,
      stage: 'task_saving',
      error: 'permission denied',
    });
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('reports issue-number parsing as partial success without an issue number', async () => {
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn().mockReturnValue({
      success: false,
      issueCreated: true,
      issueUrl: 'https://example.test/issues/unknown',
      error: 'Failed to extract issue number',
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    });

    expect(json(result)).toEqual({
      issueCreated: true,
      issueUrl: 'https://example.test/issues/unknown',
      taskEnqueued: false,
      stage: 'issue_number_parsing',
      error: 'Failed to extract issue number',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
  });

  it('returns cancellation details after issue creation and does not close the issue', async () => {
    const controller = new AbortController();
    const saveTaskFile = vi.fn();
    const createIssueFromTaskResult = vi.fn(() => {
      setImmediate(() => controller.abort());
      return { success: true as const, issueNumber: 938 };
    });

    const result = await enqueue({ issue: { create: true } }, {
      saveTaskFile,
      createIssueFromTaskResult,
    }, controller.signal);

    expect(json(result)).toEqual({
      issueCreated: true,
      issueNumber: 938,
      taskEnqueued: false,
      stage: 'cancelled_after_issue_creation',
      error: 'Task enqueue was cancelled.',
    });
    expect(saveTaskFile).not.toHaveBeenCalled();
    expect(mockGitProvider.closeIssue).not.toHaveBeenCalled();
  });

  it('sanitizes normal enqueue failures', async () => {
    const saveTaskFile = vi.fn().mockRejectedValue(
      new Error("EACCES: permission denied, open '/Users/reviewer/secret/.takt/tasks.yaml'"),
    );

    const result = await enqueue({}, { saveTaskFile });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Task enqueue failed: permission denied');
  });
});
