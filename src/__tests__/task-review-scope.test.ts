/**
 * レビュースコープ（変更対象ファイル集合）の算出。
 *
 * レビュー時点でタスクの変更が既にコミット済みの構成（PR / ブランチレビュー、
 * エージェント自身がコミットするワークフロー、ベンチのチェックポイント
 * コミット、worktree クローンの自動コミット後の再レビュー）では HEAD との
 * 差分が空になり、コミット済み範囲を含めないと変更が不可視になる。
 *
 * PR 由来の実行は対象が作業ツリーではなく PR の diff range である。クリーンな
 * base ブランチ上で PR をレビューする構成へ「変更 0 件」を注入しないこと。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectTaskReviewScope,
  createTaskReviewScopeResolver,
  resolveReviewScopeBaseRange,
  type TaskReviewScope,
} from '../core/workflow/review-scope.js';
import { createPullRequestContext } from '../core/workflow/pr-context.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
      // 実行環境の gitconfig から隔離する。core.excludesFile や init.defaultBranch、
      // commit.gpgsign のようなユーザー設定が fixture の期待値を壊さないようにする。
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_AUTHOR_NAME: 'TAKT test',
      GIT_AUTHOR_EMAIL: 'takt-test@example.invalid',
      GIT_COMMITTER_NAME: 'TAKT test',
      GIT_COMMITTER_EMAIL: 'takt-test@example.invalid',
    },
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '--quiet', '--no-verify', '-m', message);
}

function collectScope(cwd: string): TaskReviewScope {
  return collectTaskReviewScope({ cwd, baseRange: resolveReviewScopeBaseRange(cwd) });
}

function collectedPaths(cwd: string): readonly string[] {
  const scope = collectScope(cwd);
  if (scope.kind !== 'collected') {
    throw new Error(`expected a collected scope, got ${scope.kind}`);
  }
  return scope.paths;
}

describe('collectTaskReviewScope', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'takt-review-scope-'));
    git(repo, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
    writeFileSync(join(repo, 'untouched.ts'), 'export const untouched = 1;\n');
    commitAll(repo, 'base');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports zero changes on a clean base branch', () => {
    expect(collectScope(repo)).toEqual({
      kind: 'collected',
      paths: [],
      source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
    });
  });

  it('collects uncommitted working-tree changes, deletions and untracked files', () => {
    writeFileSync(join(repo, 'base.ts'), 'export const base = 2;\n');
    writeFileSync(join(repo, 'added.ts'), 'export const added = 1;\n');
    unlinkSync(join(repo, 'untouched.ts'));

    expect(collectedPaths(repo)).toEqual(['added.ts', 'base.ts', 'untouched.ts']);
  });

  it('collects committed changes on a task branch when the working tree is clean', () => {
    git(repo, 'checkout', '--quiet', '-b', 'takt/20260807-feature');
    writeFileSync(join(repo, 'implemented.ts'), 'export const implemented = 1;\n');
    commitAll(repo, 'takt: implement');

    const scope = collectScope(repo);

    expect(scope.kind).toBe('collected');
    if (scope.kind !== 'collected') return;
    expect(scope.paths).toEqual(['implemented.ts']);
    expect(scope.source).toEqual({
      kind: 'working_tree',
      baseRange: { kind: 'branch_base', baseCommit: expect.any(String) },
    });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('collects the union of committed, uncommitted and untracked changes', () => {
    git(repo, 'checkout', '--quiet', '-b', 'takt/20260807-feature');
    writeFileSync(join(repo, 'committed.ts'), 'export const committed = 1;\n');
    commitAll(repo, 'takt: implement');
    writeFileSync(join(repo, 'base.ts'), 'export const base = 3;\n');
    writeFileSync(join(repo, 'untracked.ts'), 'export const untracked = 1;\n');

    expect(collectedPaths(repo)).toEqual(['base.ts', 'committed.ts', 'untracked.ts']);
  });

  it('excludes gitignored files', () => {
    writeFileSync(join(repo, '.gitignore'), 'ignored.ts\n');
    commitAll(repo, 'ignore');
    writeFileSync(join(repo, 'ignored.ts'), 'export const ignored = 1;\n');
    writeFileSync(join(repo, 'tracked-change.ts'), 'export const tracked = 1;\n');

    expect(collectedPaths(repo)).toEqual(['tracked-change.ts']);
  });

  it('reports that the directory is not a git repository', () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'takt-review-scope-plain-'));
    try {
      expect(collectScope(plainDir)).toEqual({ kind: 'not_a_git_repository' });
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('reports not-a-repository for a directory that does not exist', () => {
    expect(collectScope(join(repo, 'missing-dir'))).toEqual({ kind: 'not_a_git_repository' });
  });

  it('lists untracked files when the repository has no commits yet', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'takt-review-scope-empty-'));
    try {
      git(fresh, 'init', '--quiet', '--initial-branch=main');
      writeFileSync(join(fresh, 'first.ts'), 'export const first = 1;\n');

      expect(collectScope(fresh)).toEqual({
        kind: 'collected',
        paths: ['first.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'no_commits' } },
      });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('falls back to working-tree-only scope and says so when the base cannot be resolved', () => {
    git(repo, 'checkout', '--quiet', '-b', 'takt/20260807-feature');
    writeFileSync(join(repo, 'implemented.ts'), 'export const implemented = 1;\n');
    commitAll(repo, 'takt: implement');
    // reflog を落とし、base ブランチも消して、分岐点の手がかりを両方奪う。
    rmSync(join(repo, '.git', 'logs'), { recursive: true, force: true });
    git(repo, 'branch', '-D', 'main');
    writeFileSync(join(repo, 'base.ts'), 'export const base = 4;\n');

    const scope = collectScope(repo);

    expect(scope.kind).toBe('collected');
    if (scope.kind !== 'collected') return;
    expect(scope.paths).toEqual(['base.ts']);
    expect(scope.source).toEqual({
      kind: 'working_tree',
      baseRange: { kind: 'unresolved', reason: expect.stringContaining('no base ref') },
    });
  });

  it('resolves the base from refs/takt/base when the base branch is absent (isolated clone)', () => {
    const baseCommit = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '--quiet', '-b', 'takt/20260807-feature');
    git(repo, 'update-ref', 'refs/takt/base/takt/20260807-feature', baseCommit);
    writeFileSync(join(repo, 'implemented.ts'), 'export const implemented = 1;\n');
    commitAll(repo, 'takt: implement');
    rmSync(join(repo, '.git', 'logs'), { recursive: true, force: true });
    git(repo, 'branch', '-D', 'main');

    expect(resolveReviewScopeBaseRange(repo)).toEqual({ kind: 'branch_base', baseCommit });
    expect(collectedPaths(repo)).toEqual(['implemented.ts']);
  });

  it('prefers the newer branch point when the reflog entry predates the merge base', () => {
    // base ブランチを進めてから取り込むと、reflog の最古エントリは実際の分岐点より古くなる。
    git(repo, 'checkout', '--quiet', '-b', 'takt/20260807-feature');
    writeFileSync(join(repo, 'implemented.ts'), 'export const implemented = 1;\n');
    commitAll(repo, 'takt: implement');
    git(repo, 'checkout', '--quiet', 'main');
    writeFileSync(join(repo, 'main-only.ts'), 'export const mainOnly = 1;\n');
    commitAll(repo, 'main moves on');
    const mergeBase = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '--quiet', 'takt/20260807-feature');
    git(repo, 'merge', '--quiet', '--no-edit', 'main');

    expect(resolveReviewScopeBaseRange(repo)).toEqual({ kind: 'branch_base', baseCommit: mergeBase });
    expect(collectedPaths(repo)).toEqual(['implemented.ts']);
  });

  it('prefers the reflog branch point when it postdates the merge base', () => {
    const firstCommit = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'mid.ts'), 'export const mid = 1;\n');
    commitAll(repo, 'mid');
    writeFileSync(join(repo, 'top.ts'), 'export const top = 1;\n');
    commitAll(repo, 'top');
    const branchPoint = git(repo, 'rev-parse', 'HEAD');

    git(repo, 'checkout', '--quiet', '-b', 'takt/20260807-feature');
    // ブランチ履歴を巻き戻すと merge-base は最初のコミットまで後退するが、
    // 実際に枝を切った地点は reflog 側の新しい方である。
    git(repo, 'reset', '--hard', '--quiet', firstCommit);
    writeFileSync(join(repo, 'implemented.ts'), 'export const implemented = 1;\n');
    commitAll(repo, 'takt: implement');

    expect(git(repo, 'merge-base', 'main', 'takt/20260807-feature')).toBe(firstCommit);
    expect(resolveReviewScopeBaseRange(repo)).toEqual({
      kind: 'branch_base',
      baseCommit: branchPoint,
    });
  });
});

describe('pull request derived scope', () => {
  let repo: string;
  let baseRef: string;
  let headRef: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'takt-review-scope-pr-'));
    git(repo, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
    commitAll(repo, 'base');
    baseRef = 'refs/takt/pr-base/main';
    headRef = 'refs/heads/feature';
    git(repo, 'update-ref', baseRef, git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'checkout', '--quiet', '-b', 'feature');
    writeFileSync(join(repo, 'pr-change.ts'), 'export const prChange = 1;\n');
    commitAll(repo, 'pr change');
    // レビューはクリーンな base ブランチ上で走る（作業ツリー差分は空）。
    git(repo, 'checkout', '--quiet', 'main');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function prContext(materialized: boolean) {
    return createPullRequestContext({
      source: 'pr_review',
      prNumber: 42,
      baseBranch: 'main',
      headBranch: 'feature',
      baseBranchSource: 'pull_request',
      ...(materialized ? { baseDiffRef: baseRef, headDiffRef: headRef } : {}),
    });
  }

  function collectWithPr(materialized: boolean): TaskReviewScope {
    return collectTaskReviewScope({
      cwd: repo,
      baseRange: resolveReviewScopeBaseRange(repo),
      prContext: prContext(materialized),
    });
  }

  it('uses the PR diff range when the working tree is clean', () => {
    const withoutPr = collectScope(repo);
    expect(withoutPr).toEqual({
      kind: 'collected',
      paths: [],
      source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
    });

    expect(collectWithPr(true)).toEqual({
      kind: 'collected',
      paths: ['pr-change.ts'],
      source: {
        kind: 'pull_request',
        prNumber: 42,
        diffRange: { baseDiffRef: baseRef, headDiffRef: headRef },
        includesWorkingTree: false,
        baseRange: { kind: 'base_branch_head' },
      },
    });
  });

  // `--pr` は PR のレビューコメントを取り込んで修正するフロー。同じ実行で
  // 作業ツリーが変わるので、その変更もレビュー対象に入らなければならない。
  it('unions the PR diff range with local changes made during the run', () => {
    writeFileSync(join(repo, 'fix-for-review.ts'), 'export const fix = 1;\n');
    writeFileSync(join(repo, 'base.ts'), 'export const base = 2;\n');

    const scope = collectWithPr(true);

    expect(scope.kind).toBe('collected');
    if (scope.kind !== 'collected') return;
    expect(scope.paths).toEqual(['base.ts', 'fix-for-review.ts', 'pr-change.ts']);
    expect(scope.source).toEqual({
      kind: 'pull_request',
      prNumber: 42,
      diffRange: { baseDiffRef: baseRef, headDiffRef: headRef },
      includesWorkingTree: true,
      baseRange: { kind: 'base_branch_head' },
    });
  });

  it('excludes synced base changes while including uncommitted fixes on re-review', () => {
    git(repo, 'checkout', '--quiet', 'feature');
    const resolve = createTaskReviewScopeResolver({
      getCwd: () => repo,
      getPrContext: () => prContext(true),
    });
    expect(resolve()).toMatchObject({ paths: ['pr-change.ts'] });

    git(repo, 'checkout', '--quiet', 'main');
    writeFileSync(join(repo, 'main-only.ts'), 'export const mainOnly = 1;\n');
    commitAll(repo, 'base advances');
    git(repo, 'update-ref', baseRef, git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'checkout', '--quiet', 'feature');
    git(repo, 'merge', '--quiet', '--no-edit', 'main');

    expect(resolve()).toMatchObject({ paths: ['pr-change.ts'] });

    writeFileSync(join(repo, 'staged-fix.ts'), 'export const stagedFix = 1;\n');
    git(repo, 'add', 'staged-fix.ts');
    writeFileSync(join(repo, 'untracked-fix.ts'), 'export const untrackedFix = 1;\n');
    unlinkSync(join(repo, 'base.ts'));

    expect(resolve()).toMatchObject({
      paths: ['base.ts', 'pr-change.ts', 'staged-fix.ts', 'untracked-fix.ts'],
      source: { includesWorkingTree: true },
    });
  });

  it('includes newly committed fixes from HEAD when the PR head ref is stale', () => {
    git(repo, 'checkout', '--quiet', 'feature');
    headRef = 'refs/takt/pr-head/42';
    git(repo, 'update-ref', headRef, git(repo, 'rev-parse', 'HEAD'));
    const resolve = createTaskReviewScopeResolver({
      getCwd: () => repo,
      getPrContext: () => prContext(true),
    });
    expect(resolve()).toMatchObject({ paths: ['pr-change.ts'] });

    writeFileSync(join(repo, 'committed-fix.ts'), 'export const committedFix = 1;\n');
    unlinkSync(join(repo, 'pr-change.ts'));
    commitAll(repo, 'commit review fix');

    expect(resolve()).toMatchObject({
      paths: ['committed-fix.ts'],
      source: { diffRange: { baseDiffRef: baseRef, headDiffRef: 'HEAD' }, includesWorkingTree: false },
    });
  });

  it('uses the explicit PR head ref and excludes committed changes on another branch', () => {
    git(repo, 'checkout', '--quiet', '-b', 'other');
    writeFileSync(join(repo, 'other-only.ts'), 'export const otherOnly = 1;\n');
    commitAll(repo, 'unrelated local commit');
    writeFileSync(join(repo, 'base.ts'), 'export const base = 2;\n');

    expect(collectWithPr(true)).toMatchObject({
      paths: ['base.ts', 'pr-change.ts'],
      source: { diffRange: { baseDiffRef: baseRef, headDiffRef: headRef } },
    });
  });

  it.each(['local', 'remote-tracking', 'remote-tracking-with-stale-local'])('keeps fixes in scope before and after commit without diff refs (%s base)', (baseLocation) => {
    const context = createPullRequestContext({ ...prContext(false), baseBranch: 'release' });
    const explicitBaseRef = baseLocation === 'local' ? 'refs/heads/release' : 'refs/remotes/origin/release';
    git(repo, 'update-ref', explicitBaseRef, git(repo, 'rev-parse', 'main'));
    if (baseLocation === 'remote-tracking-with-stale-local') {
      git(repo, 'branch', 'release', 'main');
    }
    git(repo, 'checkout', '--quiet', 'feature');
    const resolve = createTaskReviewScopeResolver({
      getCwd: () => repo,
      getPrContext: () => context,
    });
    expect(resolve()).toMatchObject({ paths: ['pr-change.ts'] });

    git(repo, 'checkout', '--quiet', 'main');
    writeFileSync(join(repo, 'base-only.ts'), 'export const baseOnly = 1;\n');
    commitAll(repo, 'base advances');
    git(repo, 'update-ref', explicitBaseRef, git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'checkout', '--quiet', 'feature');
    git(repo, 'merge', '--quiet', '--no-edit', explicitBaseRef);

    expect(resolve()).toMatchObject({
      paths: ['pr-change.ts'],
      source: { diffRange: { baseDiffRef: explicitBaseRef, headDiffRef: 'HEAD' } },
    });

    writeFileSync(join(repo, 'base.ts'), 'export const base = 2;\n');
    writeFileSync(join(repo, 'staged-fix.ts'), 'export const stagedFix = 1;\n');
    git(repo, 'add', 'staged-fix.ts');
    writeFileSync(join(repo, 'untracked-fix.ts'), 'export const untrackedFix = 1;\n');
    const expectedPaths = ['base.ts', 'pr-change.ts', 'staged-fix.ts', 'untracked-fix.ts'];
    const refsBefore = git(repo, 'show-ref');
    const statusBefore = git(repo, 'status', '--porcelain');

    expect(resolve()).toMatchObject({ paths: expectedPaths, source: { includesWorkingTree: true } });
    expect(git(repo, 'show-ref')).toBe(refsBefore);
    expect(git(repo, 'status', '--porcelain')).toBe(statusBefore);

    commitAll(repo, 'commit review fixes');

    expect(resolve()).toMatchObject({ paths: expectedPaths, source: { includesWorkingTree: false } });
  });

  it('resolves the PR head branch without diff refs when reviewing from another branch', () => {
    git(repo, 'update-ref', 'refs/remotes/origin/feature', git(repo, 'rev-parse', 'main'));
    git(repo, 'checkout', '--quiet', '-b', 'other');
    writeFileSync(join(repo, 'other-only.ts'), 'export const otherOnly = 1;\n');
    commitAll(repo, 'unrelated local commit');

    expect(collectWithPr(false)).toMatchObject({
      paths: ['pr-change.ts'],
      source: { diffRange: { baseDiffRef: 'refs/heads/main', headDiffRef: headRef } },
    });
  });

  it('lists only uncommitted changes when the explicit PR base cannot be resolved', () => {
    git(repo, 'checkout', '--quiet', 'feature');
    writeFileSync(join(repo, 'fix-for-review.ts'), 'export const fix = 1;\n');

    const scope = collectTaskReviewScope({
      cwd: repo,
      baseRange: resolveReviewScopeBaseRange(repo),
      prContext: createPullRequestContext({ ...prContext(false), baseBranch: 'missing-base' }),
    });

    expect(scope.kind).toBe('collected');
    if (scope.kind !== 'collected') return;
    expect(scope.paths).toEqual(['fix-for-review.ts']);
    expect(scope.source).toEqual({
      kind: 'pull_request',
      prNumber: 42,
      includesWorkingTree: true,
      baseRange: { kind: 'branch_base', baseCommit: expect.any(String) },
    });
  });

  it('forwards the PR context through the engine-boundary resolver', () => {
    const resolve = createTaskReviewScopeResolver({
      getCwd: () => repo,
      getPrContext: () => prContext(true),
    });

    const scope = resolve();

    expect(scope.kind).toBe('collected');
    if (scope.kind !== 'collected') return;
    expect(scope.paths).toEqual(['pr-change.ts']);
    expect(scope.source.kind).toBe('pull_request');
  });

  it('drops the diff range when the recorded refs no longer exist', () => {
    git(repo, 'update-ref', '-d', baseRef);

    const scope = collectWithPr(true);

    expect(scope.kind).toBe('collected');
    if (scope.kind !== 'collected') return;
    expect(scope.source).toEqual({
      kind: 'pull_request',
      prNumber: 42,
      includesWorkingTree: false,
      baseRange: { kind: 'base_branch_head' },
    });
  });
});

describe('createTaskReviewScopeResolver', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'takt-review-scope-resolver-'));
    git(repo, 'init', '--quiet', '--initial-branch=main');
    writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
    commitAll(repo, 'base');
    git(repo, 'checkout', '--quiet', '-b', 'takt/20260807-feature');
    writeFileSync(join(repo, 'implemented.ts'), 'export const implemented = 1;\n');
    commitAll(repo, 'takt: implement');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('keeps the resolved base across calls while re-reading the working tree', () => {
    const resolve = createTaskReviewScopeResolver({
      getCwd: () => repo,
      getPrContext: () => undefined,
    });

    const first = resolve();
    expect(first.kind).toBe('collected');
    if (first.kind !== 'collected') return;
    expect(first.paths).toEqual(['implemented.ts']);
    const firstSource = first.source;

    writeFileSync(join(repo, 'later.ts'), 'export const later = 1;\n');
    const second = resolve();

    expect(second.kind).toBe('collected');
    if (second.kind !== 'collected') return;
    expect(second.paths).toEqual(['implemented.ts', 'later.ts']);
    expect(second.source).toEqual(firstSource);
  });

  // no_commits を保持すると、初コミット後にトラッキング済み変更が恒久的に見えなくなる。
  it('re-resolves the base after the first commit lands in an empty repository', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'takt-review-scope-empty-resolver-'));
    try {
      git(fresh, 'init', '--quiet', '--initial-branch=main');
      writeFileSync(join(fresh, 'first.ts'), 'export const first = 1;\n');
      const resolve = createTaskReviewScopeResolver({
        getCwd: () => fresh,
        getPrContext: () => undefined,
      });

      const beforeCommit = resolve();
      expect(beforeCommit).toEqual({
        kind: 'collected',
        paths: ['first.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'no_commits' } },
      });

      commitAll(fresh, 'first');
      writeFileSync(join(fresh, 'first.ts'), 'export const first = 2;\n');
      const afterCommit = resolve();

      expect(afterCommit).toEqual({
        kind: 'collected',
        paths: ['first.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
      });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  // not_a_git_repository も遷移する（worktree が後から作られる経路）。
  it('re-resolves once a directory becomes a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'takt-review-scope-plain-resolver-'));
    try {
      const resolve = createTaskReviewScopeResolver({
        getCwd: () => plain,
        getPrContext: () => undefined,
      });
      expect(resolve()).toEqual({ kind: 'not_a_git_repository' });

      git(plain, 'init', '--quiet', '--initial-branch=main');
      writeFileSync(join(plain, 'new.ts'), 'export const created = 1;\n');

      expect(resolve()).toEqual({
        kind: 'collected',
        paths: ['new.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'no_commits' } },
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
