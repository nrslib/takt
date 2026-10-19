import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ spawn: vi.fn(), environment: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: doubles.spawn }));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: doubles.environment }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; getSync() { return structuredClone(goal); } update = doubles.update; } }));
import { goalGitText, isGoalCommitIncluded, isGoalContentIncluded, resolveGoalBranchSha, runGoalGit } from '../infra/goals/git-command.js';
import { checkGoalCompletion } from '../infra/goals/integration.js';
const sourceSha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);
const baseSha = 'c'.repeat(40);
const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
let goal: Goal;
beforeEach(() => {
  vi.resetAllMocks(); doubles.environment.mockResolvedValue({ GIT_LITERAL_PATHSPECS: '1' });
  const initial = goalRecord();
  goal = { ...initial, status: 'awaiting_merge', completion: {
    goalBranch: initial.branch, goalSha: sourceSha, targetBranch: initial.integrationBranch,
    summary: 'evidence', instructions: [],
    changeSummary: { filesChanged: 2, additions: 2, deletions: 0, files: [], truncated: false, totalsTruncated: false },
  } };
  doubles.get.mockImplementation(async () => structuredClone(goal));
  doubles.update.mockImplementation(async (_id: string, transform: (current: Goal) => Goal) => {
    goal = transform(goal); return structuredClone(goal);
  });
});
function processOutput(chunks: Buffer[], code = 0, error = '') {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const terminate = vi.fn();
  doubles.spawn.mockReturnValueOnce({
    child: { stdout, stderr },
    wait: async () => {
      for (const chunk of chunks) stdout.emit('data', chunk);
      stderr.emit('data', Buffer.from(error));
      return { code, signal: null };
    }, terminate,
  });
  return terminate;
}
it('retains only bounded bytes while draining arbitrary stdout chunks', async () => {
  processOutput([Buffer.from('abc'), Buffer.alloc(100000, 'd'), Buffer.alloc(100000, 'e')]);
  expect(await runGoalGit('/project', ['diff'], 5, undefined)).toEqual({ output: Buffer.from('abcdd'), truncated: true, code: 0 });
  expect(doubles.spawn.mock.calls[0]![2]).toMatchObject({ env: { GIT_LITERAL_PATHSPECS: '1' } });
});
it('distinguishes a non-ancestor from a Git failure', async () => {
  processOutput([], 1);
  expect(await isGoalCommitIncluded('/project', 'a', 'b', undefined)).toBe(false);
  processOutput([], 128, 'missing object');
  await expect(isGoalCommitIncluded('/project', 'a', 'b', undefined)).rejects.toThrow();
});
it('rejects incomplete output when a complete Git result is required', async () => {
  processOutput([Buffer.alloc(8 * 1024 * 1024 + 1)]);
  await expect(goalGitText('/project', ['worktree', 'list'], undefined)).rejects.toThrow();
});
it('resolves a fully qualified local branch commit and rejects invalid branch input', async () => {
  processOutput([Buffer.from('a'.repeat(40) + '\n')]);
  expect(await resolveGoalBranchSha('/project', 'main', undefined)).toBe('a'.repeat(40));
  expect(doubles.spawn.mock.calls[0]![1]).toContain('refs/heads/main^{commit}');
  await expect(resolveGoalBranchSha('/project', '-option', undefined)).rejects.toThrow();
});
it('does not start a child for an already cancelled operation', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(runGoalGit('/project', ['diff'], 100, controller.signal)).rejects.toThrow();
  expect(doubles.spawn).not.toHaveBeenCalled();
});
it('terminates a process when capture streams are unavailable', async () => {
  const terminate = vi.fn();
  doubles.spawn.mockReturnValue({ child: { stdout: null, stderr: null }, terminate });
  await expect(runGoalGit('/project', ['diff'], 100, undefined)).rejects.toThrow();
  expect(terminate).toHaveBeenCalledOnce();
});

