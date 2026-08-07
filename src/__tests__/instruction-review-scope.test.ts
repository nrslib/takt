/**
 * {review_scope} の解決と、共有 partial `review-round-scope` 経由での供給。
 *
 * 全汎用レビュアーはこの partial を include するので、エンジンが算出した
 * 変更ファイル一覧はレビュアー指示へ自動で届く。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceTemplatePlaceholders } from '../core/workflow/instruction/escape.js';
import { ReportInstructionBuilder } from '../core/workflow/instruction/ReportInstructionBuilder.js';
import {
  REVIEW_SCOPE_MAX_LISTED_PATHS,
  renderTaskReviewScope,
  type TaskReviewScope,
} from '../core/workflow/review-scope.js';
import { resolveRefToContent } from '../infra/config/loaders/resource-resolver.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

const REVIEWER_INSTRUCTIONS = [
  'review-arch',
  'review-coding',
  'ai-antipattern-review',
  'review-test',
  'review-security',
  'review-frontend',
  'review-cqrs-es',
  'robustness-review',
  'contract-lifecycle-review',
  'review-implementation-semantics',
] as const;

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

describe('review-round-scope partial supplies the scope to reviewers', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-review-scope-facet-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it.each(['en', 'ja'] as const)('renders the changed file list in every builtin reviewer instruction (%s)', (lang) => {
    const context = makeInstructionContext({
      language: lang,
      reviewScope: collected(['src/core/workflow/review-scope.ts']),
    });

    for (const name of REVIEWER_INSTRUCTIONS) {
      const instruction = resolveRefToContent(name, undefined, projectDir, 'instructions', {
        projectDir,
        lang,
      });
      expect(instruction, `missing builtin instruction: ${name}`).toBeDefined();
      expect(instruction).toContain('{review_scope}');

      const resolved = replaceTemplatePlaceholders(instruction!, makeStep(), context);

      expect(resolved).not.toContain('{review_scope}');
      expect(resolved).toContain('- src/core/workflow/review-scope.ts');
    }
  });

  // 追い掛け実行（実装が run 開始前にコミット済み）では自前の `git diff` が空になる。
  // 一覧を範囲の正だと明示しないと、レビュアーは「機能が一切未実装」と誤断する。
  const SCOPE_AUTHORITY_PHRASES = {
    ja: [
      // 権威は「一覧に載っているもの」に限定する。
      '一覧に載っているものは、エンジンが base 分岐点から算出した変更対象の正',
      '対象から外す根拠には使わないでください',
      '自前の diff が空でも',
      'run 開始前にコミット済み',
      // 補完義務のトリガーは総称条件。個別の開示種別を列挙しない
      // （isBaseBranchHead / notComputed / notRepository がすり抜ける）。
      '範囲の限定・不足・算出不能を述べている場合',
      'その記述に従って不足分を自分で補ってください',
    ],
    en: [
      'authoritative: the engine computed those entries from the base divergence point',
      'grounds for dropping an entry that the list contains',
      'even when your own diff is empty',
      'committed before this run started',
      'states that the range is limited, incomplete, or could not be computed',
      'follow that statement and make up the shortfall yourself',
    ],
  } as const;

  it.each(['en', 'ja'] as const)('declares the listed targets authoritative without forcing a self-run diff to add them (%s)', (lang) => {
    for (const name of REVIEWER_INSTRUCTIONS) {
      const instruction = resolveRefToContent(name, undefined, projectDir, 'instructions', {
        projectDir,
        lang,
      });
      for (const phrase of SCOPE_AUTHORITY_PHRASES[lang]) {
        expect(instruction, `${name} (${lang}) is missing: ${phrase}`).toContain(phrase);
      }
    }
  });

  /**
   * 文言の存在確認だけでは、実際の scope 状態と噛み合っているか分からない。
   * 各状態を実レンダリングし、「範囲の限定・不足・算出不能」を述べる状態では
   * 補完義務の文が同じ指示の中に共存することを決定的に確かめる。
   */
  const SHORTFALL_RULE = {
    ja: 'スコープ欄が範囲の限定・不足・算出不能を述べている場合',
    en: 'states that the range is limited, incomplete, or could not be computed',
  } as const;
  const SCOPE_AUTHORITY_RULE = {
    ja: '一覧に載っているものは、エンジンが base 分岐点から算出した変更対象の正',
    en: 'authoritative: the engine computed those entries from the base divergence point',
  } as const;

  const LIMITED_SCOPE_CASES: ReadonlyArray<{
    name: string;
    scope: TaskReviewScope | undefined;
    disclosure: { ja: string; en: string };
  }> = [
    {
      // run-10 同型: base ブランチ上でコミット済み + 別の未コミット変更。
      name: 'isBaseBranchHead',
      scope: {
        kind: 'collected',
        paths: ['src/a.ts'],
        source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
      },
      disclosure: {
        ja: 'コミット済み変更は含みません',
        en: 'so no committed range is included',
      },
    },
    {
      name: 'isBaseUnresolved',
      scope: {
        kind: 'collected',
        paths: ['src/a.ts'],
        source: {
          kind: 'working_tree',
          baseRange: { kind: 'unresolved', reason: 'HEAD is detached' },
        },
      },
      disclosure: {
        ja: 'base コミットを特定できなかった',
        en: 'The base commit could not be determined',
      },
    },
    {
      name: 'noPaths',
      scope: {
        kind: 'collected',
        paths: [],
        source: { kind: 'working_tree', baseRange: { kind: 'base_branch_head' } },
      },
      disclosure: {
        ja: '変更を検出しませんでした',
        en: 'detected no changes in this working directory',
      },
    },
    {
      name: 'notRepository',
      scope: { kind: 'not_a_git_repository' },
      disclosure: {
        ja: 'Git リポジトリではありません',
        en: 'is not a Git repository',
      },
    },
    {
      name: 'notComputed',
      scope: undefined,
      disclosure: {
        ja: '算出していません',
        en: 'did not compute the changed files',
      },
    },
    {
      name: 'hasOmitted',
      scope: collected(
        Array.from({ length: REVIEW_SCOPE_MAX_LISTED_PATHS + 3 }, (_, index) => `src/f-${index}.ts`),
      ),
      disclosure: { ja: '省略されています', en: 'more are omitted' },
    },
  ];

  it.each(['en', 'ja'] as const)('pairs every limited or uncomputed scope state with the shortfall rule (%s)', (lang) => {
    const instruction = resolveRefToContent('review-arch', undefined, projectDir, 'instructions', {
      projectDir,
      lang,
    });

    for (const scopeCase of LIMITED_SCOPE_CASES) {
      const resolved = replaceTemplatePlaceholders(
        instruction!,
        makeStep(),
        makeInstructionContext({ language: lang, reviewScope: scopeCase.scope }),
      );
      const where = `${scopeCase.name} (${lang})`;
      // その状態の開示文が実際に出ている。
      expect(resolved, where).toContain(scopeCase.disclosure[lang]);
      // 同じ指示の中に補完義務の総称条件が共存している。
      expect(resolved, where).toContain(SHORTFALL_RULE[lang]);
      expect(resolved, where).toContain(SCOPE_AUTHORITY_RULE[lang]);
    }
  });

  // base が解決した完全な一覧では、限定・不足の開示が出ない = 補完義務は発火しない。
  it.each(['en', 'ja'] as const)('states no shortfall when the base resolved and the list is complete (%s)', (lang) => {
    const instruction = resolveRefToContent('review-arch', undefined, projectDir, 'instructions', {
      projectDir,
      lang,
    });

    const resolved = replaceTemplatePlaceholders(
      instruction!,
      makeStep(),
      makeInstructionContext({
        language: lang,
        reviewScope: collected(['src/a.ts', 'src/b.ts']),
      }),
    );

    expect(resolved).toContain(SCOPE_AUTHORITY_RULE[lang]);
    for (const scopeCase of LIMITED_SCOPE_CASES) {
      if (scopeCase.name === 'hasOmitted') continue;
      expect(resolved, `${scopeCase.name} (${lang})`).not.toContain(scopeCase.disclosure[lang]);
    }
    expect(resolved).not.toContain(lang === 'ja' ? '省略されています' : 'more are omitted');
  });

  it.each(['en', 'ja'] as const)('keeps the review mode split intact (%s)', (lang) => {
    const instruction = resolveRefToContent('review-arch', undefined, projectDir, 'instructions', {
      projectDir,
      lang,
    });

    expect(instruction).toContain('{var:review_mode}');
    expect(instruction).toContain('`initial`');
    expect(instruction).toContain('`follow_up`');
    expect(instruction).toContain('`unspecified`');
    expect(instruction).toContain('reviewMode');
  });
});
