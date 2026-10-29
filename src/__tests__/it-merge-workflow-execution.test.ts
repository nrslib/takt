import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEffect, WorkflowState, WorkflowStep } from '../core/models/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import type { WorkflowCallResolutionRequest } from '../core/workflow/types.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import { cacciaEffect } from '../features/caccia/system-effect.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { buildEditRule } from '../core/workflow/instruction/instruction-context.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { runPrCommand } from '../infra/github/pr-command.js';
import { marked } from 'marked';
import { syncWithRootEffect, resolveConflictsWithAiEffect } from '../infra/workflow/system/system-sync-effects.js';
import { executeTaskWorkflow } from '../features/tasks/execute/taskWorkflowExecution.js';
import { buildRunPaths } from '../core/workflow/run/run-paths.js';
import { isRealPathInside } from '../shared/utils/pathBoundary.js';

vi.mock('../infra/workflow/system/system-sync-effects.js', () => ({
  syncWithRootEffect: vi.fn(), resolveConflictsWithAiEffect: vi.fn(),
}));

vi.mock('../infra/github/pr-command.js', () => ({ runPrCommand: vi.fn() }));

const cacciaGit = vi.hoisted(() => vi.fn());
vi.mock('../infra/task/clone-exec.js', async (original) => ({
  ...await original<typeof import('../infra/task/clone-exec.js')>(), runGitCommandAbortable: cacciaGit,
}));
vi.mock('../infra/task/git-environment.js', async (original) => ({
  ...await original<typeof import('../infra/task/git-environment.js')>(),
  buildSafeGitEnvironment: vi.fn(async () => ({})),
}));

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../agents/structured-caller/transport.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agents/structured-caller/transport.js')>(),
  executeStructuredAgent: vi.fn(),
}));
import { runAgent } from '../agents/runner.js';
import { executeStructuredAgent } from '../agents/structured-caller/transport.js';

interface Scenario {
  concurrency?: number;
  lateConflicts?: number;
  resyncConflicted?: boolean;
  resyncFailure?: 'sync' | 'resolve' | 'push';
  mergeable?: string;
  mergeStateStatus?: string;
  ciFailsAfterResync?: boolean;
  fullInitialReview?: boolean;
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
  caccia?: Record<string, unknown>;
  cacciaError?: Error;
  ciFailures?: Array<{ verdict: 'defect' | 'external' | 'insufficient_evidence'; summary: string }>;
  rerunFails?: boolean;
  rerunFailure?: { verdict: 'defect' | 'external' | 'insufficient_evidence'; summary: string };
  recoveryReviewRejects?: boolean;
  commentFails?: boolean;
  recoveredMergeable?: string;
  headChangesDuringInvestigation?: boolean;
  ciSucceedsDuringInvestigation?: boolean;
  headChangesDuringRunValidation?: boolean;
  recoveryPushFails?: boolean;
  ciName?: { field: 'check' | 'job' | 'unavailable'; value: string };
  largeCiLogs?: boolean;
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

  function nextStepStart(engine: WorkflowEngine, name: string, occurrence = 1): Promise<void> {
    return new Promise((resolve) => {
      const onStart = (step: WorkflowStep) => {
        if (step.name !== name) return;
        occurrence--;
        if (occurrence > 0) return;
        engine.off('step:start', onStart);
        resolve();
      };
      engine.on('step:start', onStart);
    });
  }

