/**
 * {review_scope} の解決。
 */
import { describe, expect, it } from 'vitest';
import { replaceTemplatePlaceholders } from '../core/workflow/instruction/escape.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import {
  REVIEW_SCOPE_MAX_LISTED_PATHS,
  renderTaskReviewScope,
  type TaskReviewScope,
} from '../core/workflow/review-scope.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

function collected(paths: readonly string[]): TaskReviewScope {
  return {
    kind: 'collected',
    paths,
    source: { kind: 'working_tree', baseRange: { kind: 'branch_base', baseCommit: 'abcdef1234567890' } },
  };
}

describe('{review_scope} resolution', () => {
  it('lists the engine-computed changed files', () => {
    const context = makeInstructionContext({
      language: 'ja',
      reviewScope: collected(['src/a.ts', 'src/b.ts']),
    });

    const resolved = replaceTemplatePlaceholders('{review_scope}', makeStep(), context);

    expect(resolved).toContain('- src/a.ts');
    expect(resolved).toContain('- src/b.ts');
    expect(resolved).toContain('2 件');
    expect(resolved).toContain('abcdef123456');
  });

  it.each(['en', 'ja'] as const)('reports no detected change without asserting it as a premise in %s', (language) => {
    const resolved = renderTaskReviewScope(
      {
        kind: 'collected',
        paths: [],
        source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
      },
      language,
    );

    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).toContain(
      language === 'ja' ? 'この作業ディレクトリで変更を検出しませんでした' : 'detected no changes in this working directory',
    );
    expect(resolved).not.toContain(language === 'ja' ? '前提にしてください' : 'established fact');
  });

  it.each(['en', 'ja'] as const)('uses the PR diff range for PR-derived runs in %s', (language) => {
    const resolved = renderTaskReviewScope(
      {
        kind: 'collected',
        paths: ['src/pr.ts'],
        source: {
          kind: 'pull_request',
          prNumber: 42,
          diffRange: {
            baseDiffRef: 'refs/takt/pr-base/feature',
            headDiffRef: 'refs/heads/feature',
          },
          includesWorkingTree: false,
          baseRange: { kind: 'base_branch_head' },
        },
      },
      language,
    );

    expect(resolved).toContain('- src/pr.ts');
    expect(resolved).toContain('refs/takt/pr-base/feature...refs/heads/feature');
    expect(resolved).toContain('#42');
    expect(resolved).toContain(
      language === 'ja' ? 'ローカルに追加の変更がない' : 'added no local changes',
    );
  });

  // `--pr` は修正フロー。ローカル変更があるのに「作業ツリーは対象外」と言ってはならない。
  it.each(['en', 'ja'] as const)('states that local changes are included for PR runs in %s', (language) => {
    const resolved = renderTaskReviewScope(
      {
        kind: 'collected',
        paths: ['src/fix.ts', 'src/pr.ts'],
        source: {
          kind: 'pull_request',
          prNumber: 42,
          diffRange: {
            baseDiffRef: 'refs/takt/pr-base/feature',
            headDiffRef: 'refs/heads/feature',
          },
          includesWorkingTree: true,
          baseRange: { kind: 'base_branch_head' },
        },
      },
      language,
    );

    expect(resolved).toContain('- src/fix.ts');
    expect(resolved).toContain('- src/pr.ts');
    expect(resolved).toContain(
      language === 'ja' ? 'この実行のローカル変更' : 'plus the local changes of this run',
    );
    expect(resolved).not.toContain(
      language === 'ja' ? 'レビュー対象は PR 側の差分だけ' : 'review target is the PR-side diff only',
    );
  });

  // PR 経路のローカル分は作業ツリー計算そのもの。base が unresolved ならコミット済み
  // 変更が一覧から抜けている事実を、非 PR 経路と同じく開示しなければならない。
  it.each(['en', 'ja'] as const)('discloses an unresolved base on the PR path in %s', (language) => {
    const resolved = renderTaskReviewScope(
      {
        kind: 'collected',
        paths: ['src/fix.ts', 'src/pr.ts'],
        source: {
          kind: 'pull_request',
          prNumber: 42,
          diffRange: {
            baseDiffRef: 'refs/takt/pr-base/feature',
            headDiffRef: 'refs/heads/feature',
          },
          includesWorkingTree: true,
          baseRange: { kind: 'unresolved', reason: 'HEAD is detached' },
        },
      },
      language,
    );

    expect(resolved).toContain('#42');
    expect(resolved).toContain('HEAD is detached');
    expect(resolved).toContain(
      language === 'ja' ? 'base コミットを特定できなかった' : 'base commit could not be determined',
    );
  });

  it.each(['en', 'ja'] as const)('names the PR as the target when its diff range is missing in %s', (language) => {
    const resolved = renderTaskReviewScope(
      {
        kind: 'collected',
        paths: ['src/fix.ts'],
        source: {
          kind: 'pull_request',
          prNumber: 42,
          includesWorkingTree: true,
          baseRange: { kind: 'base_branch_head' },
        },
      },
      language,
    );

    expect(resolved).toContain('#42');
    expect(resolved).toContain('- src/fix.ts');
    expect(resolved).toContain(
      language === 'ja' ? 'diff range がローカルに用意されていない' : 'diff range is not available locally',
    );
    expect(resolved).not.toContain(language === 'ja' ? '変更を検出しませんでした' : 'detected no changes');
  });

  it.each(['en', 'ja'] as const)('states that the directory is not a git repository in %s', (language) => {
    const resolved = renderTaskReviewScope({ kind: 'not_a_git_repository' }, language);

    expect(resolved).toContain(language === 'ja' ? 'Git リポジトリではありません' : 'not a Git repository');
  });

  it.each(['en', 'ja'] as const)('states that the scope was not computed in %s', (language) => {
    const resolved = renderTaskReviewScope(undefined, language);

    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).toContain(language === 'ja' ? '算出していません' : 'did not compute');
  });

  it.each(['en', 'ja'] as const)('warns that committed changes are missing when the base is unresolved in %s', (language) => {
    const resolved = renderTaskReviewScope(
      {
        kind: 'collected',
        paths: ['src/a.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'unresolved', reason: 'HEAD is detached' } },
      },
      language,
    );

    expect(resolved).toContain('HEAD is detached');
    expect(resolved).toContain(language === 'ja' ? 'base コミットを特定できなかった' : 'base commit could not be determined');
  });

  it('truncates long lists and states the omitted count instead of dropping it silently', () => {
    const paths = Array.from({ length: REVIEW_SCOPE_MAX_LISTED_PATHS + 7 }, (_, index) => `src/file-${index}.ts`);

    const resolved = renderTaskReviewScope(collected(paths), 'ja');

    expect(resolved).toContain(`- ${paths[REVIEW_SCOPE_MAX_LISTED_PATHS - 1]}`);
    expect(resolved).not.toContain(`- ${paths[REVIEW_SCOPE_MAX_LISTED_PATHS]}`);
    expect(resolved).toContain(String(paths.length));
    expect(resolved).toContain('残り 7 件');
  });

  it('resolves {review_scope} in Phase 2 output contracts', () => {
    const step = makeStep({
      outputContracts: [{
        name: 'review.md',
        format: 'Scope under review:\n\n{review_scope}',
      }],
    });

    const instruction = new ReportInstructionBuilder(step, {
      cwd: '/tmp/test',
      reportDir: '/tmp/test/reports',
      stepIteration: 1,
      language: 'ja',
      targetFile: 'review.md',
      reviewScope: collected(['src/phase2.ts']),
    }).build();

    expect(instruction).not.toContain('{review_scope}');
    expect(instruction).toContain('- src/phase2.ts');
  });
});
