import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkGoalCompletion, completeGoal, reopenGoal } from '../infra/goals/integration.js';
import { isGoalCommitIncluded, isGoalContentIncluded, isGoalContentIncludedSync } from '../infra/goals/git-command.js';
import { buildSafeGitEnvironment } from '../infra/task/git-environment.js';
import { GoalStore } from '../infra/goals/store.js';
import type { Goal } from '../infra/goals/schema.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const policy = { question: true, awaiting_merge: true, completed: true, progress: true, blocked: true, custom: true };
let cwd: string;
let store: GoalStore;
let goal: Goal;
let baseSha: string;
let sourceSha: string;
let firstSha: string;

const baseContent = Array.from({ length: 30 }, (_, index) => `export const value${index} = 0;\n`).join('');
const goalContent = baseContent.replace('value1 = 0', 'value1 = 1');
const advancedContent = goalContent.replace('value25 = 0', 'value25 = 2');

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'merge.gpgSign=false', ...args], {
    cwd, encoding: 'utf8', stdio: 'pipe', timeout: 10_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Goal Test', GIT_AUTHOR_EMAIL: 'goal@example.test',
      GIT_COMMITTER_NAME: 'Goal Test', GIT_COMMITTER_EMAIL: 'goal@example.test',
      GIT_AUTHOR_DATE: '2026-10-19T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-19T00:00:00Z',
    },
  }).trim();
}

function commitFiles(files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(cwd, path), content);
  git(['add', '--', ...Object.keys(files)]);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

function squash(): string {
  git(['merge', '--squash', goal.branch]);
  git(['commit', '-m', 'squash goal work']);
  return git(['rev-parse', 'HEAD']);
}