  function nextStepComplete(engine: WorkflowEngine, name: string): Promise<void> {
    return new Promise((resolve) => {
      const onComplete = (step: WorkflowStep) => {
        if (step.name !== name) return;
        engine.off('step:complete', onComplete);
        resolve();
      };
      engine.on('step:complete', onComplete);
    });
  }

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
    const actualReview = simple || scenario.fullInitialReview === true;
    mkdirSync(join(project, '.takt'), { recursive: true });
    writeFileSync(join(project, '.takt', 'config.yaml'), `language: ${language}\n`);
    const prNumber = scenario.prNumber ?? 123;
    const workflow = loadWorkflowByIdentifier(join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`), project);
    if (!workflow) throw new Error(`Missing builtin workflow: ${name}`);
    let ciFinished = scenario.ciRunning !== true || name !== 'merge-review';
    let ciRecovered = false;
    let headSha = 'a'.repeat(40);
    let conflictsResolved = false;
    let pushes = 0;
    let syncs = 0;
    let reruns = 0;
    let rerunAttempt = 1;
    let rerunStatus = 'completed';
    let rerunConclusion = 'failure';
    let remoteHeadOverride: string | undefined;
    const calls: string[] = [];
    const judgedSteps: string[] = [];
    const comments: string[] = [];
    const failures: string[] = [];
    const taskEntryStates: WorkflowState[] = [];
    const observedStatuses: Array<{ headSha: string; finished: boolean; mergeable: string }> = [];
    const childContexts: Array<{ cwd: string; projectCwd: string; prNumber: number | undefined }> = [];
    const simpleReviewPrompts: string[] = [];
    const recoveryPrompts: Array<{ step: string; prompt: string; requiredPermissionMode: string | undefined; cwd: string | undefined }> = [];
    const cloneCwd = join(project, 'clone');
    mkdirSync(cloneCwd);
    if (scenario.largeCiLogs) execFileSync('git', ['init', '-q'], { cwd: cloneCwd });
    const reportDirectory = join(project, '.takt', 'runs', 'merge-workflow-report', 'reports');
    const decision = { approved: scenario.approved !== false,
      reason: scenario.reason ?? (scenario.approved === false ? 'AI denied this PR' : 'AI approved this PR') };
    let reviewCount = 0;
    const currentFailure = () => reruns > 0 && scenario.rerunFailure !== undefined
      ? scenario.rerunFailure
      : scenario.ciFailures?.[Math.min(Math.max(pushes - 1, 0), scenario.ciFailures.length - 1)];
    vi.mocked(executeStructuredAgent).mockImplementation(async (_prompt, _schema, options) => ({ persona: 'dynamic-facet-selector',
      status: 'done', content: '', timestamp: new Date(),
      structuredOutput: { selected_ids: [options.name === 'dynamic-parallel-selector' ? 'backend-review' : 'backend'],
        rationale: 'Review the changed backend path.' } }));
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'supervisor', userInstruction: prompt });
      const step = options?.workflowMeta?.currentStep;
      if (['investigate_ci', 'fix_ci', 'review_ci_fix'].includes(step ?? '')) {
        if (options?.executionPhase === 1) {
          calls.push(`agent:${step}`);
          if (step === 'investigate_ci' && scenario.headChangesDuringInvestigation) remoteHeadOverride = 'f'.repeat(40);
          if (step === 'investigate_ci' && scenario.ciSucceedsDuringInvestigation) ciRecovered = true;
          recoveryPrompts.push({ step: step!, prompt,
            requiredPermissionMode: options.permissionResolution?.requiredPermissionMode, cwd: options.cwd });
        }
        const failure = currentFailure();
        if (!failure) throw new Error('Unexpected CI recovery without a failed CI fixture');
        return { persona: persona ?? 'coder', status: 'done', timestamp: new Date(),
          content: `${failure.summary}\nLocation: repository tests. Fix appropriateness: address the demonstrated cause.`,
          ...(step === 'investigate_ci' ? { structuredOutput: failure }
            : step === 'review_ci_fix' ? { structuredOutput: { result: scenario.recoveryReviewRejects ? 'REJECT' : 'APPROVE' } } : {}),
        };
      }
      if (actualReview && options?.workflowMeta?.currentStep === 'gather') {
        return { persona: persona ?? 'planner', status: 'done', content: 'GATHERED_CONTEXT: backend change in PR.', timestamp: new Date() };
      }
      if (scenario.fullInitialReview && options?.workflowMeta?.workflowName === 'development-review') {
        return { persona: persona ?? 'reviewer', status: 'done', timestamp: new Date(),
          content: 'CHILD_REVIEW_REPORT: no actionable defects in the cumulative diff.' };
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
      if (actualReview && options?.workflowMeta?.workflowName === 'peer-review') {
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
      return actualReview ? resolveWorkflowCallTarget(request.parentWorkflow, step, request.projectCwd, request.lookupCwd) : child;
    });
    const currentPrStatus = () => {
      const remoteHeadSha = remoteHeadOverride ?? (scenario.prePushRemoteHeadDiffers && headSha === 'a'.repeat(40)
        ? 'c'.repeat(40) : headSha);
      const mergeable = (scenario.syncFailed && !conflictsResolved)
        || (scenario.prePushRemoteConflicting && headSha === 'a'.repeat(40))
        || (pushes > 0 && syncs <= (scenario.lateConflicts ?? 0)) ? 'CONFLICTING' : scenario.mergeable ?? 'MERGEABLE';
      observedStatuses.push({ headSha: remoteHeadSha, finished: ciFinished, mergeable });
      return { exists: true, number: prNumber, headSha: remoteHeadSha, branch: 'feature/pr', baseBranch: 'main',
        ci: { finished: ciFinished,
          passed: ciFinished && !(scenario.ciFailsAfterResync && syncs > 1) && scenario.ciPassed !== false && (ciRecovered || scenario.ciFailures === undefined
            || (reruns > 0 ? rerunConclusion === 'success' : pushes > scenario.ciFailures.length)) },
        mergeable: pushes > 1 && scenario.recoveredMergeable ? scenario.recoveredMergeable : mergeable,
        mergeStateStatus: scenario.mergeStateStatus ?? 'CLEAN',
        reviewDecision: scenario.reviewDecision ?? 'APPROVED', merged: false };
    };
    vi.mocked(runPrCommand).mockImplementation(async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        const status = currentPrStatus();
        return JSON.stringify({ number: prNumber, headRefOid: status.headSha, state: 'OPEN',
          mergeable: status.mergeable, mergeStateStatus: status.mergeStateStatus, reviewDecision: status.reviewDecision,
          statusCheckRollup: [{ __typename: 'CheckRun', name: `unit-round-${pushes}`,
            detailsUrl: `https://github.com/org/repo/actions/runs/${10 + pushes}`,
            status: status.ci.finished ? 'COMPLETED' : 'IN_PROGRESS',
            conclusion: status.ci.passed ? 'SUCCESS' : 'FAILURE' }] });
      }
      if (args[0] === 'run' && args[1] === 'view') {
        if (scenario.headChangesDuringRunValidation) remoteHeadOverride = 'f'.repeat(40);
        return JSON.stringify({ databaseId: 10 + pushes, url: `https://github.com/org/repo/actions/runs/${10 + pushes}`,
          headSha, attempt: rerunAttempt, status: rerunStatus, conclusion: rerunConclusion, jobs: [] });
      }
      if (args[0] === 'run' && args[1] === 'rerun') {
        expect(args[2]).toBe(String(10 + pushes));
        reruns++;
        return '';
      }
      throw new Error(`Unexpected PR command: ${args.join(' ')}`);
    });
    const resolveSystemInput = vi.fn((input: NonNullable<WorkflowStep['systemInputs']>[number]) => {
      if (input.type === 'task_context') return { exists: true, body: `Review PR ${prNumber}` };
      if (input.type === 'branch_context') return { exists: true, name: 'feature/pr' };
      return currentPrStatus();
    });
    const executeEffect = vi.fn(async (effect: WorkflowEffect, payload: Record<string, unknown>, state: WorkflowState) => {
      calls.push(effect.type);
      if (effect.type === 'sync_with_root' || effect.type === 'resolve_conflicts_with_ai') {
        return recoveryServices.executeEffect(effect, payload, state);
      }
      if (String(effect.type) === 'caccia') {
        if (scenario.cacciaError) {
          cacciaGit.mockRejectedValueOnce(scenario.cacciaError);
          return cacciaEffect({ cwd: cloneCwd, projectCwd: project, task: 'Review PR',
            prExecutionContext: { prNumber, headBranch: 'feature/pr', baseBranch: 'main',
              headSha, headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'] } }, prNumber);
        }
        const result = scenario.caccia ?? { success: true, failed: false, outcome: 'skipped',
          headSha, unresolvedCount: 0, skipReason: 'config_disabled', reason: 'Caccia is disabled' };
        if (typeof result.headSha === 'string') headSha = result.headSha;
        return result;
      }
      if (effect.type === 'comment_pr') {
        return recoveryServices.executeEffect(effect, payload, state);
      }
      const failed = (String(effect.type) === 'commit_and_push' && scenario.pushFailed)
        || (String(effect.type) === 'commit_and_push' && scenario.recoveryPushFails && pushes > 0)
        || (String(effect.type) === 'commit_and_push' && scenario.resyncFailure === 'push' && syncs > 1)
        || (effect.type === 'merge_pr' && scenario.mergeFailed);
      if (String(effect.type) === 'commit_and_push' && !failed) {
        pushes++;
        headSha = pushes < 6 ? (10 + pushes).toString(16).repeat(40) : pushes.toString(16).padStart(40, '0');
        ciFinished = scenario.ciRunning !== true;
      }
      return { success: !failed, failed: Boolean(failed),
        ...(String(effect.type) === 'commit_and_push' && !failed ? { headSha } : {}),
        ...(failed ? { error: `${effect.type} rejected` } : {}) };
    });
    vi.mocked(syncWithRootEffect).mockImplementation(async () => {
      syncs++;
      if (syncs > 1 && scenario.resyncFailure === 'sync') {
        return { success: false, failed: true, conflicted: false, error: 'sync_with_root rejected' };
      }
      const conflicted = syncs === 1 ? scenario.syncFailed === true : scenario.resyncConflicted === true;
      return { success: !conflicted, failed: false, conflicted };
    });
    vi.mocked(resolveConflictsWithAiEffect).mockImplementation(async () => {
      const failed = scenario.conflictFailed === true || (syncs > 1 && scenario.resyncFailure === 'resolve');
      if (!failed) conflictsResolved = true;
      return { success: !failed, failed, conflicted: failed,
        ...(failed ? { error: 'resolve_conflicts_with_ai rejected' } : {}) };
    });
    const fetchPrCiFailure = vi.fn(async (number: number, expectedHead: string) => {
      expect(number).toBe(prNumber);
      expect(expectedHead).toBe(headSha);
      calls.push('fetch_ci_failure');
      const complete = currentFailure()?.verdict !== 'insufficient_evidence';
      const jobs = scenario.largeCiLogs
        ? Array.from({ length: 6 }, (_, index) => ({ id: 20 + index, name: `job-${index}`,
          url: `https://github.com/org/repo/actions/runs/${10 + pushes}/job/${20 + index}`,
          log: `CI_LOG_${index}\n${'x'.repeat(199_980)}` }))
        : [{ id: 20 + pushes, name: scenario.ciName?.field === 'job' ? scenario.ciName.value : 'unit',
          url: `https://github.com/org/repo/actions/runs/${10 + pushes}/job/${20 + pushes}`,
          log: complete ? `round-${pushes}.test.ts > adds\nexpected ${pushes} to equal 3` : '' }];
      const check = { name: scenario.ciName?.field === 'check' ? scenario.ciName.value : `unit-round-${pushes}`,
        run: { id: 10 + pushes, attempt: reruns + 1, headSha, url: `https://github.com/org/repo/actions/runs/${10 + pushes}` },
        jobs };
      return { number, headSha, complete, checks: scenario.largeCiLogs ? [check, { ...check, name: 'second-check' }] : [check],
        unavailable: complete ? [] : [{ name: scenario.ciName?.field === 'unavailable' ? scenario.ciName.value : `unit-round-${pushes}`, reason: 'HTTP 403: cannot read logs' }] };
    });
    const githubProvider = new GitHubProvider();
    const rerunPrCi = vi.fn(githubProvider.rerunPrCi.bind(githubProvider));
    const recoveryServices = createDefaultSystemStepServices({ cwd: cloneCwd, projectCwd: project, task: 'Review PR',
      runPaths: buildRunPaths(project, 'merge-workflow-report'),
      prExecutionContext: { prNumber, headBranch: 'feature/pr', baseBranch: 'main', headSha: 'a'.repeat(40),
        headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'],
        ...{ mergeConcurrency: scenario.concurrency ?? 2 } },
      gitProvider: { checkCliStatus: vi.fn(), fetchIssue: vi.fn(), createIssue: vi.fn(), closeIssue: vi.fn(),
        fetchPrReviewComments: vi.fn(), listOpenIssues: vi.fn(), listOpenPrs: vi.fn(), findExistingPr: vi.fn(),
        commentOnPr: vi.fn((_pr, body: string) => {
          comments.push(body);
          return scenario.commentFails ? { success: false, error: 'comment denied' } : { success: true };
        }), closePr: vi.fn(), mergePr: vi.fn(), ...{ fetchPrCiFailure, rerunPrCi },
        fetchPrStatus: githubProvider.fetchPrStatus.bind(githubProvider),
      },
    });
    const engineOptions: ConstructorParameters<typeof WorkflowEngine>[3] = {
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
        if (actualReview) {
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
        resolveSystemInput: (input, state, stepName, resolutionContext) => {
          if (stepName === 'report_review') {
            const context = (options as unknown as { prExecutionContext?: { prNumber: number } }).prExecutionContext;
            childContexts.push({ cwd: options.cwd, projectCwd: options.projectCwd, prNumber: context?.prNumber });
          }
          if (name !== 'merge-review' && !['task_context', 'branch_context'].includes(input.type)) {
            return recoveryServices.resolveSystemInput(input, state, stepName, resolutionContext);
          }
          return resolveSystemInput(input);
        },
        executeEffect: (effect, payload, state: WorkflowState) => {
          if (String(effect.type) === 'rerun_ci') {
            calls.push(effect.type);
            return recoveryServices.executeEffect(effect, payload, state);
          }
          return executeEffect(effect, payload, state);
        },
      }),
    };
    const engine = new WorkflowEngine(workflow, cloneCwd, `Review PR ${prNumber}`, engineOptions);
    engine.on('workflow:abort', (_state, reason) => failures.push(reason));
    return { engine, workflow, calls, judgedSteps, comments, failures, observedStatuses, childContexts, cloneCwd,
      executeEffect, simpleReviewPrompts, recoveryPrompts, reportDirectory, fetchPrCiFailure, rerunPrCi,
      taskEntryStates,
      runFromTaskEntry: (workflowIdentifier: string) => executeTaskWorkflow({
        cwd: cloneCwd, projectCwd: project, workflowIdentifier, task: 'Review PR', outputMode: 'silent',
        prExecutionContext: { prNumber, headBranch: 'feature/pr', baseBranch: 'main', headSha,
          headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'],
          ...{ mergeConcurrency: scenario.concurrency ?? 2 } },
      }, async (config, task, cwd, options) => {
        const taskEngine = new WorkflowEngine(config, cwd, task, { ...engineOptions, maxStepsOverride: options.maxStepsOverride });
        const state = await taskEngine.run();
        taskEntryStates.push(state);
        return { success: state.status === 'completed' };
      }),
      setRemoteHead: (value: string) => { remoteHeadOverride = value; },
      setRerun: (attempt: number, status: string, conclusion: string) => {
        rerunAttempt = attempt;
        rerunStatus = status;
        rerunConclusion = conclusion;
      },
      finishCi: () => { ciFinished = true; } };
  }

  describe.each((['ja', 'en'] as const).flatMap((language) =>
    ['merge-review-fix', 'merge-review-fix-simple'].map((name) => ({ language, name })),
  ))('$languageの$nameの後発競合', ({ language, name }) => {
    const reviewCall = `call:${name === 'merge-review-fix' ? 'review-fix' : 'review-fix-simple'}`;

    it.each([false, true])('取り込み直しの競合=%sでもレビューを繰り返さずpush後の新HEADのCIを待ってマージする', async (resyncConflicted) => {
      const h = harness(name, { lateConflicts: 1, resyncConflicted, ciRunning: true }, language);
      const firstCiWait = nextStepStart(h.engine, 'wait_ci');
      const running = h.engine.run();
      await firstCiWait;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.engine.getState().systemContexts.get('wait_ci')?.status)
        .toMatchObject({ headSha: 'b'.repeat(40), ci: { finished: false } });
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(1);
      expect(h.calls).not.toContain('merge_pr');
      const secondCiWait = nextStepStart(h.engine, 'wait_ci');
      h.finishCi();
      await vi.advanceTimersByTimeAsync(15_000);
      await secondCiWait;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.engine.getState().systemContexts.get('wait_ci')?.status)
        .toMatchObject({ headSha: 'c'.repeat(40), ci: { finished: false } });
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(2);
      expect(h.calls.filter((call) => call === reviewCall)).toHaveLength(1);
      expect(h.calls.filter((call) => call === 'resolve_conflicts_with_ai')).toHaveLength(resyncConflicted ? 1 : 0);
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(2);
      expect(h.calls.filter((call) => call === 'caccia')).toHaveLength(2);
      expect(h.calls.lastIndexOf('sync_with_root')).toBeLessThan(h.calls.lastIndexOf('commit_and_push'));
      expect(h.calls.lastIndexOf('commit_and_push')).toBeLessThan(h.calls.lastIndexOf('caccia'));
      expect(h.observedStatuses.at(-1)).toMatchObject({ headSha: 'c'.repeat(40), finished: false });
      expect(h.calls).not.toContain('merge_pr');
      expect(h.comments).toEqual([]);
      h.finishCi();
      await vi.advanceTimersByTimeAsync(15_000);
      const state = await running;
      expect(state.status).toBe('completed');
      expect(h.failures).toEqual([]);
      expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(1);
      expect(h.calls.lastIndexOf('caccia')).toBeLessThan(h.calls.indexOf('merge_pr'));
      expect(h.comments[0]).toContain('c'.repeat(40));
    });

    it.each([
      { concurrency: 2, limit: 2, syncFailed: false },
      { concurrency: 3, limit: 2, syncFailed: false },
      { concurrency: 4, limit: 3, syncFailed: false },
      { concurrency: 2, limit: 2, syncFailed: true },
    ])('並列数$concurrencyで初回競合=$syncFailedの同期を回数に含めず$limit回取り込み直して停止する', async ({ concurrency, limit, syncFailed }) => {
      const h = harness(name, { concurrency, syncFailed, lateConflicts: 100, resyncConflicted: true }, language);
      const state = await h.engine.run();
      expect(state.status).toBe('completed');
      expect(h.failures).toEqual([]);
      expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(1 + limit);
      expect(h.calls.filter((call) => call === 'resolve_conflicts_with_ai')).toHaveLength(limit + Number(syncFailed));
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(1 + limit);
      expect(h.calls.filter((call) => call === 'caccia')).toHaveLength(1 + limit);
      expect(h.calls.filter((call) => call === reviewCall)).toHaveLength(1);
      expect(h.calls).not.toContain('merge_pr');
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]).toContain('CONFLICTING');
    });

    it.each([{ concurrency: 2, limit: 2 }, { concurrency: 3, limit: 2 }, { concurrency: 4, limit: 3 }])(
      '並列数$concurrencyで最後の取り込み直し$limit回目に競合がなくなればマージする', async ({ concurrency, limit }) => {
        const h = harness(name, { concurrency, lateConflicts: limit, resyncConflicted: true }, language);
        expect((await h.engine.run()).status).toBe('completed');
        expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(1 + limit);
        expect(h.calls.filter((call) => call === reviewCall)).toHaveLength(1);
        expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(1);
        expect(h.comments).toHaveLength(1);
        expect(h.comments[0]).toMatch(/\bmerged\b/);
      },
    );

    it.each([
      { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', merges: 1 },
      { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', reviewDecision: 'APPROVED', merges: 1 },
      { mergeable: 'BEHIND', mergeStateStatus: 'BEHIND', reviewDecision: 'APPROVED', merges: 1 },
      { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: 'APPROVED', merges: 0 },
      { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', reviewDecision: 'CHANGES_REQUESTED', merges: 0 },
      { mergeable: 'BEHIND', mergeStateStatus: 'BEHIND', reviewDecision: 'CHANGES_REQUESTED', merges: 0 },
    ])('$mergeable/$mergeStateStatusの$reviewDecisionでは取り込み直さず既存のマージ条件を守る', async ({ mergeable, mergeStateStatus, reviewDecision, merges }) => {
      const h = harness(name, { mergeable, mergeStateStatus, reviewDecision }, language);
      expect((await h.engine.run()).status).toBe('completed');
      expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(1);
      expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(merges);
    });

    it.each(['sync', 'resolve', 'push'] as const)('取り込み直しの%s失敗は理由をコメントしてマージしない', async (resyncFailure) => {
      const h = harness(name, { lateConflicts: 1, resyncConflicted: true, resyncFailure }, language);
      const state = await h.engine.run();
      expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(2);
      expect(state.status).toBe('completed');
      expect(h.calls.filter((call) => call === reviewCall)).toHaveLength(1);
      expect(h.calls.filter((call) => call === 'caccia')).toHaveLength(1);
      expect(h.calls).not.toContain('merge_pr');
      expect(h.comments).toHaveLength(1);
      const operation = { sync: 'sync_with_root', resolve: 'resolve_conflicts_with_ai', push: 'commit_and_push' }[resyncFailure];
      expect(h.comments[0]).toContain(`${operation} rejected`);
    });

    it.each([false, true])('CI再実行成功後の競合は新HEADのCI失敗=%sに従い使用済み再実行予算を保持する', async (ciFailsAfterResync) => {
      const h = harness(name, { lateConflicts: 1, ciFailures: [{ verdict: 'external', summary: 'Runner outage' }],
        ciRunning: false, ciFailsAfterResync }, language);
      const rerunCiWait = nextStepStart(h.engine, 'wait_ci', 2);
      const running = h.engine.run();
      await rerunCiWait;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.rerunPrCi).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      h.setRerun(2, 'completed', 'success');
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await running).status).toBe(ciFailsAfterResync ? 'aborted' : 'completed');
      expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(2);
      expect(h.fetchPrCiFailure.mock.calls.map(([, head]) => head))
        .toEqual((ciFailsAfterResync ? ['b', 'c'] : ['b']).map((char) => char.repeat(40)));
      expect(h.rerunPrCi).toHaveBeenCalledOnce();
      expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(ciFailsAfterResync ? 0 : 1);
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]).toContain(ciFailsAfterResync ? 'unit-round-2' : 'c'.repeat(40));
    });

    it('大きい並列数でも実行入口の予算で上限まで取り込み直してコメントへ到達する', async () => {
      const h = harness(name, { concurrency: 20, lateConflicts: 100, resyncConflicted: true }, language);
      const result = await h.runFromTaskEntry(join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`));
      expect(result.success).toBe(true);
      expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(20);
      expect(h.calls.filter((call) => call === reviewCall)).toHaveLength(1);
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]).toContain('CONFLICTING');
      expect(h.calls).not.toContain('merge_pr');
    });

    it('同名の利用者workflowにはbuiltin用の追加予算を適用しない', async () => {
      const h = harness(name, { concurrency: 20 }, language);
      const customPath = join(project, `${name}.yaml`);
      writeFileSync(customPath, `name: ${name}\nmax_steps: 3\ninitial_step: loop\nsteps:\n  - name: loop\n    mode: system\n    rules:\n      - condition: when(true)\n        next: loop\n`);
      expect((await h.runFromTaskEntry(customPath)).success).toBe(false);
      expect(h.taskEntryStates[0]?.iteration).toBe(3);
      expect(h.calls).not.toContain('sync_with_root');
      expect(h.calls).not.toContain('merge_pr');
    });
  });

  describe.each(['ja', 'en'])('%sのCaccia結果による分岐', (language) => {
    describe.each(['merge-review', 'merge-review-fix', 'merge-review-fix-simple'])('%s', (name) => {
      it.each(['success', 'skipped'] as const)('%sのheadでCIを待って既存の終端まで進む', async (outcome) => {
        const updatedHead = 'd'.repeat(40);
        const h = harness(name, { ciRunning: true, caccia: {
          success: true, failed: false, outcome, headSha: updatedHead, unresolvedCount: 0,
          skipReason: outcome === 'skipped' ? 'review_rate_limited' : null,
          reason: outcome === 'skipped' ? 'Review rate limited after push' : null,
        } }, language);
        const ciWait = nextStepStart(h.engine, 'wait_ci');
        const running = h.engine.run();
        await ciWait;
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        expect(h.calls.filter((call) => call === 'caccia')).toHaveLength(1);
        expect(h.calls).not.toContain('merge_pr');
        expect(h.comments).toEqual([]);
        h.finishCi();
        await vi.advanceTimersByTimeAsync(15_000);
        expect((await running).status).toBe('completed');
        expect(h.failures).toEqual([]);
        expect(h.observedStatuses.at(-1)?.headSha).toBe(updatedHead);
        expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(name === 'merge-review' ? 0 : 1);
        if (name !== 'merge-review') {
          expect(h.calls.indexOf('commit_and_push')).toBeLessThan(h.calls.indexOf('caccia'));
          expect(h.calls.indexOf('caccia')).toBeLessThan(h.calls.indexOf('merge_pr'));
        }
        expect(h.judgedSteps).not.toContain('caccia');
        expect(h.executeEffect.mock.calls.filter(([effect]) => String(effect.type) === 'caccia'))
          .toEqual([[expect.objectContaining({ type: 'caccia' }), { type: 'caccia', pr: 123 }, expect.anything()]]);
      });

      it.each([3, 11])('上限到達では未解決%s件をPRへコメントしてマージせずCOMPLETEになる', async (unresolvedCount) => {
        const h = harness(name, { caccia: { success: true, failed: false, outcome: 'limit',
          unresolvedCount, headSha: 'b'.repeat(40), skipReason: null, reason: null } }, language);
        const state = await h.engine.run();
        expect(state.status).toBe('completed');
        expect(h.calls.filter((call) => call === 'caccia')).toHaveLength(1);
        expect(h.calls).not.toContain('merge_pr');
        expect(h.comments).toHaveLength(1);
        const counts = h.comments[0]!.match(/\d+/gu)?.map(Number);
        expect(counts).toEqual([unresolvedCount]);
        expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
          .toEqual([[expect.anything(), expect.objectContaining({ pr: 123, body: h.comments[0] }), expect.anything()]]);
      });

      it.each(['feature/team', '@org/team'])('効果の公開エラーを安全なコメントへ渡す: %s', async (ref) => {
        const h = harness(name, { cacciaError: new Error(`fatal: couldn't find remote ref ${ref}; contact @reviewer`) }, language);
        const state = await h.engine.run();
        expect(state.status).toBe('aborted');
        expect(h.calls).not.toContain('merge_pr');
        expect(h.comments).toHaveLength(1);
        const body = h.comments[0]!;
        expect(body).toContain('remote ref');
        expect(body).toContain(ref.replaceAll('@', '＠'));
        expect(body).not.toContain('@');
      });

      it('失敗内容をPRへコメントしてマージせずABORTになる', async () => {
        const error = 'Pull request head changed during Caccia execution';
        const h = harness(name, { caccia: { success: false, failed: true, error } }, language);
        const state = await h.engine.run();
        expect(state.status).toBe('aborted');
        expect(h.calls.filter((call) => call === 'caccia')).toHaveLength(1);
        expect(h.calls).not.toContain('merge_pr');
        expect(h.comments).toHaveLength(1);
        expect(h.comments[0]).toContain(error);
        expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
          .toEqual([[expect.anything(), expect.objectContaining({ pr: 123, body: h.comments[0] }), expect.anything()]]);
      });
    });
  });

  it.each(['ja', 'en'] as const)('%sのsimpleは単体レビューと共通最終ゲートを経てpush後のCIを待ってmergeする', async (language) => {
    const h = harness('merge-review-fix-simple', { ciRunning: true, syncFailed: true }, language);
    const ciWait = nextStepStart(h.engine, 'wait_ci');
    const running = h.engine.run();
    await ciWait;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
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
      'review', 'review-adjudication', 'fix-plan', 'fix', 'fix-verifier', 'final-gate',
    ]));
    expect(h.judgedSteps).toContain('fix-verifier');
    expect(h.simpleReviewPrompts).toHaveLength(2);
    expect(h.simpleReviewPrompts[0]).not.toContain('### remediation: fix-plan.md');
    for (const reportName of ['fix-plan.md', 'fix-report.md', 'fix-verification.md']) {
      expect(h.simpleReviewPrompts[1]).toContain(
        `### remediation: ${reportName}\nFix plan, implementation, and validation evidence.`,
      );
    }
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
    expect(parallelReviewPrompts[0]).not.toContain('### remediation: fix-plan.md');
    for (const prompt of parallelReviewPrompts.slice(1)) {
      expect(prompt).toContain('### remediation: fix-plan.md\nReport from fix-plan');
      expect(prompt).toContain('### remediation: fix-report.md\nReport from fix');
      expect(prompt).toContain('### remediation: fix-verification.md\nReport from fix-verifier');
    }
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
    const ciWait = nextStepStart(h.engine, 'wait_ci');
    const running = h.engine.run();
    await ciWait;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
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
    const ciWait = nextStepStart(h.engine, 'wait_ci');
    const running = h.engine.run();
    await ciWait;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
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
    it.each(['merge-review'])('%sはCI失敗理由を対象PRへ投稿する', async (name) => {
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
      const ciWait = nextStepStart(h.engine, 'wait_ci');
      const running = h.engine.run();
      await ciWait;
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
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

  describe.each((['ja', 'en'] as const).flatMap((language) =>
    ['merge-review-fix', 'merge-review-fix-simple'].map((name) => ({ language, name })),
  ))('$languageの$nameのCI回復', ({ language, name }) => {
    const defect = (summary = 'Clock-dependent assertion fails because elapsed time is not controlled') => ({
      verdict: 'defect' as const, summary,
    });
    const external = { verdict: 'external' as const, summary: 'GitHub Actions runner outage confirmed by job log' };

    async function runRecovery(scenario: Scenario) {
      const h = harness(name, scenario, language);
      const rerunComplete = nextStepComplete(h.engine, 'rerun_ci');
      const firstExternalIndex = scenario.ciFailures?.findIndex(({ verdict }) => verdict === 'external') ?? -1;
      const rerunCiWait = nextStepStart(h.engine, 'wait_ci', 2 + Math.max(0, firstExternalIndex));
      const running = h.engine.run();
      const reachedRerun = await Promise.race([rerunComplete.then(() => true), running.then(() => false)]);
      if (reachedRerun && (h.engine.getState().effectResults.get('rerun_ci')?.rerun_ci as { success?: boolean })?.success) {
        await rerunCiWait;
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        h.setRerun(2, 'completed', scenario.rerunFails ? 'failure' : 'success');
        await vi.advanceTimersByTimeAsync(45_000);
      }
      const state = await running;
      expect(h.failures.every((reason) => !/iteration.limit|maximum.*steps/i.test(reason))).toBe(true);
      expect(typeof h.workflow.maxSteps).toBe('number');
      expect(state.iteration).toBeLessThanOrEqual(h.workflow.maxSteps as number);
      return { ...h, state };
    }

    function reports(directory: string) {
      return readdirSync(directory, { recursive: true, encoding: 'utf8' })
        .filter((path) => path.endsWith('.md'))
        .map((path) => readFileSync(join(directory, path), 'utf8'));
    }

    function evidenceIndex(prompt: string) {
      const path = /^Evidence index: (.+)$/m.exec(prompt)?.[1];
      expect(path).toBeDefined();
      return JSON.parse(readFileSync(path!, 'utf8')) as {
        checks: Array<{ name: string; run: { id: number; attempt: number; headSha: string };
          jobs: Array<{ id: number; logPath: string | null }> }>;
        unavailable: Array<{ reason: string }>;
      };
    }

    function expectStopped(h: Awaited<ReturnType<typeof runRecovery>>, rounds: number, reruns: number) {
      expect(h.state.status).toBe('aborted');
      expect(h.calls).not.toContain('merge_pr');
      expect(h.comments).toHaveLength(1);
      const body = h.comments[0]!;
      expect(body).toMatch(new RegExp(`(?:fix|修正)[^\\n]{0,30}${rounds}`, 'iu'));
      expect(body).toMatch(new RegExp(`(?:rerun|再実行)[^\\n]{0,30}${reruns}`, 'iu'));
      expect(body).toContain(`unit-round-${rounds + 1}`);
      expect(body).toContain(`https://github.com/org/repo/actions/runs/${11 + rounds}`);
      expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
        .toEqual([[expect.anything(), expect.objectContaining({ pr: 123, body: expect.any(String), body_format: 'plain_text' }), expect.anything()]]);
    }

    it('失敗の証拠を調査へ渡し読み取り専用の調査・編集可能な修正・レビューを経て新HEADをマージする', async () => {
      const cause = defect();
      const h = await runRecovery({ ciFailures: [cause] });
      expect(h.state.status).toBe('completed');
      expect(h.calls.filter((call) => call.startsWith('agent:'))).toEqual([
        'agent:investigate_ci', 'agent:fix_ci', 'agent:review_ci_fix',
      ]);
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(2);
      expect(h.calls.filter((call) => call === 'caccia')).toHaveLength(2);
      expect(h.calls.indexOf('fetch_ci_failure')).toBeLessThan(h.calls.indexOf('agent:investigate_ci'));
      expect(h.calls.indexOf('agent:review_ci_fix')).toBeLessThan(h.calls.lastIndexOf('commit_and_push'));
      expect(h.calls.lastIndexOf('commit_and_push')).toBeLessThan(h.calls.lastIndexOf('caccia'));
      expect(h.calls.lastIndexOf('caccia')).toBeLessThan(h.calls.indexOf('merge_pr'));
      expect(h.recoveryPrompts.map(({ requiredPermissionMode }) => requiredPermissionMode)).toEqual([undefined, 'edit', undefined]);
      expect(h.recoveryPrompts[0]?.prompt).toContain(buildEditRule(false, language));
      expect(h.recoveryPrompts[1]?.prompt).toContain(buildEditRule(true, language));
      expect(h.recoveryPrompts[2]?.prompt).toContain(buildEditRule(false, language));
      expect(h.recoveryPrompts.every(({ cwd }) => cwd === h.cloneCwd)).toBe(true);
      const investigation = h.recoveryPrompts[0]!.prompt;
      expect(investigation).not.toContain('round-1.test.ts > adds');
      const index = evidenceIndex(investigation);
      expect(index.checks[0]).toMatchObject({ name: 'unit-round-1', run: { id: 11, attempt: 1, headSha: 'b'.repeat(40) },
        jobs: [{ id: 21, logPath: expect.any(String) }] });
      expect(readFileSync(index.checks[0]!.jobs[0]!.logPath!, 'utf8')).toContain('expected 1 to equal 3');
      expect(reports(h.reportDirectory).some((report) => report.includes(cause.summary) && report.includes('Location:'))).toBe(true);
      expect(h.comments[0]).toContain('c'.repeat(40));
      expect(h.rerunPrCi).not.toHaveBeenCalled();
    });

    it('同じrunの複数checkと6件の長いjobログを一度だけ保存し3段階のpromptから参照できる', async () => {
      const h = await runRecovery({ ciFailures: [defect()], largeCiLogs: true });
      expect(h.state.status).toBe('completed');
      expect(h.recoveryPrompts.map(({ step }) => step)).toEqual(['investigate_ci', 'fix_ci', 'review_ci_fix']);
      for (const { prompt } of h.recoveryPrompts) {
        expect(prompt.length).toBeLessThan(100_000);
        expect(prompt).not.toContain('CI_LOG_0');
        const index = evidenceIndex(prompt);
        const indexPath = /^Evidence index: (.+)$/m.exec(prompt)?.[1];
        expect(isRealPathInside(h.cloneCwd, indexPath!)).toBe(true);
        expect(index.checks).toHaveLength(2);
        expect(index.checks.flatMap(({ jobs }) => jobs)).toHaveLength(12);
        const paths = index.checks.flatMap(({ jobs }) => jobs.map(({ logPath }) => logPath));
        expect(new Set(paths).size).toBe(6);
        expect(paths.every((path) => path !== null && isRealPathInside(h.cloneCwd, path))).toBe(true);
        expect(readFileSync(index.checks[0]!.jobs[0]!.logPath!, 'utf8')).toContain('CI_LOG_0');
      }
      const evidenceDirectory = join(h.reportDirectory, '..', 'ci-evidence');
      expect(readdirSync(evidenceDirectory).filter((name) => name.endsWith('.log'))).toHaveLength(6);
      const canonicalIndexPath = join(evidenceDirectory,
        readdirSync(evidenceDirectory).find((name) => name.endsWith('.json'))!);
      const canonical = JSON.parse(readFileSync(canonicalIndexPath, 'utf8')) as {
        checks: Array<{ jobs: Array<{ logPath: string }> }>;
      };
      const view = evidenceIndex(h.recoveryPrompts[0]!.prompt);
      expect(canonical.checks.map(({ jobs }) => jobs.map(({ logPath }) => readFileSync(logPath, 'utf8'))))
        .toEqual(view.checks.map(({ jobs }) => jobs.map(({ logPath }) => readFileSync(logPath!, 'utf8'))));
      expect(execFileSync('git', ['status', '--porcelain'], { cwd: h.cloneCwd, encoding: 'utf8' })).toBe('');
      expect(execFileSync('git', ['check-ignore', '.takt/runs/merge-workflow-report/ci-evidence'],
        { cwd: h.cloneCwd, encoding: 'utf8' }).trim()).toBe('.takt/runs/merge-workflow-report/ci-evidence');
    });

    it.each([
      'The same unit check fails on main; the defect is a missing null guard in repository code',
      'Flaky timer assertion depends on wall-clock scheduling; fix the test clock and synchronization',
    ])('欠陥判断を受けた%sは再実行へ逃げずPRの作業ツリーを修正する', async (summary) => {
      const h = await runRecovery({ ciFailures: [defect(summary)] });
      expect(h.state.status).toBe('completed');
      expect(h.calls).toContain('agent:fix_ci');
      expect(h.recoveryPrompts.find(({ step }) => step === 'fix_ci')?.prompt).toContain(summary);
      expect(h.recoveryPrompts.find(({ step }) => step === 'fix_ci')?.cwd).toBe(h.cloneCwd);
      expect(h.rerunPrCi).not.toHaveBeenCalled();
    });

    it('同じ実行でHEADを更新しながら2周修正し3回目の失敗も調査して欠陥ならコメントし失敗終了する', async () => {
      const finalCause = 'Third failure: implementation still violates the null-handling contract';
      const h = await runRecovery({ ciFailures: [defect(), defect('Second failure: null guard is incomplete'), defect(finalCause)] });
      expectStopped(h, 2, 0);
      expect(h.calls.filter((call) => call === 'agent:investigate_ci')).toHaveLength(3);
      expect(h.calls.filter((call) => call === 'agent:fix_ci')).toHaveLength(2);
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(3);
      expect(h.fetchPrCiFailure.mock.calls.map(([, head]) => head)).toEqual(['b', 'c', 'd'].map((char) => char.repeat(40)));
      const finalIndex = evidenceIndex(h.recoveryPrompts.filter(({ step }) => step === 'investigate_ci').at(-1)!.prompt);
      expect(readFileSync(finalIndex.checks[0]!.jobs[0]!.logPath!, 'utf8')).toContain('round-3.test.ts');
      expect(h.comments[0]).toContain(finalCause);
      expect(h.rerunPrCi).not.toHaveBeenCalled();
    });

    it.each([0, 2])('修正%s周後の外部要因は独立した予算で1回再実行し同じHEADの完了を待ってマージする', async (fixRounds) => {
      const h = harness(name, { ciFailures: [...Array.from({ length: fixRounds }, () => defect()), external] }, language);
      const rerunCiWait = nextStepStart(h.engine, 'wait_ci', 2 + fixRounds);
      const running = h.engine.run();
      await rerunCiWait;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.rerunPrCi).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      const investigations = h.calls.filter((call) => call === 'agent:investigate_ci').length;
      const targetHead = h.engine.getState().effectResults.get('caccia')?.caccia;
      for (const [attempt, status, conclusion] of [[1, 'completed', 'failure'], [2, 'in_progress', 'success']] as const) {
        h.setRerun(attempt, status, conclusion);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(h.engine.getState().status).toBe('running');
        expect(h.engine.getState().effectResults.get('caccia')?.caccia).toEqual(targetHead);
        expect(h.calls).not.toContain('merge_pr');
        expect(h.calls.filter((call) => call === 'agent:investigate_ci')).toHaveLength(investigations);
        expect(h.comments).toEqual([]);
      }
      h.setRerun(2, 'completed', 'success');
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await running).status).toBe('completed');
      expect(h.rerunPrCi).toHaveBeenCalledOnce();
      expect(h.calls.filter((call) => call === 'agent:fix_ci')).toHaveLength(fixRounds);
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(1 + fixRounds);
      expect(h.calls.filter((call) => call === 'agent:investigate_ci')).toHaveLength(1 + fixRounds);
      expect(h.calls.indexOf('agent:investigate_ci')).toBeLessThan(h.calls.indexOf('rerun_ci'));
      expect(h.calls.indexOf('rerun_ci')).toBeLessThan(h.calls.indexOf('merge_pr'));
      expect(h.observedStatuses.length).toBeGreaterThan(3);
      expect(h.comments[0]).toContain(String.fromCharCode('b'.charCodeAt(0) + fixRounds).repeat(40));
    });

    it('再実行後に欠陥と判断しても最新の証拠を報告し2回目の再実行も修正もせず失敗終了する', async () => {
      const latest = defect('Rerun found a repository null-handling defect; recovery must stop after the used rerun');
      const h = await runRecovery({ ciFailures: [external], rerunFails: true, rerunFailure: latest });
      expectStopped(h, 0, 1);
      expect(h.rerunPrCi).toHaveBeenCalledOnce();
      expect(h.calls).not.toContain('agent:fix_ci');
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(1);
      expect(h.fetchPrCiFailure).toHaveBeenCalledTimes(2);
      expect(h.comments[0]).toContain(latest.summary);
    });

    it('調査中に現在HEADが変われば古い証拠で再実行せず対象HEADと理由をコメントして停止する', async () => {
      const h = await runRecovery({ ciFailures: [external], headChangesDuringInvestigation: true });
      expectStopped(h, 0, 1);
      expect(h.rerunPrCi).not.toHaveBeenCalled();
      expect(h.fetchPrCiFailure).toHaveBeenCalledOnce();
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(1);
      expect(h.comments[0]).toContain('b'.repeat(40));
      expect(h.comments[0]).toContain('f'.repeat(40));
      expect(readFileSync(evidenceIndex(h.recoveryPrompts.at(-1)!.prompt).checks[0]!.jobs[0]!.logPath!, 'utf8'))
        .toContain('round-1.test.ts > adds');
    });

    it('run検証中に現在HEADが変わればAPIを呼ばず元の証拠と変更理由をコメントして停止する', async () => {
      const h = await runRecovery({ ciFailures: [external], headChangesDuringRunValidation: true });
      expectStopped(h, 0, 1);
      expect(h.rerunPrCi).toHaveBeenCalledOnce();
      expect(vi.mocked(runPrCommand).mock.calls.some(([args]) => args[1] === 'rerun')).toBe(false);
      expect(h.fetchPrCiFailure).toHaveBeenCalledOnce();
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(1);
      expect(h.comments[0]).toContain('b'.repeat(40));
      expect(h.comments[0]).toContain('f'.repeat(40));
      const rerunResult = h.state.effectResults.get('rerun_ci')?.rerun_ci;
      expect(rerunResult).toMatchObject({ success: false, failed: true, headChanged: true });
      expect(h.comments[0]).toContain(String((rerunResult as { error: string }).error));
      expect(readFileSync(evidenceIndex(h.recoveryPrompts.at(-1)!.prompt).checks[0]!.jobs[0]!.logPath!, 'utf8'))
        .toContain('expected 1 to equal 3');
    });

    it('再実行受付後のHEAD変更では待機を抜け元HEADの失敗証拠と変更理由をコメントして停止する', async () => {
      const h = harness(name, { ciFailures: [external] }, language);
      const rerunCiWait = nextStepStart(h.engine, 'wait_ci', 2);
      const running = h.engine.run();
      await rerunCiWait;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.rerunPrCi).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      h.setRemoteHead('f'.repeat(40));
      await vi.advanceTimersByTimeAsync(15_000);
      const state = await running;
      expectStopped({ ...h, state }, 0, 1);
      expect(h.fetchPrCiFailure).toHaveBeenCalledOnce();
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(1);
      expect(h.comments[0]).toContain('b'.repeat(40));
      expect(h.comments[0]).toContain('f'.repeat(40));
      expect(readFileSync(evidenceIndex(h.recoveryPrompts.at(-1)!.prompt).checks[0]!.jobs[0]!.logPath!, 'utf8'))
        .toContain('round-1.test.ts > adds');
      expect(state.systemContexts.get('wait_ci')?.status).toMatchObject({ headSha: 'f'.repeat(40),
        ci: { finished: false, passed: false }, rerunHeadChanged: true });
    });

    it('証拠不足は調査へ伝えてレポートと停止コメントを残し修正・再実行・マージを行わない', async () => {
      const summary = 'Cannot determine cause: HTTP 403 prevents reading the failed job logs';
      const h = await runRecovery({ ciFailures: [{ verdict: 'insufficient_evidence', summary }] });
      expectStopped(h, 0, 0);
      expect(h.calls.filter((call) => call.startsWith('agent:'))).toEqual(['agent:investigate_ci']);
      expect(evidenceIndex(h.recoveryPrompts[0]!.prompt).unavailable[0]?.reason).toContain('HTTP 403');
      expect(reports(h.reportDirectory).some((report) => report.includes(summary))).toBe(true);
      expect(h.comments[0]).toContain(summary);
      expect(h.rerunPrCi).not.toHaveBeenCalled();
    });

    it('調査中に同じHEADのCIが成功したら古い証拠不足で停止せず通常のマージ判定へ戻る', async () => {
      const h = await runRecovery({ ciFailures: [{ verdict: 'insufficient_evidence',
        summary: 'Cancelled run has no failed job logs' }], ciSucceedsDuringInvestigation: true });
      expect(h.state.status).toBe('completed');
      expect(h.calls.filter((call) => call === 'fetch_ci_failure')).toHaveLength(1);
      expect(h.calls.filter((call) => call === 'agent:investigate_ci')).toHaveLength(1);
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(1);
      expect(h.rerunPrCi).not.toHaveBeenCalled();
      expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(1);
    });

    it('根本修正のレビューがREJECTならその変更をpushせずマージしない', async () => {
      const h = await runRecovery({ ciFailures: [defect()], recoveryReviewRejects: true });
      expect(h.calls).toContain('agent:review_ci_fix');
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(1);
      expect(h.calls).not.toContain('merge_pr');
      expect(h.state.status).toBe('aborted');
    });

    it.each((['ci_stopped', 'ci_push_failed'] as const).flatMap((terminal) =>
      (['check', 'job', 'unavailable', 'summary'] as const).map((field) => ({ terminal, field })),
    ))('$terminalで$fieldに含まれるMarkdownを文字として表示する', async ({ terminal, field }) => {
      const value = '[unit](https://example.invalid/login)\n````\n[run](https://example.invalid/run)';
      const summary = field === 'summary' ? value : 'Repository test defect demonstrated by assertion';
      const scenario: Scenario = { ciFailures: [{ verdict: field === 'unavailable' ? 'insufficient_evidence' : 'defect', summary }],
        ...(field === 'summary' ? {} : { ciName: { field, value } }),
        recoveryReviewRejects: terminal === 'ci_stopped', recoveryPushFails: terminal === 'ci_push_failed' };
      // Missing evidence stops before a push; the push-failure path can still carry names in its summary.
      if (terminal === 'ci_push_failed' && field === 'unavailable') {
        scenario.ciFailures = [defect(value)];
        delete scenario.ciName;
      }
      const h = await runRecovery(scenario);
      expect(h.state.currentStep).toBe(terminal);
      expect(h.state.status).toBe('aborted');
      expect(h.calls).not.toContain('merge_pr');
      const body = h.comments[0]!;
      const rendered = marked.parse(body, { gfm: true, async: false });
      expect(rendered).not.toMatch(/<(?:a|img)\b/iu);
      const tokens = marked.lexer(body);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({ type: 'code' });
      if (tokens[0]?.type !== 'code') throw new Error('Expected plain text comment');
      expect(tokens[0].text).toContain(field === 'summary' || (terminal === 'ci_push_failed' && field === 'unavailable')
        ? value : JSON.stringify(value).slice(1, -1));
    });

    it('CI修正後も競合が続けば取り込み直し上限まで試みコメントしてマージしない', async () => {
      const h = await runRecovery({ ciFailures: [defect()], recoveredMergeable: 'CONFLICTING' });
      expect(h.calls).toContain('agent:fix_ci');
      expect(h.calls.filter((call) => call === 'sync_with_root')).toHaveLength(3);
      expect(h.calls.filter((call) => call === 'commit_and_push')).toHaveLength(4);
      expect(h.calls).not.toContain('merge_pr');
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]).toContain('CONFLICTING');
    });

    it('停止コメントの投稿失敗を成功終了へ変換しない', async () => {
      const h = await runRecovery({ ciFailures: [{ verdict: 'insufficient_evidence', summary: 'Failed logs are unavailable' }], commentFails: true });
      expect(h.state.status).toBe('aborted');
      expect(h.comments).toHaveLength(1);
      expect(h.calls).not.toContain('merge_pr');
    });

    it('初回成功では調査・修正・再実行を行わない', async () => {
      const h = await runRecovery({});
      expect(h.state.status).toBe('completed');
      expect(h.recoveryPrompts).toEqual([]);
      expect(h.fetchPrCiFailure).not.toHaveBeenCalled();
      expect(h.rerunPrCi).not.toHaveBeenCalled();
      expect(h.calls.filter((call) => call === 'merge_pr')).toHaveLength(1);
    });

    it('実際の初回子レビューから修正2周と外部再実行後の失敗まで有限予算でコメントへ到達する', async () => {
      const h = await runRecovery({ fullInitialReview: true, ciFailures: [defect(), defect(), external], rerunFails: true });
      expectStopped(h, 2, 1);
      expect(h.calls).toContain('call:peer-review');
      expect(h.calls).toContain(name === 'merge-review-fix' ? 'call:development-review' : 'call:single-review-suite');
      expect(h.calls.filter((call) => call === 'agent:fix_ci')).toHaveLength(2);
      expect(h.rerunPrCi).toHaveBeenCalledOnce();
      console.info('CI recovery budget', { language, name, steps: h.state.iteration, maxSteps: h.workflow.maxSteps, status: h.state.status });
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
