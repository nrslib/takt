import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGoal } from '../infra/goals/service.js';
import { GoalStore } from '../infra/goals/store.js';
import { goalId, goalInput } from './helpers/goal-fixtures.js';

describe('Goal Git registration with saved branches and real commits', () => {
  let root: string;
  let cwd: string;
  let commits: Record<string, string>;

  function git(args: string[], input?: string): string {
    return execFileSync('git', args, {
      cwd, input, encoding: 'utf8', stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Goal Test', GIT_AUTHOR_EMAIL: 'goal@example.test',
        GIT_COMMITTER_NAME: 'Goal Test', GIT_COMMITTER_EMAIL: 'goal@example.test',
        GIT_AUTHOR_DATE: '2026-10-04T14:43:00Z', GIT_COMMITTER_DATE: '2026-10-04T14:43:00Z',
      },
    }).trim();
  }

  function configureBaseBranch(branch: string | undefined): void {
    writeFileSync(join(cwd, '.takt', 'config.yaml'), branch === undefined ? '{}\n' : `base_branch: ${branch}\n`);
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-git-')));
    cwd = join(root, 'project');
    mkdirSync(cwd);
    mkdirSync(join(cwd, '.takt'));
    vi.stubEnv('TAKT_BASE_BRANCH', undefined);
    git(['init', '--initial-branch=main']);
    const tree = git(['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    const main = git(['commit-tree', tree, '-m', 'main fixture']);
    commits = { main };
    for (const branch of ['feat/manager', 'release', 'feature/start']) {
      commits[branch] = git(['commit-tree', tree, '-p', main, '-m', `${branch} fixture`]);
    }
    for (const [branch, commit] of Object.entries(commits)) {
      git(['update-ref', `refs/heads/${branch}`, commit]);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches the origin tip before creating the saved goal branch from an older local default', async () => {
    configureBaseBranch(undefined);
    const origin = join(root, 'origin.git');
    git(['init', '--bare', '--initial-branch=main', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', 'origin', 'main']);
    const originTip = commits['release']!;
    git(['push', 'origin', `${originTip}:refs/heads/main`]);
    git(['update-ref', 'refs/remotes/origin/main', commits.main!]);
    expect(git(['rev-parse', 'refs/heads/main'])).toBe(commits.main);
    expect(git(['rev-parse', 'refs/remotes/origin/main'])).toBe(commits.main);
    expect(git(['--git-dir', origin, 'rev-parse', 'refs/heads/main'])).toBe(originTip);

    await createGoal({ cwd, id: goalId, ...goalInput() });

    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved).toMatchObject({ startBranch: 'main', integrationBranch: 'main' });
    expect(git(['rev-parse', '--verify', `refs/heads/${saved.branch}^{commit}`])).toBe(originTip);
    expect(git(['rev-parse', 'refs/remotes/origin/main'])).toBe(originTip);
    expect(git(['rev-parse', 'refs/heads/main'])).toBe(commits.main);
  });

  it('registers from the local default when origin has no matching branch', async () => {
    configureBaseBranch(undefined);
    const origin = join(root, 'origin.git');
    git(['init', '--bare', '--initial-branch=other', origin]);
    git(['remote', 'add', 'origin', origin]);
    git(['push', 'origin', 'release:refs/heads/other']);

    await createGoal({ cwd, id: goalId, ...goalInput() });

    const saved = await new GoalStore(cwd).get(goalId);
    expect(git(['rev-parse', '--verify', `refs/heads/${saved.branch}^{commit}`])).toBe(commits.main);
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/main'])).toBe('');
  });

  it('registers from the local default when fetching origin fails', async () => {
    configureBaseBranch(undefined);
    git(['remote', 'add', 'origin', join(root, 'unreachable.git')]);
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/main'])).toBe('');

    await createGoal({ cwd, id: goalId, ...goalInput() });

    const saved = await new GoalStore(cwd).get(goalId);
    expect(git(['rev-parse', '--verify', `refs/heads/${saved.branch}^{commit}`])).toBe(commits.main);
  });

  it.each([16, 1024 * 1024 + 1])('registers from the local default with one %i-byte origin child name after a failed fetch', async (childLength) => {
    configureBaseBranch(undefined);
    git(['remote', 'add', 'origin', join(root, 'unreachable.git')]);
    const prefix = 'refs/remotes/origin/main';
    const childRef = `${prefix}/${'x'.repeat(childLength)}`;
    writeFileSync(join(cwd, '.git', 'packed-refs'), `${commits.release!} ${childRef}\n`);
    // fixture の照会が正常終了することと出力量を、本番の保持上限とは別に確認する。
    const output = execFileSync('git', ['for-each-ref', '--format=%(refname)', '--count=1', prefix], {
      cwd, maxBuffer: 2 * 1024 * 1024,
    });
    expect(output.equals(Buffer.from(`${childRef}\n`))).toBe(true);
    expect(output.length).toBe(Buffer.byteLength(childRef) + 1);
    if (childLength > 1024 * 1024) expect(output.length).toBeGreaterThan(1024 * 1024);

    await createGoal({ cwd, id: goalId, ...goalInput() });

    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved).toMatchObject({ startBranch: 'main', integrationBranch: 'main' });
    expect(git(['rev-parse', '--verify', `refs/heads/${saved.branch}^{commit}`])).toBe(commits.main);
  });

  it.each([
    { fetch: 'succeeds', childCount: 2 },
    { fetch: 'succeeds', childCount: 5000 },
    { fetch: 'fails', childCount: 2 },
    { fetch: 'fails', childCount: 5000 },
  ])('registers from the local default with $childCount origin child references when fetch $fetch', async ({ fetch, childCount }) => {
    configureBaseBranch(undefined);
    const origin = join(root, 'origin.git');
    git(['remote', 'add', 'origin', origin]);
    const sourceArgs = fetch === 'succeeds' ? ['--git-dir', origin] : [];
    const prefix = fetch === 'succeeds' ? 'refs/heads/main' : 'refs/remotes/origin/main';
    if (fetch === 'succeeds') {
      git(['init', '--bare', '--initial-branch=other', origin]);
      git(['push', 'origin', 'release:refs/heads/other']);
    }
    const childRefs = Array.from({ length: childCount }, (_, index) =>
      `${prefix}/feature-${String(index).padStart(5, '0')}-${'x'.repeat(190)}`);
    git([...sourceArgs, 'update-ref', '--stdin'], childRefs.map((ref) => `create ${ref} ${commits.release!}\n`).join(''));
    git([...sourceArgs, 'pack-refs', '--all']);
    // 全件出力量の計測だけに容量を与え、本番の上限は変更しない。
    const output = execFileSync('git', [...sourceArgs, 'for-each-ref', '--format=%(refname)', prefix], {
      cwd, maxBuffer: 2 * 1024 * 1024,
    });
    expect(output.toString('utf8').trim().split('\n')).toEqual(childRefs);
    if (childCount === 5000) expect(output.length).toBeGreaterThan(1024 * 1024);
    else expect(output.length).toBeLessThan(1024 * 1024);

    await createGoal({ cwd, id: goalId, ...goalInput() });

    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved).toMatchObject({ startBranch: 'main', integrationBranch: 'main' });
    expect(git(['rev-parse', '--verify', `refs/heads/${saved.branch}^{commit}`])).toBe(commits.main);
    expect(git(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/origin/main']))
      .toBe(childRefs[0]!.replace('refs/heads/', 'refs/remotes/origin/'));
  });

  it('rejects a local child reference without saving a goal or creating its branch', async () => {
    configureBaseBranch(undefined);
    git(['symbolic-ref', 'HEAD', 'refs/heads/feature/start']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    git(['update-ref', '-d', 'refs/heads/main']);
    git(['update-ref', 'refs/heads/main/feature', commits.main!]);
    const refsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)']);

    await expect(createGoal({ cwd, id: goalId, ...goalInput() })).rejects.toThrow();

    expect(await new GoalStore(cwd).list()).toEqual({ goals: [], errors: [] });
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore);
  });

  it('creates the saved branch with the existing timestamp and goal ID format', async () => {
    configureBaseBranch(undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T12:04:00Z'));

    await createGoal({ cwd, id: goalId, ...goalInput() });

    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved.branch).toBe('takt/20261018T1204-goal-550e8400');
    expect(git(['rev-parse', '--verify', `refs/heads/${saved.branch}^{commit}`])).toBe(commits.main);
  });

  it('preserves an existing goal branch when the generated name collides', async () => {
    configureBaseBranch(undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T12:04:00Z'));
    const branchRef = 'refs/heads/takt/20261018T1204-goal-550e8400';
    git(['update-ref', branchRef, commits.release!]);

    await expect(createGoal({ cwd, id: goalId, ...goalInput() })).rejects.toThrow();

    expect(git(['rev-parse', '--verify', `${branchRef}^{commit}`])).toBe(commits.release);
    expect(await new GoalStore(cwd).list()).toEqual({ goals: [], errors: [] });
  });

  it.each([
    { name: 'integration branch without a start branch', baseBranch: 'release', startBranch: undefined,
      integrationBranch: 'feat/manager', expectedStart: 'feat/manager', expectedIntegration: 'feat/manager' },
    { name: 'configured base branch without summary branches', baseBranch: 'feat/manager', startBranch: undefined,
      integrationBranch: undefined, expectedStart: 'feat/manager', expectedIntegration: 'feat/manager' },
    { name: 'repository default without summary branches or configuration', baseBranch: undefined, startBranch: undefined,
      integrationBranch: undefined, expectedStart: 'main', expectedIntegration: 'main' },
    { name: 'explicit start with an integration branch and configuration', baseBranch: 'release', startBranch: 'feature/start',
      integrationBranch: 'feat/manager', expectedStart: 'feature/start', expectedIntegration: 'feat/manager' },
    { name: 'explicit start with only configuration', baseBranch: 'release', startBranch: 'feature/start',
      integrationBranch: undefined, expectedStart: 'feature/start', expectedIntegration: 'release' },
    { name: 'explicit start without an integration branch or configuration', baseBranch: undefined, startBranch: 'feature/start',
      integrationBranch: undefined, expectedStart: 'feature/start', expectedIntegration: 'feature/start' },
  ])('saves branch names and creates the goal at the selected commit: $name', async (scenario) => {
    configureBaseBranch(scenario.baseBranch);
    const input = { cwd, id: goalId, ...goalInput(),
      startBranch: scenario.startBranch, integrationBranch: scenario.integrationBranch };

    await createGoal(input);

    const saved = await new GoalStore(cwd).get(goalId);
    const actual = {
      startBranch: saved.startBranch, integrationBranch: saved.integrationBranch,
      commit: git(['rev-parse', '--verify', `refs/heads/${saved.branch}^{commit}`]),
    };
    expect(actual, JSON.stringify({ input, baseBranch: scenario.baseBranch, commits, actual })).toEqual({
      startBranch: scenario.expectedStart, integrationBranch: scenario.expectedIntegration,
      commit: commits[scenario.expectedStart],
    });
  });

  it('registers from remote tracking when the default branch has no local reference', async () => {
    configureBaseBranch(undefined);
    git(['symbolic-ref', 'HEAD', 'refs/heads/feature/start']);
    git(['update-ref', 'refs/remotes/origin/main', commits.main!]);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    git(['update-ref', '-d', 'refs/heads/main']);

    await createGoal({ cwd, id: goalId, ...goalInput() });

    const saved = await new GoalStore(cwd).get(goalId);
    expect(saved).toMatchObject({ startBranch: 'main', integrationBranch: 'main' });
    expect(git(['rev-parse', '--verify', `refs/heads/${saved.branch}^{commit}`])).toBe(commits.main);
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/main'])).toBe('');
  });

  it.each([
    { name: 'summary integration branch', startBranch: undefined, integrationBranch: 'missing', baseBranch: 'release' },
    { name: 'configured base branch', startBranch: undefined, integrationBranch: undefined, baseBranch: 'missing' },
    { name: 'explicit start with only a remote tracking reference', startBranch: 'missing', integrationBranch: undefined,
      baseBranch: undefined },
  ])('rejects a missing local start before creating a goal record or branch: $name', async (scenario) => {
    configureBaseBranch(scenario.baseBranch);
    if (scenario.startBranch !== undefined) {
      git(['update-ref', 'refs/remotes/origin/missing', commits.main!]);
    }
    const refsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)']);

    await expect(createGoal({ cwd, id: goalId, ...goalInput(),
      startBranch: scenario.startBranch, integrationBranch: scenario.integrationBranch,
    })).rejects.toThrow(/rev-parse --verify refs\/(?:heads|remotes\/origin)\/missing\^\{commit\}/);

    expect(existsSync(join(cwd, '.takt', 'goals', goalId, 'goal.json'))).toBe(false);
    expect(await new GoalStore(cwd).list()).toEqual({ goals: [], errors: [] });
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore);
  });
});