beforeEach(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-content-')));
  git(['init', '--initial-branch=main']);
  mkdirSync(join(cwd, 'src'));
  baseSha = commitFiles({ 'src/a.ts': baseContent, 'second.txt': 'base second\n' }, 'base');
  goal = { ...goalRecord(), status: 'awaiting_merge' };
  git(['switch', '--create', goal.branch]);
  firstSha = commitFiles({ 'src/a.ts': goalContent }, 'first goal change');
  sourceSha = commitFiles({ 'second.txt': 'goal second\n' }, 'second goal change');
  git(['switch', 'main']);
  goal = { ...goal, completion: {
    goalBranch: goal.branch, goalSha: sourceSha, targetBranch: 'main', summary: 'evidence', instructions: [],
    changeSummary: { filesChanged: 2, additions: 2, deletions: 2, files: [], truncated: false, totalsTruncated: false },
  } };
  store = new GoalStore(cwd);
  await store.create(goal);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

const histories = [
  { name: 'ordinary merge', included: true, ancestor: true },
  { name: 'squash merge', included: true, ancestor: false },
  { name: 'squash followed by unrelated work', included: true, ancestor: false },
  // SCN-INCLUDE-P1
  { name: 'squash followed by same-file work', included: true, ancestor: false },
  // SCN-INCLUDE-N2
  { name: 'conflicting work', included: false, ancestor: false },
  { name: 'partial inclusion', included: false, ancestor: false },
  { name: 'reverted squash', included: false, ancestor: false },
  // SCN-INCLUDE-N1
  { name: 'no inclusion', included: false, ancestor: false },
  { name: 'reverted ordinary merge', included: true, ancestor: true },
  { name: 'cherry-picked work', included: true, ancestor: false },
  { name: 'rebased work', included: true, ancestor: false },
] as const;

function prepareHistory(name: typeof histories[number]['name']): string {
  switch (name) {
    case 'ordinary merge':
    case 'reverted ordinary merge': {
      git(['merge', '--no-ff', '--no-edit', goal.branch]);
      if (name === 'reverted ordinary merge') git(['revert', '--no-edit', '-m', '1', 'HEAD']);
      break;
    }
    case 'squash merge': squash(); break;
    case 'squash followed by unrelated work':
      squash();
      commitFiles({ 'unrelated.txt': 'target-only change\n' }, 'target advances');
      break;
    case 'squash followed by same-file work':
      squash();
      commitFiles({ 'src/a.ts': advancedContent }, 'target advances in the same file');
      break;
    case 'conflicting work':
      commitFiles({ 'src/a.ts': baseContent.replace('value1 = 0', 'value1 = 3') }, 'conflicting target work');
      break;
    case 'partial inclusion':
      commitFiles({ 'src/a.ts': goalContent }, 'only the first change');
      break;
    case 'reverted squash':
      squash();
      git(['revert', '--no-edit', 'HEAD']);
      break;
    case 'no inclusion': break;
    case 'cherry-picked work':
      commitFiles({ 'unrelated.txt': 'target-only change\n' }, 'target diverges');
      git(['cherry-pick', firstSha, sourceSha]);
      break;
    case 'rebased work':
      commitFiles({ 'unrelated.txt': 'target-only change\n' }, 'target diverges');
      git(['switch', '--create', 'rebased-goal', goal.branch]);
      git(['rebase', 'main']);
      git(['branch', '--force', 'main', 'HEAD']);
      git(['switch', 'main']);
      break;
  }
  return git(['rev-parse', 'main']);
}

it.each(histories)('checks completion against real Git history: $name', async ({ name, included, ancestor }) => {
  const targetSha = prepareHistory(name);
  expect(await isGoalCommitIncluded(cwd, sourceSha, targetSha, undefined)).toBe(ancestor);
  const before = await store.get(goal.id);

  const result = await checkGoalCompletion(cwd, goal.id, undefined, policy);

  expect(result).toMatchObject({ included });
  const saved = await store.get(goal.id);
  if (included) {
    expect(result).toMatchObject({ targetSha, goal: { id: goal.id, status: 'completed' } });
    expect(saved).toMatchObject({ status: 'completed', completion: { goalSha: sourceSha, targetSha } });
    expect(saved.notifications).toEqual([expect.objectContaining({ kind: 'completed', body: 'evidence' })]);
  } else {
    expect(saved).toEqual(before);
  }
});

// SCN-INCLUDE-P3
it.each([
  { name: 'squash followed by same-file work', included: true },
  { name: 'no inclusion', included: false },
  { name: 'conflicting work', included: false },
] as const)('returns the same synchronous and asynchronous inclusion for $name', async ({ name, included }) => {
  const targetSha = prepareHistory(name);
  const env = await buildSafeGitEnvironment(cwd, { allowGitHooks: false, allowGitFilters: false });

  const asyncIncluded = await isGoalContentIncluded(cwd, sourceSha, targetSha, undefined);
  const syncIncluded = isGoalContentIncludedSync(cwd, sourceSha, targetSha, env);
  expect({ asyncIncluded, syncIncluded }).toEqual({ asyncIncluded: included, syncIncluded: included });
});

// SCN-INCLUDE-P2
it.each(['async', 'sync'] as const)('preserves staged, unstaged and untracked work, index and HEAD in the %s check', async (mode) => {
  const targetSha = prepareHistory('squash followed by same-file work');
  writeFileSync(join(cwd, 'second.txt'), 'staged local work\n');
  git(['add', 'second.txt']);
  writeFileSync(join(cwd, 'second.txt'), 'unstaged local work\n');
  writeFileSync(join(cwd, 'src/a.ts'), 'uncommitted source work\n');
  writeFileSync(join(cwd, 'untracked.txt'), 'untracked local work\n');
  const env = await buildSafeGitEnvironment(cwd, { allowGitHooks: false, allowGitFilters: false });
  const snapshot = () => ({
    status: git(['status', '--porcelain']), head: git(['rev-parse', 'HEAD']),
    index: readFileSync(join(cwd, git(['rev-parse', '--git-path', 'index']))),
    files: ['src/a.ts', 'second.txt', 'untracked.txt'].map((path) => readFileSync(join(cwd, path))),
  });
  const before = snapshot();

  const included = mode === 'async' ? await isGoalContentIncluded(cwd, sourceSha, targetSha, undefined)
    : isGoalContentIncludedSync(cwd, sourceSha, targetSha, env);

  expect(snapshot()).toEqual(before);
  expect(included).toBe(true);
});

it('completes the same saved waiting goal after an external squash and target advance', async () => {
  expect(await checkGoalCompletion(cwd, goal.id, undefined, policy)).toMatchObject({ included: false });
  expect(await store.get(goal.id)).toEqual(goal);

  squash();
  const targetSha = commitFiles({ 'src/a.ts': advancedContent }, 'target advances in the same file');
  expect(await isGoalCommitIncluded(cwd, sourceSha, targetSha, undefined)).toBe(false);

  expect(await checkGoalCompletion(cwd, goal.id, undefined, policy)).toMatchObject({ included: true, targetSha });
  const saved = await store.get(goal.id);
  expect(saved).toMatchObject({ id: goal.id, status: 'completed', completion: { goalSha: sourceSha, targetSha } });
  expect(saved.notifications).toEqual([expect.objectContaining({ kind: 'completed', body: 'evidence' })]);
});

it('completes already squashed work through the reviewed completion entry', async () => {
  const targetSha = prepareHistory('squash followed by same-file work');

  expect(await completeGoal(cwd, goal.id, sourceSha, 'evidence', 'approve', undefined, policy))
    .toMatchObject({ status: 'merged', sha: targetSha });
  expect(await store.get(goal.id)).toMatchObject({ status: 'completed', completion: { goalSha: sourceSha, targetSha } });
});

it.each(['delete', 'rename'] as const)('does not complete when the target retains a path the goal would %s', async (operation) => {
  git(['switch', goal.branch]);
  git(operation === 'delete' ? ['rm', 'src/a.ts'] : ['mv', 'src/a.ts', 'renamed.txt']);
  git(['commit', '-m', `${operation} goal file`]);
  sourceSha = git(['rev-parse', 'HEAD']);
  await store.update(goal.id, (current) => ({ ...current, completion: { ...current.completion!, goalSha: sourceSha } }));
  git(['switch', 'main']);
  commitFiles({ 'second.txt': 'goal second\n', ...(operation === 'rename' ? { 'renamed.txt': goalContent } : {}) }, 'partial goal work');
  const before = await store.get(goal.id);

  expect(await checkGoalCompletion(cwd, goal.id, undefined, policy)).toMatchObject({ included: false });
  expect(await store.get(goal.id)).toEqual(before);
});

it('does not ignore missing changes beyond the displayed diff summary', async () => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`part-${String(index).padStart(2, '0')}.txt`, 'goal work\n']));
  git(['switch', goal.branch]);
  sourceSha = commitFiles(files, 'many goal files');
  await store.update(goal.id, (current) => ({ ...current, completion: { ...current.completion!, goalSha: sourceSha } }));
  git(['switch', 'main']);
  const partial = Object.fromEntries(Object.entries(files).filter(([path]) => path !== 'part-59.txt'));
  commitFiles({ ...partial, 'src/a.ts': goalContent, 'second.txt': 'goal second\n' }, 'all but the last goal file');
  const before = await store.get(goal.id);

  expect(await checkGoalCompletion(cwd, goal.id, undefined, policy)).toMatchObject({ included: false });
  expect(await store.get(goal.id)).toEqual(before);
});

