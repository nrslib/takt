import { beforeEach, expect, it, vi } from 'vitest';
import { mergeGoalPr } from '../features/manager/mergeGoalPr.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ enqueue: vi.fn(), config: vi.fn() }));
vi.mock('../features/merge/index.js', async (original) => ({
  ...await original<typeof import('../features/merge/index.js')>(), enqueuePrMergeTask: doubles.enqueue,
}));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: doubles.config }));
const signal = new AbortController().signal;
const goal = { ...goalRecord(), pullRequest: { number: 1950, url: 'https://github.com/example/project/pull/1950' } };
beforeEach(() => {
  vi.resetAllMocks();
  doubles.enqueue.mockImplementation(async (request) => ({ name: 'merge-pr-1950', status: 'pending', data: { workflow: request.workflow } }));
});
it.each([
  { until: 'prepare' as const, config: undefined, workflow: 'merge-prepare' },
  { until: 'prepare' as const, config: { workflow: 'custom' }, workflow: 'merge-prepare' },
  { until: 'prepare' as const, config: { prepareWorkflow: 'custom-prepare', workflow: 'custom' }, workflow: 'custom-prepare' },
  { until: 'merge' as const, config: undefined, workflow: 'merge-review-fix-simple' },
  { until: 'merge' as const, config: { prepareWorkflow: 'custom-prepare', workflow: 'custom' }, workflow: 'custom' },
])('enqueues $until using $workflow and returns the pending task', async ({ until, config, workflow }) => {
  doubles.config.mockReturnValue(config);
  expect(await mergeGoalPr('/project', goal, until, signal)).toEqual({
    taskName: 'merge-pr-1950', goalId: goal.id, prNumber: 1950, mergeTask: true, status: 'pending', until, workflow,
  });
  expect(doubles.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    projectCwd: '/project', prNumber: 1950, until, workflow, abortSignal: signal,
    pullRequest: expect.objectContaining({ number: 1950, url: goal.pullRequest.url }),
  }), goal);
});
it('propagates active target conflicts from the common enqueue path', async () => {
  const failure = new Error('active target'); doubles.enqueue.mockRejectedValue(failure);
  await expect(mergeGoalPr('/project', goal, 'prepare', signal)).rejects.toBe(failure);
});
it.each([undefined, { number: 1951, url: goal.pullRequest.url }])('rejects a missing or inconsistent saved PR', async (pullRequest) => {
  await expect(mergeGoalPr('/project', { ...goal, pullRequest }, 'merge', signal)).rejects.toThrow();
  expect(doubles.enqueue).not.toHaveBeenCalled();
});
