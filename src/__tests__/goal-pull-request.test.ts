import { beforeEach, expect, it, vi } from 'vitest';
import { prepareGoalPullRequest } from '../infra/goals/pull-request.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ git: vi.fn(), find: vi.fn(), create: vi.fn(), details: vi.fn() }));
vi.mock('../infra/goals/git-command.js', () => ({ runGoalGit: doubles.git }));
vi.mock('../infra/github/GitHubProvider.js', () => ({ GitHubProvider: class {
  findExistingPr = doubles.find;
  createPullRequest = doubles.create;
  fetchPrDetails = doubles.details;
} }));
vi.mock('../shared/i18n/index.js', () => ({ getLabel: (key: string, language: string) => `${language}:${key}` }));

const goal = goalRecord();
const sha = 'a'.repeat(40);
const completion = {
  goalBranch: goal.branch, goalSha: sha, targetBranch: 'main', summary: 'Test evidence', instructions: [],
  changeSummary: { filesChanged: 1, additions: 1, deletions: 0, files: [{ path: 'result.ts', additions: 1, deletions: 0 }],
    truncated: false, totalsTruncated: false },
};
const pr = { number: 1950, url: 'https://github.com/example/project/pull/1950' };
const prDetails = { number: pr.number, headBranch: goal.branch, headSha: sha, baseBranch: 'main', sameRepository: true,
  headRepositoryUrl: 'https://github.com/example/project.git', headRepositoryPushUrls: ['https://github.com/example/project.git'] };
const signal = new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  doubles.git.mockResolvedValue({ output: Buffer.alloc(0), code: 0, truncated: false });
  doubles.create.mockReturnValue({ success: true, url: pr.url });
  doubles.details.mockResolvedValue(prDetails);
});

it.each(['ja', 'en'] as const)('publishes the reviewed SHA before creating the PR with %s review information', async (language) => {
  doubles.create.mockImplementation((options) => {
    expect(doubles.git).toHaveBeenCalledExactlyOnceWith('/project',
      ['push', '--', 'origin', `${sha}:refs/heads/${goal.branch}`], 4096, signal);
    expect(options).toMatchObject({ branch: goal.branch, base: 'main' });
    for (const text of [goal.objective, 'result.ts', completion.summary, 'Open the result', `${language}:manager.goalPr.humanChecks`]) {
      expect(options.body).toContain(text);
    }
    return { success: true, url: pr.url };
  });
  expect(await prepareGoalPullRequest('/project', goal, completion, 'Open the result', language, signal)).toEqual(pr);
});

it('reuses the existing matching PR without creating another', async () => {
  doubles.find.mockReturnValue(pr);
  expect(await prepareGoalPullRequest('/project', goal, completion, 'Check the result', 'ja', signal)).toEqual(pr);
  expect(doubles.details).toHaveBeenCalledExactlyOnceWith(1950, '/project', signal);
  expect(doubles.create).not.toHaveBeenCalled();
});

it.each([
  { headBranch: 'other', baseBranch: 'main', sameRepository: true },
  { headBranch: goal.branch, baseBranch: 'release', sameRepository: true },
  { headBranch: goal.branch, baseBranch: 'main', sameRepository: false },
])('rejects an existing PR for another target: %j', async (details) => {
  doubles.find.mockReturnValue(pr); doubles.details.mockResolvedValue({ ...prDetails, ...details });
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal)).rejects.toThrow();
  expect(doubles.create).not.toHaveBeenCalled();
});

it.each([undefined, '', ' \n '])('rejects missing verification steps before publishing: %s', async (checks) => {
  await expect(prepareGoalPullRequest('/project', goal, completion, checks, 'en', signal)).rejects.toThrow();
  expect(doubles.git).not.toHaveBeenCalled(); expect(doubles.create).not.toHaveBeenCalled();
});

it('propagates push failure without creating a PR', async () => {
  doubles.git.mockRejectedValue(new Error('push failed'));
  await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal)).rejects.toThrow();
  expect(doubles.find).not.toHaveBeenCalled(); expect(doubles.create).not.toHaveBeenCalled();
});

it.each([{ success: false, error: 'failure' }, { success: true }, { success: true, url: 'invalid' }])(
  'rejects failed or incomplete creation results: %j', async (result) => {
    doubles.create.mockReturnValue(result);
    await expect(prepareGoalPullRequest('/project', goal, completion, 'Check', 'en', signal)).rejects.toThrow();
  },
);