it.each(histories)('rechecks real content inside the save operation after target changes: $name', async ({ name, included, ancestor }) => {
  const finalTarget = prepareHistory(name);
  expect(await isGoalCommitIncluded(cwd, sourceSha, finalTarget, undefined)).toBe(ancestor);
  git(['update-ref', 'refs/heads/main', baseSha]);
  const before = await store.get(goal.id);
  const update = GoalStore.prototype.update;
  const save = vi.spyOn(GoalStore.prototype, 'update').mockImplementationOnce(async function (this: GoalStore, id, transform) {
    git(['update-ref', 'refs/heads/main', finalTarget, baseSha]);
    return update.call(this, id, transform);
  });

  if (included) {
    await expect(reopenGoal(cwd, goal.id, '追加の修正', undefined)).rejects.toThrow();
    expect(await store.get(goal.id)).toEqual(before);
  } else {
    await expect(reopenGoal(cwd, goal.id, '追加の修正', undefined)).resolves.toMatchObject({ goal: { status: 'created' } });
    const saved = await store.get(goal.id);
    expect(saved.completion).toEqual(before.completion);
    expect(saved.workLog).toEqual([expect.objectContaining({ summary: '追加の修正' })]);
  }
  expect(save).toHaveBeenCalledOnce();
});

async function prepareGitlinkHistory(): Promise<{ missingTarget: string; includedTarget: string }> {
  const submodule = join(cwd, '.takt', 'submodule-source');
  mkdirSync(submodule);
  git(['-C', submodule, 'init', '--initial-branch=main']);
  writeFileSync(join(submodule, 'module.txt'), 'first module version\n');
  git(['-C', submodule, 'add', 'module.txt']);
  git(['-C', submodule, 'commit', '-m', 'module base']);
  const firstModule = git(['-C', submodule, 'rev-parse', 'HEAD']);
  writeFileSync(join(submodule, 'module.txt'), 'second module version\n');
  git(['-C', submodule, 'commit', '-am', 'module update']);
  const secondModule = git(['-C', submodule, 'rev-parse', 'HEAD']);

  git(['switch', '--create', 'submodule-base', baseSha]);
  git(['update-index', '--add', '--cacheinfo', `160000,${firstModule},dependency`]);
  baseSha = commitFiles({ '.gitmodules': '[submodule "dependency"]\n\tpath = dependency\n\turl = ./.takt/submodule-source\n\tignore = all\n' }, 'record submodule base');
  git(['branch', '--force', goal.branch, baseSha]);
  git(['switch', goal.branch]);
  git(['update-index', '--cacheinfo', `160000,${secondModule},dependency`]);
  git(['commit', '-m', 'goal updates gitlink']);
  sourceSha = git(['rev-parse', 'HEAD']);
  git(['branch', '--force', 'main', baseSha]);
  git(['switch', 'main']);
  git(['commit', '--allow-empty', '-m', 'target without gitlink update']);
  const missingTarget = git(['rev-parse', 'HEAD']);
  git(['switch', '--create', 'included-gitlink', baseSha]);
  git(['update-index', '--cacheinfo', `160000,${secondModule},dependency`]);
  git(['commit', '-m', 'target includes gitlink update']);
  const includedTarget = git(['rev-parse', 'HEAD']);
  git(['switch', 'main']);
  await store.update(goal.id, (current) => ({ ...current, completion: { ...current.completion!, goalSha: sourceSha } }));
  return { missingTarget, includedTarget };
}

