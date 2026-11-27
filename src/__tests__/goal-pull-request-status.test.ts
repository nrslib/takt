import { beforeEach, expect, it, vi } from 'vitest';
import { readGoalPullRequestStatus } from '../infra/goals/pull-request-status.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('../infra/github/pr-status.js', () => ({ fetchPrMergeStatus: fetch }));
let goal: Goal;
const response = () => ({ number: 1950, url: goal.pullRequest!.url, headRefName: goal.branch,
  baseRefName: goal.integrationBranch, baseRefOid: 'b'.repeat(40), mergeCommit: { oid: 'c'.repeat(40) }, state: 'MERGED' as const });
beforeEach(() => {
  goal = { ...goalRecord(), pullRequest: { number: 1950, url: 'https://github.com/example/project/pull/1950' } };
  fetch.mockReset().mockResolvedValue(response());
});

it.each(['OPEN', 'CLOSED', 'MERGED'])('returns matching PR evidence with state %s', async (state) => {
  fetch.mockResolvedValue({ ...response(), state });
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toEqual({ status: 'available',
    pullRequest: { ...response(), state } });
});

it('reads the saved PR identity with the supplied cancellation signal', async () => {
  const signal = new AbortController().signal;
  await readGoalPullRequestStatus('/project', goal, signal);
  expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ number: 1950, url: goal.pullRequest!.url }),
    '/project', { signal });
});

it.each([{ headRefName: 'other' }, { baseRefName: 'develop' }])('marks different goal branches as mismatched: %j', async (overrides) => {
  fetch.mockResolvedValue({ ...response(), ...overrides });
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toEqual({ status: 'mismatch' });
});

it('does not query GitHub when no PR is saved', async () => {
  delete goal.pullRequest;
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('does not query a URL whose PR number differs from the saved number', async () => {
  goal = { ...goal, pullRequest: { ...goal.pullRequest!, number: 1951 } };
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toEqual({ status: 'mismatch' });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['invalid URL', 'gh failure'])('reports unavailable PR evidence after %s', async (condition) => {
  if (condition === 'invalid URL') goal = { ...goal, pullRequest: { number: 1950, url: 'invalid' } };
  else fetch.mockRejectedValue(new Error('not authenticated'));
  expect(await readGoalPullRequestStatus('/project', goal, undefined)).toEqual({ status: 'unavailable' });
});

it.each([false, true])('propagates cancellation during lookup when the fetch rejects=%s', async (reject) => {
  const controller = new AbortController();
  fetch.mockImplementation(async () => {
    controller.abort();
    if (reject) throw controller.signal.reason;
    return response();
  });
  await expect(readGoalPullRequestStatus('/project', goal, controller.signal)).rejects.toBe(controller.signal.reason);
});

it('does not start a lookup after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(readGoalPullRequestStatus('/project', goal, controller.signal)).rejects.toBe(controller.signal.reason);
  expect(fetch).not.toHaveBeenCalled();
});