it('completes an ancestor without requesting content comparison', async () => {
  processOutput([Buffer.from(`${targetSha}\n`)]);
  processOutput([], 0);

  expect(await checkGoalCompletion('/project', goal.id, undefined, policy)).toMatchObject({ included: true, targetSha });
  expect(doubles.spawn).toHaveBeenCalledTimes(2);
});

it.each([
  { name: 'all goal paths match', changed: 'first.txt\0second.txt\0', different: '', included: true },
  { name: 'only unrelated paths differ', changed: 'first.txt\0second.txt\0', different: 'other.txt\0', included: true },
  { name: 'one goal path is missing', changed: 'first.txt\0second.txt\0', different: 'second.txt\0', included: false },
  { name: 'goal paths have no changes', changed: '', different: 'other.txt\0', included: true },
  { name: 'a newline path differs', changed: 'line\nbreak.txt\0', different: 'line\nbreak.txt\0', included: false },
  { name: 'a trailing space distinguishes paths', changed: 'file \0', different: 'file\0', included: true },
  { name: 'a removed path still exists in the target', changed: 'old.txt\0new.txt\0', different: 'old.txt\0', included: false },
])('checks non-ancestor content when $name', async ({ changed, different, included }) => {
  processOutput([Buffer.from(`${targetSha}\n`)]);
  processOutput([], 1);
  processOutput([Buffer.from(`${baseSha}\n`)]);
  processOutput([Buffer.from(changed)]);
  processOutput([Buffer.from(different)]);
  const before = structuredClone(goal);

  expect(await checkGoalCompletion('/project', goal.id, undefined, policy)).toMatchObject({ included });
  if (included) {
    expect(goal).toMatchObject({ status: 'completed', completion: { goalSha: sourceSha, targetSha } });
  } else {
    expect(goal).toEqual(before);
    expect(doubles.update).not.toHaveBeenCalled();
  }
});

it.each(['ancestry failure', 'missing merge base', 'empty merge base', 'changed paths failure', 'different paths failure', 'truncated paths', 'truncated different paths', 'incomplete changed paths', 'incomplete different paths'])(
  'does not save completion on %s', async (failure) => {
    processOutput([Buffer.from(`${targetSha}\n`)]);
    processOutput([], failure === 'ancestry failure' ? 128 : 1);
    processOutput([Buffer.from(failure === 'empty merge base' ? '' : `${baseSha}\n`)], failure === 'missing merge base' ? 1 : 0);
    processOutput([failure === 'truncated paths' ? Buffer.alloc(8 * 1024 * 1024 + 1)
      : Buffer.from(failure === 'incomplete changed paths' ? 'goal.txt' : 'goal.txt\0')], failure === 'changed paths failure' ? 128 : 0);
    processOutput([failure === 'truncated different paths' ? Buffer.alloc(8 * 1024 * 1024 + 1)
      : Buffer.from(failure === 'incomplete different paths' ? 'goal.txt' : 'goal.txt\0')], failure === 'different paths failure' ? 128 : 0);
    const before = structuredClone(goal);

    await expect(checkGoalCompletion('/project', goal.id, undefined, policy)).rejects.toThrow();
    expect(goal).toEqual(before);
    expect(doubles.update).not.toHaveBeenCalled();
  },
);

it('compares raw path bytes and uses complete rename-disabled NUL-delimited diffs', async () => {
  processOutput([], 1);
  processOutput([Buffer.from(`${baseSha}\n`)]);
  processOutput([Buffer.from([0xff, 0])]);
  processOutput([Buffer.from([0xfe, 0])]);

  expect(await isGoalContentIncluded('/project', sourceSha, targetSha, undefined)).toBe(true);
  const diffArgs = ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty'];
  expect(doubles.spawn.mock.calls[2]![1]).toEqual([
    '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', ...diffArgs, baseSha, sourceSha, '--',
  ]);
  expect(doubles.spawn.mock.calls[3]![1]).toEqual([
    '-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', ...diffArgs, sourceSha, targetSha, '--',
  ]);
});
