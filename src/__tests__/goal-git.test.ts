import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoalBranch, prepareGoalBranch, removeGoalBranch } from '../infra/goals/git.js';
import type { GoalGitOutput } from '../infra/goals/git-command.js';
import { goalId } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ exec: vi.fn(), detect: vi.fn(), config: vi.fn(), fetch: vi.fn(), run: vi.fn(), info: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: doubles.exec }));
vi.mock('../infra/task/branchList.js', () => ({ detectDefaultBranch: doubles.detect }));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: doubles.config }));
vi.mock('../infra/goals/git-command.js', () => ({ goalGitText: doubles.fetch, runGoalGit: doubles.run }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ info: doubles.info }) }));

describe('Goal Git registration', () => {
  const localCommit = 'a'.repeat(40);
  const remoteCommit = 'b'.repeat(40);
  let references: Map<string, string>;
  let commits: Map<string, string>;

  function gitResult(_command: string, args: string[]): string {
    if (args[0] === 'rev-parse') {
      const commit = commits.get(args[2]!);
      if (commit === undefined) throw new Error(`Missing commit: ${args[2]}`);
      return commit;
    }
    if (args[0] === 'update-ref') return '';
    throw new Error(`Unexpected Git command: ${args.join(' ')}`);
  }

  async function referenceResult(_cwd: string, args: readonly string[], limit: number): Promise<GoalGitOutput> {
    const refs = (references.get(args.at(-1)!) ?? '').split('\n').filter(Boolean).sort();
    const selected = args.includes('--count=1') ? refs.slice(0, 1) : refs;
    const output = Buffer.from(selected.map((ref) => `${ref}\n`).join(''));
    return { output: output.subarray(0, limit), truncated: output.length > limit, code: 0 };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    references = new Map(['main', 'release', 'develop'].map((branch) => [`refs/heads/${branch}`, `refs/heads/${branch}\n`]));
    commits = new Map(['main', 'release', 'develop'].map((branch) => [`refs/heads/${branch}^{commit}`, localCommit]));
    doubles.detect.mockReturnValue('main');
    doubles.fetch.mockResolvedValue('');
    doubles.run.mockImplementation(referenceResult);
    doubles.exec.mockImplementation(gitResult);
  });

  it('resolves the default local branch commit and integration branch when origin has no matching reference', async () => {
    expect(await prepareGoalBranch('/project', goalId, undefined, undefined)).toMatchObject({
      startBranch: 'main', integrationBranch: 'main', commit: localCommit,
      branch: expect.stringMatching(/^takt\/\d{8}T\d{4}-goal-550e8400$/),
    });
    expect(doubles.exec).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], expect.any(Object));
  });

  it('waits for one fetch through goalGitText before resolving references and creating the branch', async () => {
    let finishFetch!: (output: string) => void;
    doubles.fetch.mockReturnValue(new Promise<string>((resolve) => { finishFetch = resolve; }));
    const prepared = prepareGoalBranch('/project', goalId, undefined, undefined);
    try {
      expect(doubles.fetch).toHaveBeenCalledExactlyOnceWith('/project', ['fetch', 'origin'], expect.any(AbortSignal));
      expect(doubles.exec).not.toHaveBeenCalled();
      expect(doubles.run).not.toHaveBeenCalled();
    } finally {
      finishFetch('');
      await prepared;
    }
    const result = await prepared;
    createGoalBranch('/project', result.branch, result.commit);
    expect(doubles.fetch).toHaveBeenCalledTimes(1);
    expect(doubles.exec.mock.calls.some(([, args]) => args[0] === 'fetch')).toBe(false);
    expect(doubles.exec).toHaveBeenLastCalledWith('git', ['update-ref', `refs/heads/${result.branch}`, localCommit, ''], expect.any(Object));
  });

  it('prefers the exact origin reference over an older local branch', async () => {
    references.set('refs/remotes/origin/main', 'refs/remotes/origin/main\n');
    commits.set('refs/remotes/origin/main^{commit}', remoteCommit);
    expect(await prepareGoalBranch('/project', goalId, undefined, undefined)).toMatchObject({ commit: remoteCommit });
    expect(doubles.run).toHaveBeenCalledExactlyOnceWith('/project', ['for-each-ref', '--format=%(refname)', '--count=1', 'refs/remotes/origin/main'], Buffer.byteLength('refs/remotes/origin/main\n'), undefined);
    expect(doubles.exec).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], expect.any(Object));
    expect(doubles.exec).not.toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], expect.any(Object));
  });

  it('does not mistake origin child references for the default branch', async () => {
    references.set('refs/remotes/origin/main', 'refs/remotes/origin/main/feature\nrefs/remotes/origin/main/fix\n');
    commits.set('refs/remotes/origin/main^{commit}', remoteCommit);
    expect(await prepareGoalBranch('/project', goalId, undefined, undefined)).toMatchObject({ commit: localCommit });
    expect(doubles.exec).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], expect.any(Object));
    expect(doubles.exec).not.toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], expect.any(Object));
  });

  it.each(['refs/remotes/origin/main', 'refs/heads/main'])('excludes a truncated long child of %s from exact matches', async (ref) => {
    references.set(ref, `${ref}/${'x'.repeat(1024 * 1024 + 1)}\n`);

    if (ref === 'refs/remotes/origin/main') {
      expect(await prepareGoalBranch('/project', goalId, undefined, undefined)).toMatchObject({ commit: localCommit });
    } else {
      await expect(prepareGoalBranch('/project', goalId, undefined, undefined)).rejects.toThrow();
      expect(doubles.exec).toHaveBeenLastCalledWith('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], expect.any(Object));
    }
    expect(doubles.run).toHaveBeenCalledWith('/project', ['for-each-ref', '--format=%(refname)', '--count=1', ref], Buffer.byteLength(`${ref}\n`), undefined);
  });

  it('retains the complete UTF-8 reference and newline for an exact match', async () => {
    const ref = 'refs/remotes/origin/開発';
    doubles.detect.mockReturnValue('開発');
    references.set(ref, `${ref}\n`);
    commits.set(`${ref}^{commit}`, remoteCommit);

    expect(await prepareGoalBranch('/project', goalId, undefined, undefined)).toMatchObject({ commit: remoteCommit });
    expect(doubles.run).toHaveBeenCalledExactlyOnceWith('/project', ['for-each-ref', '--format=%(refname)', '--count=1', ref], Buffer.byteLength(`${ref}\n`), undefined);
  });

  it('waits for the reference query before verifying the selected commit', async () => {
    let finishQuery!: (result: GoalGitOutput) => void;
    doubles.run.mockReturnValueOnce(new Promise<GoalGitOutput>((resolve) => { finishQuery = resolve; }));
    const prepared = prepareGoalBranch('/project', goalId, undefined, undefined);
    try {
      await vi.waitFor(() => expect(doubles.run).toHaveBeenCalledOnce());
      expect(doubles.exec).not.toHaveBeenCalled();
    } finally {
      finishQuery({ output: Buffer.alloc(0), truncated: false, code: 0 });
      await prepared;
    }
    expect(await prepared).toMatchObject({ commit: localCommit });
  });

  it.each(['reject', 'throw'] as const)('logs a fetch %s and still creates the goal branch from the local commit', async (failure) => {
    const error = new Error('origin unavailable');
    if (failure === 'reject') doubles.fetch.mockRejectedValue(error);
    else doubles.fetch.mockImplementation(() => { throw error; });
    const prepared = await prepareGoalBranch('/project', goalId, undefined, undefined);
    createGoalBranch('/project', prepared.branch, prepared.commit);
    expect(prepared.commit).toBe(localCommit);
    expect(doubles.fetch).toHaveBeenCalledExactlyOnceWith('/project', ['fetch', 'origin'], expect.any(AbortSignal));
    expect(doubles.info).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: String(error) }));
    expect(doubles.exec).toHaveBeenLastCalledWith('git', ['update-ref', `refs/heads/${prepared.branch}`, localCommit, ''], expect.any(Object));
  });

  it('prefers the local commit when a failed fetch leaves an exact remote tracking reference', async () => {
    doubles.fetch.mockRejectedValue(new Error('offline'));
    references.set('refs/remotes/origin/main', 'refs/remotes/origin/main\n');
    commits.set('refs/remotes/origin/main^{commit}', remoteCommit);
    const prepared = await prepareGoalBranch('/project', goalId, undefined, undefined);
    createGoalBranch('/project', prepared.branch, prepared.commit);
    expect(prepared.commit).toBe(localCommit);
    expect(doubles.exec).toHaveBeenLastCalledWith('git', ['update-ref', `refs/heads/${prepared.branch}`, localCommit, ''], expect.any(Object));
  });

  it('uses the remote tracking commit after a failed fetch when the local branch is absent', async () => {
    doubles.fetch.mockRejectedValue(new Error('offline'));
    references.delete('refs/heads/main');
    commits.delete('refs/heads/main^{commit}');
    references.set('refs/remotes/origin/main', 'refs/remotes/origin/main\n');
    commits.set('refs/remotes/origin/main^{commit}', remoteCommit);
    const prepared = await prepareGoalBranch('/project', goalId, undefined, undefined);
    createGoalBranch('/project', prepared.branch, prepared.commit);
    expect(prepared.commit).toBe(remoteCommit);
    expect(doubles.exec).toHaveBeenLastCalledWith('git', ['update-ref', `refs/heads/${prepared.branch}`, remoteCommit, ''], expect.any(Object));
  });

  it('bounds fetch to 30 seconds and logs a timeout before creating the branch from the local commit', async () => {
    const controller = new AbortController();
    const error = new DOMException('fetch timed out', 'TimeoutError');
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    references.set('refs/remotes/origin/main', 'refs/remotes/origin/main\n');
    commits.set('refs/remotes/origin/main^{commit}', remoteCommit);
    doubles.fetch.mockImplementation((_cwd: string, _args: readonly string[], signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
    try {
      const pending = prepareGoalBranch('/project', goalId, undefined, undefined);
      controller.abort(error);
      const prepared = await pending;
      createGoalBranch('/project', prepared.branch, prepared.commit);
      expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
      expect(doubles.fetch).toHaveBeenCalledExactlyOnceWith('/project', ['fetch', 'origin'], controller.signal);
      expect(doubles.info).toHaveBeenCalledWith('Failed to fetch from remote, continuing with local state', {
        startBranch: 'main', error: String(error),
      });
      expect(prepared.commit).toBe(localCommit);
      expect(doubles.run).toHaveBeenCalledExactlyOnceWith('/project', ['for-each-ref', '--format=%(refname)', '--count=1', 'refs/heads/main'], Buffer.byteLength('refs/heads/main\n'), undefined);
      expect(doubles.exec).toHaveBeenLastCalledWith('git', ['update-ref', `refs/heads/${prepared.branch}`, localCommit, ''], expect.any(Object));
    } finally {
      timeout.mockRestore();
    }
  });

  it('uses explicit branches without detecting a default', async () => {
    doubles.config.mockReturnValue('configured');
    references.set('refs/remotes/origin/release', 'refs/remotes/origin/release\n');
    commits.set('refs/remotes/origin/release^{commit}', remoteCommit);
    expect(await prepareGoalBranch('/project', goalId, 'release', 'develop')).toMatchObject({
      startBranch: 'release', integrationBranch: 'develop', commit: localCommit,
    });
    expect(doubles.detect).not.toHaveBeenCalled();
    expect(doubles.config).not.toHaveBeenCalled();
    expect(doubles.fetch).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
    expect(doubles.exec.mock.calls.map((call) => call[1])).toEqual([
      ['rev-parse', '--verify', 'refs/heads/release^{commit}'],
      ['rev-parse', '--verify', 'refs/heads/develop^{commit}'],
    ]);
  });

  it('propagates caller cancellation during fetch instead of continuing from local state', async () => {
    const controller = new AbortController();
    const abort = new Error('cancel registration');
    doubles.fetch.mockImplementation(async (_cwd: string, _args: string[], signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      controller.abort(abort);
      expect(signal.aborted).toBe(true);
      throw abort;
    });
    await expect(prepareGoalBranch('/project', goalId, undefined, undefined, controller.signal)).rejects.toBe(abort);
    expect(doubles.run).not.toHaveBeenCalled();
    expect(doubles.exec).not.toHaveBeenCalled();
    expect(doubles.info).not.toHaveBeenCalled();
  });

  it('passes cancellation to the reference query and stops before commit verification after cancellation', async () => {
    const controller = new AbortController();
    doubles.run.mockImplementationOnce(async (_cwd, _args, _limit, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return { output: Buffer.alloc(0), truncated: false, code: 0 };
    });
    await expect(prepareGoalBranch('/project', goalId, undefined, undefined, controller.signal)).rejects.toThrow();
    expect(doubles.exec).not.toHaveBeenCalled();
  });

  it('uses the configured base branch as the default start and integration branch at registration', async () => {
    doubles.config.mockReturnValue('release');
    expect(await prepareGoalBranch('/project', goalId, undefined, undefined)).toMatchObject({
      startBranch: 'release', integrationBranch: 'release', commit: localCommit,
    });
    expect(doubles.config).toHaveBeenCalledWith('/project', 'baseBranch');
    expect(doubles.detect).not.toHaveBeenCalled();
    expect(doubles.exec).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/heads/release^{commit}'], expect.any(Object));
  });

  it('uses the integration branch as the default start ahead of configuration and repository defaults', async () => {
    doubles.config.mockReturnValue('configured');
    expect(await prepareGoalBranch('/project', goalId, undefined, 'develop')).toMatchObject({
      startBranch: 'develop', integrationBranch: 'develop', commit: localCommit,
    });
    expect(doubles.config).not.toHaveBeenCalled();
    expect(doubles.detect).not.toHaveBeenCalled();
    expect(doubles.exec).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/heads/develop^{commit}'], expect.any(Object));
  });

  it('rejects a configured integration branch without a local commit', async () => {
    doubles.config.mockReturnValue('missing');
    references.set('refs/remotes/origin/missing', 'refs/remotes/origin/missing\n');
    commits.set('refs/remotes/origin/missing^{commit}', remoteCommit);
    await expect(Promise.resolve().then(() => prepareGoalBranch('/project', goalId, undefined, undefined))).rejects.toThrow();
    expect(doubles.exec).toHaveBeenLastCalledWith('git', ['rev-parse', '--verify', 'refs/heads/missing^{commit}'], expect.any(Object));
  });

  it.each([1, 5000])('does not mistake %i child references for the default local branch', async (childCount) => {
    references.set('refs/heads/main', Array.from({ length: childCount }, (_, index) =>
      `refs/heads/main/feature-${String(index).padStart(5, '0')}-${'x'.repeat(190)}\n`).join(''));
    const error = new Error('missing remote commit');
    doubles.exec.mockImplementation((command: string, args: string[]) => {
      if (args[2] === 'refs/remotes/origin/main^{commit}') throw error;
      return gitResult(command, args);
    });
    await expect(Promise.resolve().then(() => prepareGoalBranch('/project', goalId, undefined, undefined))).rejects.toThrow(error);
    expect(doubles.run).toHaveBeenCalledWith('/project', ['for-each-ref', '--format=%(refname)', '--count=1', 'refs/heads/main'], Buffer.byteLength('refs/heads/main\n'), undefined);
    expect(doubles.exec).toHaveBeenLastCalledWith('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], expect.any(Object));
    expect(doubles.exec).not.toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], expect.any(Object));
  });

  it.each(['refs/remotes/origin/main', 'refs/heads/main'])('propagates reference enumeration errors for %s instead of treating the branch as absent', async (ref) => {
    const error = new Error('Git reference enumeration failed');
    doubles.run.mockImplementation(async (cwd: string, args: readonly string[], limit: number) => {
      if (args.at(-1) === ref) throw error;
      return referenceResult(cwd, args, limit);
    });
    await expect(Promise.resolve().then(() => prepareGoalBranch('/project', goalId, undefined, undefined))).rejects.toThrow(error);
    expect(doubles.run).toHaveBeenLastCalledWith('/project', ['for-each-ref', '--format=%(refname)', '--count=1', ref], Buffer.byteLength(`${ref}\n`), undefined);
    expect(doubles.run).toHaveBeenCalledTimes(ref === 'refs/remotes/origin/main' ? 1 : 2);
    expect(doubles.exec.mock.calls.some(([, args]) => args[0] === 'rev-parse')).toBe(false);
  });

  it.each(['local', 'origin'] as const)('propagates an invalid %s commit instead of switching branches', async (source) => {
    const error = new Error('Git commit verification failed');
    const ref = source === 'local' ? 'refs/heads/main' : 'refs/remotes/origin/main';
    if (source === 'origin') references.set(ref, `${ref}\n`);
    doubles.exec.mockImplementation((command: string, args: string[]) => {
      if (args[2] === `${ref}^{commit}`) throw error;
      return gitResult(command, args);
    });
    await expect(Promise.resolve().then(() => prepareGoalBranch('/project', goalId, undefined, undefined))).rejects.toThrow(error);
    expect(doubles.exec).toHaveBeenLastCalledWith('git', ['rev-parse', '--verify', `${ref}^{commit}`], expect.any(Object));
    expect(doubles.exec.mock.calls.filter(([, args]) => args[0] === 'rev-parse')).toHaveLength(1);
  });

  it('creates an absent reference and deletes only the expected commit', () => {
    createGoalBranch('/project', 'takt/goal', localCommit);
    removeGoalBranch('/project', 'takt/goal', localCommit);
    expect(doubles.exec.mock.calls.map((call) => call[1])).toEqual([
      ['update-ref', 'refs/heads/takt/goal', localCommit, ''],
      ['update-ref', '-d', 'refs/heads/takt/goal', localCommit],
    ]);
  });

  it.each([
    { start: '--force', integration: undefined },
    { start: 'main', integration: '--force' },
    { start: undefined, integration: '--force' },
  ])('rejects option-shaped branch input before executing Git: $start / $integration', async ({ start, integration }) => {
    await expect(Promise.resolve().then(() => prepareGoalBranch('/project', goalId, start, integration))).rejects.toThrow();
    expect(doubles.exec).not.toHaveBeenCalled();
    expect(doubles.fetch).not.toHaveBeenCalled();
    expect(doubles.run).not.toHaveBeenCalled();
  });
});
