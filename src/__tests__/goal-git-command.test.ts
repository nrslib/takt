import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';
const doubles = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), environment: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawnSync: doubles.spawnSync }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: doubles.spawn }));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: doubles.environment }));
vi.mock('../infra/goals/store.js', () => ({ GoalStore: class { get = doubles.get; getSync() { return structuredClone(goal); } update = doubles.update; } }));
import { goalGitText, isGoalCommitIncluded, isGoalContentIncluded, isGoalContentIncludedSync, resolveGoalBranchSha, runGoalGit } from '../infra/goals/git-command.js';
import { checkGoalCompletion } from '../infra/goals/integration.js';
const sourceSha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);
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
  const result = managedOutput(chunks, code, error);
  doubles.spawn.mockReturnValueOnce(result);
  return result.terminate;
}
function managedOutput(chunks: Buffer[], code: number, error: string) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const terminate = vi.fn();
  return {
    child: { stdout, stderr },
    wait: async () => {
      for (const chunk of chunks) stdout.emit('data', chunk);
      stderr.emit('data', Buffer.from(error));
      return { code, signal: null };
    }, terminate,
  };
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
});

it('does not save completion after an ancestry check fails', async () => {
  processOutput([Buffer.from(`${targetSha}\n`)]);
  processOutput([], 128, 'missing object');
  const before = structuredClone(goal);

  await expect(checkGoalCompletion('/project', goal.id, undefined, policy)).rejects.toThrow();
  expect(goal).toEqual(before);
  expect(doubles.update).not.toHaveBeenCalled();
});

interface GitResponse { output: string; code: number }
function contentGit(merge: GitResponse, targetTree: string): void {
  const respond = (args: string[]): GitResponse => {
    if (args.includes('--is-ancestor')) return { output: '', code: 1 };
    if (args.includes('merge-tree')) return merge;
    if (args.includes('rev-parse')) return { output: `${args.includes(`${targetSha}^{tree}`) ? targetTree : targetSha}\n`, code: 0 };
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  };
  doubles.spawn.mockImplementation((_command: string, args: string[]) => {
    const result = respond(args);
    return managedOutput([Buffer.from(result.output)], result.code, 'fixture Git failure');
  });
  doubles.spawnSync.mockImplementation((_command: string, args: string[]) => {
    const result = respond(args);
    const stdout = Buffer.from(result.output);
    const stderr = Buffer.from('fixture Git failure');
    return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status: result.code, signal: null };
  });
}

describe.each(['async', 'sync'] as const)('%s content inclusion', (mode) => {
  const include = async () => mode === 'async'
    ? isGoalContentIncluded('/project', sourceSha, targetSha, undefined)
    : isGoalContentIncludedSync('/project', sourceSha, targetSha, { GIT_LITERAL_PATHSPECS: '1' });
  const commands = () => (mode === 'async' ? doubles.spawn : doubles.spawnSync).mock.calls.map(([, args]) => args as string[]);
  const expectMergeAttempt = () => expect(commands()).toContainEqual(expect.arrayContaining([
    'merge-tree', '--write-tree', targetSha, sourceSha,
  ]));

  it.each([40, 64])('compares the first merge output line with the target tree for a %i-digit OID', async (length) => {
    const tree = 'd'.repeat(length);
    contentGit({ output: `${tree}\ninformation\n`, code: 0 }, tree);

    expect(await include()).toBe(true);
    const mergeArgs = commands().find((args) => args.includes('merge-tree'))!;
    expect(mergeArgs.slice(mergeArgs.indexOf('merge-tree'))).toEqual(['merge-tree', '--write-tree', targetSha, sourceSha]);
    expect(commands().some((args) => args.includes('rev-parse') && args.includes(`${targetSha}^{tree}`))).toBe(true);
  });

  it('returns false when the clean merge produces a different tree', async () => {
    contentGit({ output: `${'d'.repeat(40)}\n`, code: 0 }, 'e'.repeat(40));
    expect(await include()).toBe(false);
    expectMergeAttempt();
  });

  it('returns false without throwing when the three-way merge conflicts', async () => {
    contentGit({ output: `${'d'.repeat(40)}\nCONFLICT (content): src/a.ts\n`, code: 1 }, 'd'.repeat(40));
    expect(await include()).toBe(false);
    expectMergeAttempt();
  });

  it.each([2, 128])('propagates merge exit code %i instead of reporting non-inclusion', async (code) => {
    contentGit({ output: `${'d'.repeat(40)}\n`, code }, 'd'.repeat(40));
    await expect(include()).rejects.toThrow();
    expectMergeAttempt();
  });

  it.each([
    { name: 'empty output', output: '' },
    { name: 'empty first line', output: `\n${'d'.repeat(40)}\n` },
    { name: 'diagnostic before a valid OID', output: `information\n${'d'.repeat(40)}\n` },
    { name: 'non-hexadecimal characters', output: `${'g'.repeat(40)}\n` },
    ...[39, 41, 63, 65].map((length) => ({ name: `${length}-digit OID`, output: `${'d'.repeat(length)}\n` })),
  ])('rejects $name instead of searching later lines', async ({ output }) => {
    contentGit({ output, code: 0 }, 'd'.repeat(40));
    await expect(include()).rejects.toThrow();
    expectMergeAttempt();
  });

  it('rejects an invalid target tree OID', async () => {
    contentGit({ output: `${'d'.repeat(40)}\n`, code: 0 }, 'invalid-tree');
    await expect(include()).rejects.toThrow();
    expectMergeAttempt();
  });

  it('rejects conflict output without a valid tree OID', async () => {
    contentGit({ output: 'CONFLICT (content): src/a.ts\n', code: 1 }, 'd'.repeat(40));
    await expect(include()).rejects.toThrow();
    expectMergeAttempt();
  });
});

it.each([
  { name: 'a matching tree', output: `${'d'.repeat(40)}\n`, code: 0, included: true },
  { name: 'a different tree', output: `${'e'.repeat(40)}\n`, code: 0, included: false },
  { name: 'a conflict', output: `${'d'.repeat(40)}\nCONFLICT\n`, code: 1, included: false },
])('saves completion only for included content with $name', async ({ output, code, included }) => {
  contentGit({ output, code }, 'd'.repeat(40));
  const before = structuredClone(goal);

  expect(await checkGoalCompletion('/project', goal.id, undefined, policy)).toMatchObject({ included });
  if (included) {
    expect(goal).toMatchObject({ status: 'completed', completion: { goalSha: sourceSha, targetSha } });
  } else {
    expect(goal).toEqual(before);
    expect(doubles.update).not.toHaveBeenCalled();
  }
});

it.each([
  { name: 'a merge failure', output: '', code: 128 },
  { name: 'a diagnostic before the OID', output: `information\n${'d'.repeat(40)}\n`, code: 0 },
  { name: 'truncated merge output', output: `${'d'.repeat(40)}\n${'x'.repeat(8 * 1024 * 1024)}`, code: 0 },
])('does not save completion after $name', async ({ output, code }) => {
  contentGit({ output, code }, 'd'.repeat(40));
  const before = structuredClone(goal);

  await expect(checkGoalCompletion('/project', goal.id, undefined, policy)).rejects.toThrow();
  expect(goal).toEqual(before);
  expect(doubles.update).not.toHaveBeenCalled();
  expect(doubles.spawn.mock.calls.some(([, args]) => args.includes('merge-tree'))).toBe(true);
});
