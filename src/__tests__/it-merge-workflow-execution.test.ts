import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEffect, WorkflowStep } from '../core/models/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import type { WorkflowCallResolutionRequest } from '../core/workflow/types.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../agents/structured-caller/transport.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agents/structured-caller/transport.js')>(),
  executeStructuredAgent: vi.fn(),
}));
import { runAgent } from '../agents/runner.js';
import { executeStructuredAgent } from '../agents/structured-caller/transport.js';

interface Scenario {
  prNumber?: number;
  approved?: boolean;
  reason?: string;
  ciPassed?: boolean;
  ciRunning?: boolean;
  reviewDecision?: string;
  syncFailed?: boolean;
  conflictFailed?: boolean;
  pushFailed?: boolean;
  mergeFailed?: boolean;
  qualityFailed?: boolean;
  cannotRemediate?: boolean;
  gatherFailed?: boolean;
  prePushRemoteConflicting?: boolean;
  prePushRemoteHeadDiffers?: boolean;
}

describe('Builtin PR merge workflow execution', () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'takt-merge-workflows-'));
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(project, { recursive: true, force: true });
  });

  it.each([
    ['ja', 'merge-review', 'review'],
    ['en', 'merge-review', 'review'],
    ['ja', 'merge-review-fix', 'review-fix'],
    ['en', 'merge-review-fix', 'review-fix'],
    ['ja', 'merge-review-fix-simple', 'review-fix-simple'],
    ['en', 'merge-review-fix-simple', 'review-fix-simple'],
  ])('%sの%sから実際の%sを子workflowとして解決できる', (language, name, childName) => {
    const workflow = loadWorkflowByIdentifier(join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`), project);
    if (!workflow) throw new Error(`Missing builtin workflow: ${name}`);
    const step = workflow.steps.find((candidate) => candidate.kind === 'workflow_call' && candidate.call === childName);
    if (!step || step.kind !== 'workflow_call') throw new Error('Missing review workflow call');
    const child = resolveWorkflowCallTarget(workflow, step, project, join(project, 'clone'));
    expect(child?.name).toBe(childName);
    expect(child?.subworkflow?.callable).toBe(true);
    expect(child?.steps.length).toBeGreaterThan(0);
  });

  it.each(['ja', 'en'] as const)('%sのsingle-review-suiteは編集しない1体のレビュアーだけを持つ', (language) => {
    const suite = loadWorkflowByIdentifier(join(process.cwd(), 'builtins', language, 'workflows', 'single-review-suite.yaml'), project);
    expect(suite?.steps).toHaveLength(1);
    const review = suite?.steps[0];
    expect(review?.name).toBe('review');
    expect(review?.kind).toBe('agent');
    if (review?.kind !== 'agent') throw new Error('Expected agent reviewer');
    expect(review.persona).toBe('coding-reviewer');
    expect(review.edit).toBe(false);
    expect(review.parallel).toBeUndefined();
  });

  function harness(name: string, scenario: Scenario = {}, language = 'ja') {
    if (language !== 'ja' && language !== 'en') throw new Error(`Unsupported test language: ${language}`);
    const simple = name === 'merge-review-fix-simple';
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), `language: ${language}\n`);
    const prNumber = scenario.prNumber ?? 123;
    const workflow = loadWorkflowByIdentifier(join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`), project);
    if (!workflow) throw new Error(`Missing builtin workflow: ${name}`);
    let ciFinished = scenario.ciRunning !== true || name !== 'merge-review';
    let headSha = 'a'.repeat(40);
    let conflictsResolved = false;
    const calls: string[] = [];
    const judgedSteps: string[] = [];
    const comments: string[] = [];
    const failures: string[] = [];
    const observedStatuses: Array<{ headSha: string; finished: boolean; mergeable: string }> = [];
    const childContexts: Array<{ cwd: string; projectCwd: string; prNumber: number | undefined }> = [];
    const simpleReviewPrompts: string[] = [];
    const cloneCwd = join(project, 'clone');
    mkdirSync(cloneCwd);
    const reportDirectory = join(project, '.takt', 'runs', 'merge-workflow-report', 'reports');
    const decision = { approved: scenario.approved !== false,
      reason: scenario.reason ?? (scenario.approved === false ? 'AI denied this PR' : 'AI approved this PR') };
    let reviewCount = 0;
    vi.mocked(executeStructuredAgent).mockResolvedValue({ persona: 'dynamic-facet-selector',
      status: 'done', content: '', timestamp: new Date(),
      structuredOutput: { selected_ids: ['backend'], rationale: 'Review the changed backend path.' } });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'supervisor', userInstruction: prompt });
      if (simple && options?.workflowMeta?.currentStep === 'gather') {
        return { persona: persona ?? 'planner', status: 'done', content: 'GATHERED_CONTEXT: backend change in PR.', timestamp: new Date() };
      }
      if ((simple && options?.workflowMeta?.workflowName === 'single-review-suite') || (!simple && options?.workflowMeta?.currentStep === 'write_report')) {
        if (simple && options?.executionPhase === 1) simpleReviewPrompts.push(prompt);
        const reviewResult = simple && scenario.qualityFailed && reviewCount === 0 ? 'REJECT' : 'APPROVE';
        if (simple && options?.executionPhase === 1) reviewCount++;
        const reviewReason = reviewResult === 'REJECT' ? 'Concrete code defect' : 'No unresolved issues';
        return { persona: 'reviewer', status: 'done',
          content: `CHILD_REVIEW_REPORT: PR ${prNumber} result=${reviewResult}. ${reviewReason}.`,
          ...(simple ? { structuredOutput: { result: reviewResult } } : {}),
          timestamp: new Date() };
      }
      if (simple && options?.workflowMeta?.workflowName === 'peer-review') {
        return { persona: persona ?? 'review-adjudicator', status: 'done',
          content: 'Review resolution: one actionable finding.', timestamp: new Date() };
      }
      if (simple && options?.workflowMeta?.workflowName === 'development-remediation-dynamic') {
        return { persona: persona ?? 'developer', status: 'done',
          content: 'Fix plan, implementation, and validation evidence.', timestamp: new Date() };
      }
      expect(prompt).toContain('CHILD_REVIEW_REPORT');
      if (name === 'merge-review') {
        expect(prompt).toContain(`${language === 'ja' ? 'レビューサマリー' : 'Review summary'}: CHILD_REVIEW_REPORT`);
        expect(prompt).not.toContain('{report:review-summary.md}');
      }
      const childReports = join(reportDirectory, 'subworkflows');
      const report = readdirSync(childReports, { recursive: true, encoding: 'utf8' })
        .find((name) => name.endsWith('review-summary.md'));
      if (!report) throw new Error('Child review report was not produced');
      expect(readFileSync(join(childReports, report), 'utf8')).toContain('CHILD_REVIEW_REPORT');
      return { persona: 'supervisor', status: 'done', content: JSON.stringify(decision),
        structuredOutput: decision, timestamp: new Date() };
    });
    const child = normalizeWorkflowConfig({ name: 'review-child', subworkflow: { callable: true },
      initial_step: 'report_review', steps: [{ name: 'report_review', mode: 'system',
        system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'status' }],
        rules: [{ condition: 'when(true)', next: 'write_report' }] },
      { name: 'write_report', persona: 'reviewer', instruction: 'Report the PR review result.',
        output_contracts: { report: [{ name: 'review-summary.md', format: 'Review result' }] },
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    }, project);
    const resolveChild = vi.fn((request: WorkflowCallResolutionRequest) => {
      const { step } = request;
      calls.push(`call:${step.call}`);
      return simple ? resolveWorkflowCallTarget(request.parentWorkflow, step, request.projectCwd, request.lookupCwd) : child;
    });
    const resolveSystemInput = vi.fn((input: NonNullable<WorkflowStep['systemInputs']>[number]) => {
      if (input.type === 'task_context') return { exists: true, body: `Review PR ${prNumber}` };
      if (input.type === 'branch_context') return { exists: true, name: 'feature/pr' };
      const remoteHeadSha = scenario.prePushRemoteHeadDiffers && headSha === 'a'.repeat(40)
        ? 'c'.repeat(40) : headSha;
      const mergeable = (scenario.syncFailed && !conflictsResolved)
        || (scenario.prePushRemoteConflicting && headSha === 'a'.repeat(40)) ? 'CONFLICTING' : 'MERGEABLE';
      observedStatuses.push({ headSha: remoteHeadSha, finished: ciFinished, mergeable });
      return { exists: true, number: prNumber, headSha: remoteHeadSha, branch: 'feature/pr', baseBranch: 'main',
        ci: { finished: ciFinished, passed: ciFinished && scenario.ciPassed !== false },
        mergeable, mergeStateStatus: 'CLEAN',
        reviewDecision: scenario.reviewDecision ?? 'APPROVED', merged: false };
    });
    const executeEffect = vi.fn(async (effect: WorkflowEffect, payload: Record<string, unknown>) => {
      calls.push(effect.type);
      if (effect.type === 'comment_pr') comments.push(String(payload.body));
      const failed = (effect.type === 'sync_with_root' && scenario.syncFailed)
        || (effect.type === 'resolve_conflicts_with_ai' && scenario.conflictFailed)
        || (String(effect.type) === 'commit_and_push' && scenario.pushFailed)
        || (effect.type === 'merge_pr' && scenario.mergeFailed);
      if (effect.type === 'resolve_conflicts_with_ai' && !failed) conflictsResolved = true;
      if (String(effect.type) === 'commit_and_push' && !failed) {
        headSha = 'b'.repeat(40);
        ciFinished = scenario.ciRunning !== true;
      }
      return { success: !failed, failed: Boolean(failed),
        ...(effect.type === 'sync_with_root' || effect.type === 'resolve_conflicts_with_ai' ? { conflicted: Boolean(failed) } : {}),
        ...(String(effect.type) === 'commit_and_push' && !failed ? { headSha } : {}),
        ...(failed ? { error: `${effect.type} rejected` } : {}) };
    });
    const engine = new WorkflowEngine(workflow, cloneCwd, `Review PR ${prNumber}`, {
      provider: 'mock', language, projectCwd: project, reportDirName: 'merge-workflow-report',
      selectorProvider: { provider: 'mock', model: 'mock' },
      selectorGitCommandRunner: { isInsideWorkTree: async () => false,
        run: async () => ({ output: Buffer.from(''), bytes: 0 }) },
      runPathsDirectory: join(project, '.takt', 'runs'),
      prContext: { source: 'pr_review', prNumber, baseBranch: 'main', headBranch: 'feature/pr', baseBranchSource: 'pull_request' },
      ...{ prExecutionContext: { prNumber, headBranch: 'feature/pr', baseBranch: 'main',
        headSha, headRepositoryUrl: 'https://github.com/author/repo.git',
        headRepositoryPushUrls: ['https://github.com/author/repo.git'] } },
      workflowCallResolver: resolveChild,
      structuredCaller: { judgeStatus: vi.fn(async (instruction, _tagInstruction, _candidates, options) => {
        judgedSteps.push(options.stepName);
        options.onStructuredPromptResolved?.({ systemPrompt: 'conductor', userInstruction: instruction });
        if (simple) {
          const candidateIndex = options.stepName === 'gather' && scenario.gatherFailed ? 1
            : options.stepName === 'review-adjudication' && scenario.qualityFailed && reviewCount === 1 ? 0
              : options.stepName === 'review-adjudication' ? 1
                : options.stepName === 'fix-plan' && scenario.cannotRemediate ? 2
                  : 0;
          return { candidateIndex, method: 'structured_output' as const };
        }
        return {
          candidateIndex: options.stepName === 'gather' && scenario.gatherFailed ? 1 : 0,
          method: 'structured_output' as const,
        };
      }),
        evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn() },
      systemStepServicesFactory: (options) => ({
        resolveSystemInput: (input, _state, stepName) => {
          if (stepName === 'report_review') {
            const context = (options as unknown as { prExecutionContext?: { prNumber: number } }).prExecutionContext;
            childContexts.push({ cwd: options.cwd, projectCwd: options.projectCwd, prNumber: context?.prNumber });
          }
          return resolveSystemInput(input);
        },
        executeEffect,
      }),
    });
    engine.on('workflow:abort', (_state, reason) => failures.push(reason));
    return { engine, calls, judgedSteps, comments, failures, observedStatuses, childContexts, cloneCwd, executeEffect, simpleReviewPrompts, finishCi: () => { ciFinished = true; } };
  }

  it.each(['ja', 'en'] as const)('%sのsimpleは単体レビューと共通最終ゲートを経てpush後のCIを待ってmergeする', async (language) => {
    const h = harness('merge-review-fix-simple', { ciRunning: true, syncFailed: true }, language);
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.failures).toEqual([]);
    expect(h.calls, JSON.stringify(h.engine.getState().stepOutputs.get('review'))).toContain('commit_and_push');
    expect(h.calls).not.toContain('merge_pr');
    h.finishCi();
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await running).status).toBe('completed');
    expect(h.failures).toEqual([]);
    expect(h.calls).toContain('call:review-fix-simple');
    expect(h.calls.indexOf('resolve_conflicts_with_ai')).toBeLessThan(h.calls.indexOf('call:review-fix-simple'));
    expect(h.calls.indexOf('commit_and_push')).toBeLessThan(h.calls.indexOf('merge_pr'));
    expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(1);
    expect(h.judgedSteps).not.toContain('review-fix');
    expect(h.observedStatuses.at(-1)).toEqual({ headSha: 'b'.repeat(40), finished: true, mergeable: 'MERGEABLE' });
    expect(h.calls).toContain('call:peer-review');
    expect(h.calls).toContain('call:single-review-suite');
    expect(h.calls).not.toContain('call:development-remediation-dynamic');
    expect(h.calls.filter((call) => call === 'call:single-review-suite')).toHaveLength(1);
    expect(vi.mocked(runAgent).mock.calls.filter(([, , options]) =>
      options?.workflowMeta?.workflowName === 'single-review-suite' && options.executionPhase === 1)).toHaveLength(1);
    expect(new Set(vi.mocked(runAgent).mock.calls.map(([persona]) => persona)))
      .toEqual(new Set(['planner', 'coding-reviewer', 'review-adjudicator', 'supervisor']));
    const reviewPrompt = vi.mocked(runAgent).mock.calls.find(([, , options]) =>
      options?.workflowMeta?.workflowName === 'single-review-suite')?.[1];
    const contextDirectory = join(project, '.takt', 'runs', 'merge-workflow-report', 'context');
    const knowledgeFile = readdirSync(contextDirectory, { recursive: true, encoding: 'utf8' })
      .find((name) => name.includes('/knowledge/review.'));
    if (!knowledgeFile) throw new Error('Review knowledge was not materialized');
    expect(reviewPrompt).toContain(join(contextDirectory, knowledgeFile));
    expect(readFileSync(join(contextDirectory, knowledgeFile), 'utf8'))
      .toContain(readFileSync(join(process.cwd(), 'builtins', language, 'facets', 'knowledge', 'backend.md'), 'utf8').trim());
    expect(reviewPrompt).toContain('review-target.md');
    expect(executeStructuredAgent).toHaveBeenCalledTimes(1);
    const selectorPrompt = vi.mocked(executeStructuredAgent).mock.calls[0]?.[0];
    expect(selectorPrompt).toContain('single-review-suite');
    expect(h.comments[0]).toMatch(/\bmerged\b/);
  });

  it.each(['ja', 'en'] as const)('%sのsimpleはpush前のリモート競合とhead相違で品質承認を覆さない', async (language) => {
    const h = harness('merge-review-fix-simple', {
      prePushRemoteConflicting: true,
      prePushRemoteHeadDiffers: true,
    }, language);
    const result = await h.engine.run();
    expect(result.status).toBe('completed');
    expect(h.observedStatuses.some((status) => status.mergeable === 'CONFLICTING'
      && status.headSha === 'c'.repeat(40))).toBe(true);
    expect(h.calls).toContain('commit_and_push');
    expect(h.calls).toContain('merge_pr');
    expect(h.judgedSteps).not.toContain('review-fix');
    expect(h.comments[0]).toMatch(/\bmerged\b/);
  });

  it.each(['ja', 'en'] as const)('%sのsimpleはレビュー対象を収集できない場合pushもmergeもしない', async (language) => {
    const h = harness('merge-review-fix-simple', { gatherFailed: true }, language);
    await h.engine.run();
    expect(h.failures).toEqual([]);
    expect(h.calls).not.toContain('commit_and_push');
    expect(h.calls).not.toContain('merge_pr');
    expect(h.judgedSteps).not.toContain('review-fix');
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toContain('child review workflow aborted');
  });

  it.each(['ja', 'en'] as const)('%sのsimpleは指摘を裁定・修正・再レビューしてからpushする', async (language) => {
    const h = harness('merge-review-fix-simple', { qualityFailed: true }, language);
    const result = await h.engine.run();
    expect(result.status).toBe('completed');
    expect(h.failures).toEqual([]);
    expect(h.calls.filter((call) => call === 'call:single-review-suite')).toHaveLength(2);
    expect(h.calls).toContain('call:development-remediation-dynamic');
    expect(h.calls.indexOf('call:development-remediation-dynamic')).toBeLessThan(h.calls.indexOf('commit_and_push'));
    const simpleSteps = vi.mocked(runAgent).mock.calls
      .filter(([, , options]) => ['single-review-suite', 'peer-review', 'development-remediation-dynamic']
        .includes(options?.workflowMeta?.workflowName ?? ''))
      .map(([, , options]) => options?.workflowMeta?.currentStep);
    expect(simpleSteps).toEqual(expect.arrayContaining([
      'review', 'review-adjudication', 'fix-plan', 'fix', 'final-gate',
    ]));
    expect(h.judgedSteps).not.toContain('fix-verifier');
    expect(h.simpleReviewPrompts).toHaveLength(2);
    expect(h.simpleReviewPrompts[0]).not.toContain(`${language === 'ja' ? '修正計画' : 'Repair plan'}:\nFix plan, implementation`);
    expect(h.simpleReviewPrompts[1]).toContain(`${language === 'ja' ? '修正計画' : 'Repair plan'}:\n`);
    expect(h.simpleReviewPrompts[1]).toContain(`${language === 'ja' ? '修正結果' : 'Repair result'}:\n`);
    expect(h.simpleReviewPrompts[1]).toContain('Fix plan, implementation, and validation evidence.');
    expect(h.judgedSteps.filter((step) => step === 'review-adjudication')).toHaveLength(2);
    expect(h.calls).toContain('commit_and_push');
    expect(h.calls).toContain('merge_pr');
  });

  it.each(['ja', 'en'] as const)('%sの並列レビューは修正後に同親の報告を参照できる', async (language) => {
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), `language: ${language}\n`);
    const workflow = loadWorkflowByIdentifier(
      join(process.cwd(), 'builtins', language, 'workflows', 'review-fix-backend.yaml'), project,
    );
    if (!workflow) throw new Error('Missing review-fix-backend workflow');
    const reviewCount = new Map<string, number>();
    const parallelReviewPrompts: string[] = [];
    vi.mocked(executeStructuredAgent).mockResolvedValue({
      persona: 'dynamic-facet-selector', status: 'done', content: '', timestamp: new Date(),
      structuredOutput: { selected_ids: [], rationale: 'No optional reviewer is needed.' },
    });
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: persona ?? 'agent', userInstruction: prompt });
      const step = options?.workflowMeta?.currentStep;
      if (step === 'arch-review' && options?.executionPhase === 1) {
        parallelReviewPrompts.push(prompt);
        const count = reviewCount.get(step) ?? 0;
        reviewCount.set(step, count + 1);
      }
      return { persona: persona ?? 'agent', status: 'done', content: `Report from ${step}`, timestamp: new Date() };
    });
    const engine = new WorkflowEngine(workflow, project, 'Review backend change', {
      provider: 'mock', language, projectCwd: project, reportDirName: 'parallel-review-report',
      selectorProvider: { provider: 'mock', model: 'mock' },
      selectorGitCommandRunner: { isInsideWorkTree: async () => false,
        run: async () => ({ output: Buffer.from(''), bytes: 0 }) },
      runPathsDirectory: join(project, '.takt', 'runs'),
      workflowCallResolver: (request) => resolveWorkflowCallTarget(
        request.parentWorkflow, request.step, request.projectCwd, request.lookupCwd,
      ),
      structuredCaller: {
        judgeStatus: vi.fn(async (instruction, _tagInstruction, _candidates, options) => {
          options.onStructuredPromptResolved?.({ systemPrompt: 'conductor', userInstruction: instruction });
          return {
            candidateIndex: options.stepName === 'supervise' ? 1
              : options.stepName === 'arch-review' && (reviewCount.get('arch-review') ?? 0) <= 2 ? 1 : 0,
            method: 'structured_output' as const,
          };
        }),
        evaluateCondition: vi.fn(), decomposeTask: vi.fn(), requestMoreParts: vi.fn(),
      },
    });
    const abortReasons: string[] = [];
    engine.on('workflow:abort', (_state, reason) => abortReasons.push(reason));
    expect((await engine.run()).status, `${abortReasons.join('; ')}; step=${engine.getState().currentStep}; reviews=${JSON.stringify([...reviewCount])}`).toBe('completed');
    expect(reviewCount.get('arch-review')).toBe(3);
    expect(parallelReviewPrompts[0]).not.toContain(`${language === 'ja' ? '修正計画' : 'Repair plan'}:\nReport from fix-plan`);
    expect(parallelReviewPrompts.slice(1).every((prompt) =>
      prompt.includes(`${language === 'ja' ? '修正計画' : 'Repair plan'}:\nReport from fix-plan`)
      && prompt.includes(`${language === 'ja' ? '修正結果' : 'Repair result'}:\nReport from fix`))).toBe(true);
  });

  it.each(['ja', 'en'] as const)('%sのsimpleは修正計画で対応不能ならpushしない', async (language) => {
    const h = harness('merge-review-fix-simple', { qualityFailed: true, cannotRemediate: true }, language);
    await h.engine.run();
    expect(h.judgedSteps).toContain('fix-plan');
    expect(h.calls).toContain('call:development-remediation-dynamic');
    expect(h.calls).not.toContain('commit_and_push');
    expect(h.calls).not.toContain('merge_pr');
  });

  it.each((['ja', 'en'] as const).flatMap((language) => [
    { language, scenario: { ciPassed: false }, reason: 'CI checks failed' },
    { language, scenario: { reviewDecision: 'CHANGES_REQUESTED' }, reason: 'CHANGES_REQUESTED' },
  ]))('$languageのsimpleは$reasonの場合mergeしない', async ({ language, scenario, reason }) => {
    const h = harness('merge-review-fix-simple', scenario, language);
    await h.engine.run();
    expect(h.failures).toEqual([]);
    expect(h.calls).not.toContain('merge_pr');
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toContain(reason);
  });

  it.each(['ja', 'en'].flatMap((language) => [
    { language, approved: true, reason: 'REASON_A', absentReason: 'REASON_B' },
    { language, approved: true, reason: 'REASON_B', absentReason: 'REASON_A' },
    { language, approved: false, reason: 'REASON_A', absentReason: 'REASON_B' },
  ]))('$languageのコメント専用builtinはapproved=$approvedと$reasonを対象PRへ反映する', async ({ language, approved, reason, absentReason }) => {
    const h = harness('merge-review', { ciRunning: true, approved, reason }, language);
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(0);
    const commentsBeforeCi = h.comments.length;
    h.finishCi();
    await vi.advanceTimersByTimeAsync(15_000);
    const state = await running;
    expect(h.failures).toEqual([]);
    expect(state.status).toBe('completed');
    expect(h.calls).toContain('call:review');
    expect(h.childContexts).toEqual([{ cwd: h.cloneCwd, projectCwd: project, prNumber: 123 }]);
    expect(commentsBeforeCi).toBe(0);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toContain(`approved=${approved}`);
    expect(h.comments[0]).not.toContain(`approved=${!approved}`);
    expect(h.comments[0]).toContain(reason);
    expect(h.comments[0]).not.toContain(absentReason);
    expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
      .toEqual([[expect.objectContaining({ type: 'comment_pr' }), expect.objectContaining({ pr: 123, body: h.comments[0] }), expect.anything()]]);
    expect(h.calls).not.toEqual(expect.arrayContaining(['merge_pr']));
    expect(h.calls.some((call) => ['commit_and_push', 'sync_with_root', 'resolve_conflicts_with_ai', 'close_pr'].includes(call))).toBe(false);
    expect(h.executeEffect.mock.calls.every(([, payload]) => payload.pr === 123)).toBe(true);
  });

  it.each(['ja', 'en'])('%sの修正builtinは子レビュー完了とpush後のCI通過後に追加AI判定なしでmergeする', async (language) => {
    const h = harness('merge-review-fix', { ciRunning: true }, language);
    const running = h.engine.run();
    await vi.advanceTimersByTimeAsync(0);
    const mergedBeforeCi = h.calls.includes('merge_pr');
    h.finishCi();
    await vi.advanceTimersByTimeAsync(15_000);
    await running;
    expect(mergedBeforeCi).toBe(false);
    expect(h.calls).toContain('call:review-fix');
    expect(h.childContexts).toEqual([{ cwd: h.cloneCwd, projectCwd: project, prNumber: 123 }]);
    expect(h.calls).toContain('sync_with_root');
    expect(h.calls).toContain('commit_and_push');
    expect(h.calls.indexOf('sync_with_root')).toBeLessThan(h.calls.indexOf('commit_and_push'));
    expect(h.calls.indexOf('call:review-fix')).toBeLessThan(h.calls.indexOf('commit_and_push'));
    expect(h.calls.indexOf('commit_and_push')).toBeLessThan(h.calls.indexOf('merge_pr'));
    expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(1);
    expect(h.observedStatuses).toContainEqual({ headSha: 'a'.repeat(40), finished: true, mergeable: 'MERGEABLE' });
    expect(h.observedStatuses).toContainEqual({ headSha: 'b'.repeat(40), finished: false, mergeable: 'MERGEABLE' });
    expect(h.observedStatuses.at(-1)).toEqual({ headSha: 'b'.repeat(40), finished: true, mergeable: 'MERGEABLE' });
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toMatch(/\bmerged\b/);
    expect(h.comments[0]).toContain('b'.repeat(40));
    expect(new Set(vi.mocked(runAgent).mock.calls.map(([persona]) => persona))).toEqual(new Set(['reviewer']));
    expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
      .toEqual([[expect.objectContaining({ type: 'comment_pr' }), expect.objectContaining({ pr: 123, body: h.comments[0] }), expect.anything()]]);
    expect(h.calls).not.toContain('close_pr');
  });

  it.each(['ja', 'en'])('%sの修正builtinはCHANGES_REQUESTEDならmergeしない', async (language) => {
    const h = harness('merge-review-fix', { reviewDecision: 'CHANGES_REQUESTED' }, language);
    await h.engine.run();
    expect(h.calls).not.toContain('merge_pr');
    expect(h.calls).toContain('comment_pr');
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toContain('approved=false');
    expect(h.comments[0]).toContain('CHANGES_REQUESTED');
    expect(h.comments[0]).not.toContain('approved=true');
  });

  it('同期失敗時は既存の競合解決effectで解決してからmergeする', async () => {
    const h = harness('merge-review-fix', { syncFailed: true });
    await h.engine.run();
    expect(h.calls).toContain('resolve_conflicts_with_ai');
    expect(h.calls.indexOf('resolve_conflicts_with_ai')).toBeLessThan(h.calls.indexOf('merge_pr'));
    expect(h.calls).toContain('merge_pr');
    expect(h.calls).not.toContain('close_pr');
  });

  it.each(['ja', 'en'].flatMap((language) => [123, 456].flatMap((prNumber) => [
    { language, prNumber, failure: '競合未解決', scenario: { syncFailed: true, conflictFailed: true }, reason: 'resolve_conflicts_with_ai rejected' },
    { language, prNumber, failure: 'push失敗', scenario: { pushFailed: true }, reason: 'commit_and_push rejected' },
  ])))('$languageの$failureではPR $prNumberへ理由をコメントしmerge/closeしない', async ({ language, prNumber, scenario, reason }) => {
    const h = harness('merge-review-fix', { ...scenario, prNumber }, language);
    await h.engine.run();
    expect(h.calls).not.toContain('merge_pr');
    expect(h.calls).not.toContain('close_pr');
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toContain(reason);
    expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
      .toEqual([[expect.objectContaining({ type: 'comment_pr' }), expect.objectContaining({ pr: prNumber, body: h.comments[0] }), expect.anything()]]);
  });

  describe.each(['ja', 'en'])('%sのCI理由コメント', (language) => {
    it.each(['merge-review', 'merge-review-fix'])('%sはCI失敗理由を対象PRへ投稿する', async (name) => {
      const h = harness(name, { ciPassed: false }, language);
      await h.engine.run();
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]).toContain('CI checks failed');
      expect(h.comments[0]).not.toContain('waiting for CI exceeded');
      expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
        .toEqual([[expect.objectContaining({ type: 'comment_pr' }), expect.objectContaining({ pr: 123, body: h.comments[0] }), expect.anything()]]);
      expect(h.calls).not.toContain('merge_pr');
      expect(h.calls).not.toContain('close_pr');
    });

    it.each(['merge-review', 'merge-review-fix'])('%sはCI待機上限超過の理由を対象PRへ投稿する', async (name) => {
      const h = harness(name, { ciRunning: true }, language);
      const running = h.engine.run();
      await vi.advanceTimersByTimeAsync(1_800_000);
      await running;
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]).toContain('waiting for CI exceeded');
      expect(h.comments[0]).not.toContain('CI checks failed');
      expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
        .toEqual([[expect.objectContaining({ type: 'comment_pr' }), expect.objectContaining({ pr: 123, body: h.comments[0] }), expect.anything()]]);
      expect(h.calls).not.toContain('merge_pr');
      expect(h.calls).not.toContain('close_pr');
    });
  });

  it.each(['ja', 'en'].flatMap((language) => [123, 456].map((prNumber) => ({ language, prNumber }))))(
    '$languageのmerge失敗ではPR $prNumberへ理由をコメントしcloseしない', async ({ language, prNumber }) => {
      const h = harness('merge-review-fix', { mergeFailed: true, prNumber }, language);
      await h.engine.run();
      expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(1);
      expect(h.calls.at(-1)).toBe('comment_pr');
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]).toContain('merge_pr rejected');
      expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
        .toEqual([[expect.objectContaining({ type: 'comment_pr' }), expect.objectContaining({ pr: prNumber, body: h.comments[0] }), expect.anything()]]);
      expect(h.calls).not.toContain('close_pr');
    });
});
