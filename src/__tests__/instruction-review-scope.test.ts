/**
 * {review_scope} の解決と、共有 partial `review-round-scope` 経由での供給。
 *
 * 全汎用レビュアーはこの partial を include するので、エンジンが算出した
 * 変更ファイル一覧はレビュアー指示へ自動で届く。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  getAllParallelSubSteps,
  type WorkflowCallStep,
  type WorkflowConfig,
  type WorkflowStep,
} from '../core/models/types.js';
import {
  getBuiltinWorkflow,
  listBuiltinWorkflowNames,
  listStandaloneWorkflowEntries,
} from '../infra/config/loaders/workflowResolver.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import { invalidateAllResolvedConfigCache } from '../infra/config/resolutionCache.js';
import { makeInstructionContext, makeStep } from './test-helpers.js';

const REVIEWER_INSTRUCTION_VARIANTS = [
  'architecture-review',
  'follow-up-architecture-review',
  'coding-review',
  'follow-up-coding-review',
  'ai-antipattern-review',
  'initial-ai-antipattern-review',
  'follow-up-ai-antipattern-review',
  'testing-review',
  'follow-up-testing-review',
  'security-review',
  'follow-up-security-review',
  'frontend-review',
  'follow-up-frontend-review',
  'cqrs-es-review',
  'follow-up-cqrs-es-review',
] as const;

function collected(paths: readonly string[]): TaskReviewScope {
  return {
    kind: 'collected',
    paths,
    source: { kind: 'working_tree', baseRange: { kind: 'branch_base', baseCommit: 'abcdef1234567890' } },
  };
}

function collectAgentSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [
    ...(typeof step.persona === 'string' ? [step] : []),
    ...collectAgentSteps(step.parallel === undefined ? [] : getAllParallelSubSteps(step.parallel)),
  ]);
}

function resolvePeerReviewAiInstruction(
  workflow: WorkflowConfig,
  reviewCall: WorkflowCallStep,
  projectDir: string,
): string {
  const suite = resolveWorkflowCallTarget(workflow, reviewCall, projectDir);
  const reviewer = suite === null
    ? undefined
    : collectAgentSteps(suite.steps).find((step) => step.persona === 'ai-antipattern-reviewer');
  if (typeof reviewer?.instruction !== 'string') {
    throw new Error(`AI antipattern reviewer instruction not found: ${reviewCall.name}`);
  }
  return reviewer.instruction;
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

describe('review instruction variants receive the runtime-computed scope', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'takt-review-scope-facet-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    invalidateAllResolvedConfigCache();
  });

  it.each(['en', 'ja'] as const)('renders the changed file list in every builtin reviewer instruction (%s)', (lang) => {
    const context = makeInstructionContext({
      language: lang,
      reviewScope: collected(['src/core/workflow/review-scope.ts']),
    });

    for (const name of REVIEWER_INSTRUCTION_VARIANTS) {
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

  it.each(['en', 'ja'] as const)('keeps legacy builtin review loops dynamically scoped across iterations (%s)', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${lang}\n`);
    invalidateAllResolvedConfigCache();
    const context = makeInstructionContext({
      language: lang,
      reviewScope: collected(['src/legacy-consumer.ts']),
    });
    const workflows = listStandaloneWorkflowEntries(projectDir)
      .filter(({ source }) => source === 'builtin')
      .map(({ name }) => getBuiltinWorkflow(name, projectDir))
      .filter((workflow): workflow is WorkflowConfig => workflow !== null);
    const legacyReviewers = workflows.flatMap((workflow) => collectAgentSteps(workflow.steps))
      .filter((step) => typeof step.instruction === 'string'
        && step.instruction.includes('{var:review_mode}')
        && step.instruction.includes('{step_iteration}'));

    expect(legacyReviewers.length).toBeGreaterThan(0);
    expect(legacyReviewers.some((step) => step.persona === 'ai-antipattern-reviewer')).toBe(true);
    for (const reviewer of legacyReviewers) {
      const initial = replaceTemplatePlaceholders(reviewer.instruction!, reviewer, {
        ...context,
        stepIteration: 1,
      });
      const followUpByIteration = replaceTemplatePlaceholders(reviewer.instruction!, reviewer, {
        ...context,
        stepIteration: 2,
      });
      const followUpByCaller = replaceTemplatePlaceholders(reviewer.instruction!, reviewer, {
        ...context,
        stepIteration: 1,
        workflowCallVars: { review_mode: 'follow_up' },
      });

      expect(initial).toContain('unspecified');
      expect(followUpByIteration).toContain('2');
      expect(followUpByCaller).toContain('follow_up');
      expect(followUpByIteration).not.toBe(initial);
      expect(followUpByCaller).not.toBe(initial);
    }
  });

  it.each(['en', 'ja'] as const)('resolves distinct initial and follow-up AI review authority in peer review (%s)', (lang) => {
    mkdirSync(join(projectDir, '.takt'), { recursive: true });
    writeFileSync(join(projectDir, '.takt', 'config.yaml'), `language: ${lang}\n`);
    invalidateAllResolvedConfigCache();
    const workflows = listBuiltinWorkflowNames(projectDir, { includeDisabled: true })
      .map((name) => getBuiltinWorkflow(name, projectDir))
      .filter((workflow): workflow is WorkflowConfig => workflow !== null);
    const findCall = (instructionRef: string): { workflow: WorkflowConfig; step: WorkflowCallStep } | undefined => (
      workflows.flatMap((workflow) => workflow.steps
        .filter((step): step is WorkflowCallStep => step.kind === 'workflow_call')
        .map((step) => ({ workflow, step })))
        .find(({ step }) => step.args?.ai_antipattern_review_instruction === instructionRef)
    );
    const initialCall = findCall('initial-ai-antipattern-review');
    const followUpCall = findCall('follow-up-ai-antipattern-review');
    if (initialCall === undefined || followUpCall === undefined) {
      throw new Error('Explicit AI review variant callers not found');
    }

    const initial = resolvePeerReviewAiInstruction(initialCall.workflow, initialCall.step, projectDir);
    const followUp = resolvePeerReviewAiInstruction(followUpCall.workflow, followUpCall.step, projectDir);
    const expectedInitial = resolveRefToContent('initial-ai-antipattern-review', undefined, projectDir, 'instructions', {
      projectDir,
      lang,
    });
    const expectedFollowUp = resolveRefToContent('follow-up-ai-antipattern-review', undefined, projectDir, 'instructions', {
      projectDir,
      lang,
    });
    if (expectedInitial === undefined || expectedFollowUp === undefined) {
      throw new Error('Explicit AI review variants not found');
    }

    expect(initial).not.toContain('{var:review_mode}');
    expect(initial).toBe(expectedInitial);
    expect(initial).not.toBe(expectedFollowUp);
    expect(followUp).not.toContain('{var:review_mode}');
    expect(followUp).toBe(expectedFollowUp);
    expect(followUp).not.toBe(expectedInitial);
  });

});