it.each([false, true])('checks completion with ignored submodules and recorded gitlink inclusion=%s', async (included) => {
  const { missingTarget, includedTarget } = await prepareGitlinkHistory();
  const targetSha = included ? includedTarget : missingTarget;
  git(['update-ref', 'refs/heads/main', targetSha]);
  expect(await isGoalCommitIncluded(cwd, sourceSha, targetSha, undefined)).toBe(false);
  const before = await store.get(goal.id);

  expect(await checkGoalCompletion(cwd, goal.id, undefined, policy)).toMatchObject({ included });

  const saved = await store.get(goal.id);
  if (included) {
    expect(saved).toMatchObject({ status: 'completed', completion: { goalSha: sourceSha, targetSha } });
    expect(saved.notifications).toEqual([expect.objectContaining({ kind: 'completed', body: 'evidence' })]);
  } else {
    expect(saved).toEqual(before);
  }
});

it.each([false, true])('requests completion with ignored submodules and recorded gitlink inclusion=%s', async (included) => {
  const { missingTarget, includedTarget } = await prepareGitlinkHistory();
  const targetSha = included ? includedTarget : missingTarget;
  git(['update-ref', 'refs/heads/main', targetSha]);
  await store.update(goal.id, (current) => ({ ...current, status: 'created' }));

  expect(await completeGoal(cwd, goal.id, sourceSha, 'evidence', 'approve', undefined, policy))
    .toMatchObject({ status: included ? 'merged' : 'awaiting_merge' });

  const saved = await store.get(goal.id);
  expect(saved).toMatchObject({ status: included ? 'completed' : 'awaiting_merge', completion: { goalSha: sourceSha } });
  if (included) expect(saved.completion?.targetSha).toBe(targetSha);
  else expect(saved.completion?.targetSha).toBeUndefined();
  expect(saved.notifications).toEqual([expect.objectContaining({ kind: included ? 'completed' : 'awaiting_merge', body: 'evidence' })]);
});

it.each([false, true])('checks reopening with ignored submodules and recorded gitlink inclusion=%s', async (included) => {
  const { missingTarget, includedTarget } = await prepareGitlinkHistory();
  git(['update-ref', 'refs/heads/main', included ? includedTarget : missingTarget]);
  const before = await store.get(goal.id);
  const save = vi.spyOn(GoalStore.prototype, 'update');

  if (included) {
    await expect(reopenGoal(cwd, goal.id, '追加の修正', undefined)).rejects.toThrow();
    expect(await store.get(goal.id)).toEqual(before);
    expect(save).not.toHaveBeenCalled();
  } else {
    await expect(reopenGoal(cwd, goal.id, '追加の修正', undefined)).resolves.toMatchObject({ goal: { status: 'created' } });
    expect(await store.get(goal.id)).toEqual({ ...before, status: 'created', workLog: [expect.objectContaining({ summary: '追加の修正' })] });
    expect(save).toHaveBeenCalledOnce();
  }
});

it.each([false, true])('rechecks recorded gitlink inclusion=%s at the reopen save boundary', async (included) => {
  const { missingTarget, includedTarget } = await prepareGitlinkHistory();
  const before = await store.get(goal.id);
  const update = GoalStore.prototype.update;
  const save = vi.spyOn(GoalStore.prototype, 'update').mockImplementationOnce(async function (this: GoalStore, id, transform) {
    git(['update-ref', 'refs/heads/main', included ? includedTarget : missingTarget, missingTarget]);
    return update.call(this, id, transform);
  });

  if (included) {
    await expect(reopenGoal(cwd, goal.id, '追加の修正', undefined)).rejects.toThrow();
    expect(await store.get(goal.id)).toEqual(before);
  } else {
    await expect(reopenGoal(cwd, goal.id, '追加の修正', undefined)).resolves.toMatchObject({ goal: { status: 'created' } });
    expect(await store.get(goal.id)).toEqual({ ...before, status: 'created', workLog: [expect.objectContaining({ summary: '追加の修正' })] });
  }
  expect(save).toHaveBeenCalledOnce();
});
