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
    vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
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
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
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
