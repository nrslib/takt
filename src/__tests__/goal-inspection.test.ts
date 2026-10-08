import { beforeEach, expect, expectTypeOf, it, vi } from 'vitest';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ run: vi.fn(), text: vi.fn(), sha: vi.fn(), included: vi.fn(), source: vi.fn() }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { async get() { return structuredClone(goal); } } }));
vi.mock('../infra/goals/integration.js', () => ({ getGoalTaskSource: doubles.source }));
vi.mock('../infra/goals/git-command.js', () => ({
  runGoalGit: doubles.run, goalGitText: doubles.text, resolveGoalBranchSha: doubles.sha, isGoalCommitIncluded: doubles.included,
}));
import { inspectGoalDiff, inspectGoalHistory, inspectGoalRelation } from '../infra/goals/inspection.js';
import { parseGoalNumstat, readGoalDiffSummary } from '../infra/goals/diff-summary.js';
let goal = goalRecord();
beforeEach(() => {
  vi.resetAllMocks();
  goal = { ...goalRecord(), integrationBranch: 'release' };
  doubles.source.mockResolvedValue('takt/result');
  doubles.sha.mockImplementation(async (_cwd: string, branch: string) => branch === 'takt/result' ? 'a'.repeat(40) : 'b'.repeat(40));
});
it('retains tab/newline names, binary unknown counts and complete records before truncation', () => {
  expect(parseGoalNumstat(Buffer.from('2\t1\tdocs/a\tb\nc.md\0-\t-\timage.bin\0unfinished'), 50, true)).toEqual({
    files: [
      { path: 'docs/a\tb\nc.md', additions: 2, deletions: 1 },
      { path: 'image.bin', additions: null, deletions: null },
    ], filesChanged: 2, additions: 2, deletions: 1, truncated: true, totalsTruncated: true,
  });
  expect(parseGoalNumstat(Buffer.from('1\t0\ta\0'), 1, false)).toMatchObject({ truncated: false });
  expect(parseGoalNumstat(Buffer.from('1\t0\ta\0' + '1\t0\tb\0'), 1, false)).toMatchObject({ files: [{ path: 'a', additions: 1, deletions: 0 }], truncated: true });
});
it('uses the merge base of pinned SHAs for summaries and literal file patches, disables rename and external diff', async () => {
  const file = ':(glob)*\tfile';
  doubles.run.mockResolvedValueOnce({ output: Buffer.from('2\t1\ta\0'), truncated: false, code: 0 })
    .mockResolvedValueOnce({ output: Buffer.from('+partial'), truncated: true, code: 0 });
  expect(await inspectGoalDiff('/project', goal.id, 'task', file, 3, undefined)).toMatchObject({
    sourceBranch: 'takt/result', comparisonBranch: goal.branch, sourceSha: 'a'.repeat(40), truncated: true, patch: '+partial',
  });
  const range = `${'b'.repeat(40)}...${'a'.repeat(40)}`;
  expect(doubles.run.mock.calls[0]![1]).toEqual([
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', range, '--numstat', '-z',
  ]);
  expect(doubles.run.mock.calls[1]![1]).toEqual([
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', range, '--', file,
  ]);
  expect(doubles.run.mock.calls.every(([, , limit]) => limit <= 4096)).toBe(true);
});
it('compares the goal only to the saved integration branch when no task is selected', async () => {
  expectTypeOf<Parameters<typeof inspectGoalDiff>['length']>().toEqualTypeOf<6>();
  doubles.run.mockResolvedValue({ output: Buffer.alloc(0), truncated: false, code: 0 });
  expect(await inspectGoalDiff('/project', goal.id, undefined, undefined, 50, undefined)).toMatchObject({
    sourceBranch: goal.branch, comparisonBranch: 'release', files: [], truncated: false,
  });
  expect(doubles.sha).toHaveBeenLastCalledWith('/project', 'release', undefined);
  expect(doubles.source).not.toHaveBeenCalled();
});
it('limits Git history before acquisition and separately bounds each message', async () => {
  expectTypeOf<Parameters<typeof inspectGoalHistory>['length']>().toEqualTypeOf<5>();
  const hashes = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
  doubles.text.mockResolvedValue(hashes.join('\n'));
  doubles.run.mockResolvedValue({ output: Buffer.from('partial'), truncated: true, code: 0 });
  const result = await inspectGoalHistory('/project', goal.id, undefined, 3, undefined);
  expect(result.sourceBranch).toBe(goal.branch);
  expect(doubles.sha).toHaveBeenCalledExactlyOnceWith('/project', goal.branch, undefined);
  expect(result.commits.map((commit) => commit.sha)).toEqual(hashes.slice(0, 3));
  expect(result.truncated).toBe(true);
  expect(doubles.text).toHaveBeenCalledWith('/project', ['log', '--max-count=4', '--format=%H', 'b'.repeat(40)], undefined);
  expect(doubles.run.mock.calls.every(([, , limit]) => limit === 128)).toBe(true);
});
it('computes containment and ahead against only the saved integration branch', async () => {
  expectTypeOf<Parameters<typeof inspectGoalRelation>['length']>().toEqualTypeOf<3>();
  doubles.sha.mockResolvedValueOnce('a'.repeat(40)).mockResolvedValueOnce('b'.repeat(40));
  doubles.included.mockResolvedValue(false);
  doubles.text.mockResolvedValue('2');
  expect(await inspectGoalRelation('/project', goal.id, undefined)).toMatchObject({
    goalSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), targetBranch: 'release', included: false, ahead: 2,
  });
  expect(doubles.sha).toHaveBeenLastCalledWith('/project', 'release', undefined);
  expect(doubles.text).toHaveBeenCalledWith('/project', ['rev-list', '--count', `${'b'.repeat(40)}..${'a'.repeat(40)}`], undefined);
});

it('counts all captured changes while bounding the file list and distinguishes incomplete totals', async () => {
  const output = Buffer.from(Array.from({ length: 60 }, (_, index) => `2\t1\tfile-${index}\0`).join(''));
  doubles.run.mockResolvedValue({ output, truncated: false, code: 0 });
  const result = await readGoalDiffSummary('/project', 'b'.repeat(40), 'a'.repeat(40), 50, undefined);
  expect(result).toMatchObject({ filesChanged: 60, additions: 120, deletions: 60, truncated: true, totalsTruncated: false });
  expect(result.files).toHaveLength(50);
  expect(doubles.run).toHaveBeenCalledWith('/project', [
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', `${'b'.repeat(40)}...${'a'.repeat(40)}`, '--numstat', '-z',
  ], 4096, undefined);
  doubles.run.mockResolvedValue({ output: Buffer.from('2\t1\tfile\0partial'), truncated: true, code: 0 });
  expect(await readGoalDiffSummary('/project', 'b'.repeat(40), 'a'.repeat(40), 50, undefined))
    .toMatchObject({ filesChanged: 1, additions: 2, deletions: 1, truncated: true, totalsTruncated: true });
});
