import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Language, WorkflowEffect, WorkflowState } from '../core/models/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { fetchPrStatus } from '../infra/github/pr-status.js';
import { runPrCommand } from '../infra/github/pr-command.js';
import { cacciaEffect } from '../features/caccia/system-effect.js';
import { runCaccia } from '../features/caccia/index.js';
import { runMerge, resolveMergeSettings } from '../features/merge/index.js';
import { runAgent } from '../agents/runner.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
vi.mock('../infra/github/pr-command.js', () => ({ runPrCommand: vi.fn() }));
vi.mock('../features/caccia/index.js', async (original) => ({
  ...await original<typeof import('../features/caccia/index.js')>(), runCaccia: vi.fn(),
}));
const git = vi.hoisted(() => vi.fn());
vi.mock('../infra/task/clone-exec.js', async (original) => ({
  ...await original<typeof import('../infra/task/clone-exec.js')>(), runGitCommandAbortable: git,
}));
vi.mock('../infra/task/git-environment.js', async (original) => ({
  ...await original<typeof import('../infra/task/git-environment.js')>(),
  buildSafeGitEnvironment: vi.fn(async () => ({})),
}));

interface Check {
  __typename: 'CheckRun';
  name: string;
  status: string;
  conclusion: string | null;
}

function check(conclusion: string | null, status = 'COMPLETED'): Check {
  return { __typename: 'CheckRun', name: 'unit', status, conclusion };
}

const unsuccessfulCi = [
  { label: 'pending', checks: [check(null, 'IN_PROGRESS')] },
  { label: 'failed', checks: [check('FAILURE')] },
  { label: 'absent', checks: [] },
  { label: 'cancelled', checks: [check('CANCELLED')] },
  { label: 'timed out', checks: [check('TIMED_OUT')] },
  { label: 'action required', checks: [check('ACTION_REQUIRED')] },
  { label: 'unknown conclusion', checks: [check('UNKNOWN')] },
  { label: 'success with pending', checks: [check('SUCCESS'), { ...check(null, 'QUEUED'), name: 'lint' }] },
  { label: 'success with failure', checks: [check('SUCCESS'), { ...check('FAILURE'), name: 'lint' }] },
  { label: 'unfinished success', checks: [check('SUCCESS', 'IN_PROGRESS')] },
];

describe.each(['ja', 'en'] as const)('%s merge-review-ci execution', (language: Language) => {
  let project: string;
  let checksByPr: Map<number, Check[]>;

  beforeEach(() => {
    vi.resetAllMocks();
    project = mkdtempSync(join(tmpdir(), 'takt-merge-review-ci-'));
    mkdirSync(join(project, '.takt'));
    writeFileSync(join(project, '.takt', 'config.yaml'),
      `language: ${language}\nvcs_provider: github\ncaccia:\n  enabled: false\n`);
    checksByPr = new Map();
    vi.mocked(runPrCommand).mockImplementation(async (args) => {
      expect(args.slice(0, 2)).toEqual(['pr', 'view']);
      const number = Number(args[2]);
      const checks = checksByPr.get(number);
      if (checks === undefined) throw new Error(`Missing CI fixture for PR ${number}`);
      return JSON.stringify({ number, headRefOid: 'a'.repeat(40), state: 'OPEN',
        mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
        statusCheckRollup: checks });
    });
    git.mockImplementation(async (_cwd, args: string[]) => {
      if (args.join(' ') === 'symbolic-ref --short HEAD') return { stdout: 'feature/pr', stderr: '' };
      if (args.join(' ') === 'rev-parse HEAD') return { stdout: 'a'.repeat(40), stderr: '' };
      throw new Error(`Unexpected Git operation: ${args.join(' ')}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  function harness(number: number, checks: Check[], workflowName: string, approved: boolean) {
    checksByPr.set(number, checks);
    const workflow = loadWorkflowByIdentifier(
      join(process.cwd(), 'builtins', language, 'workflows', `${workflowName}.yaml`), project);
    if (!workflow) throw new Error(`Missing builtin workflow: ${workflowName}`);
    const cwd = join(project, `clone-${number}`);
    mkdirSync(cwd);
    const reportDirName = `review-ci-${number}`;
    const reportDirectory = join(project, '.takt', 'runs', reportDirName, 'reports');
    const reason = approved ? 'no unresolved findings' : 'unresolved review issue';
    const report = `CHILD_REVIEW_REPORT: PR ${number}: ${reason}`;
    const agents: Array<{ step: string; edit: boolean | undefined }> = [];
    const reviewStarts: string[] = [];
    const effects: string[] = [];
    const cacciaResults: Record<string, unknown>[] = [];
    const failures: string[] = [];
    const commentOnPr = vi.fn(() => ({ success: true }));
    const mergePr = vi.fn();
    const push = vi.fn(async () => {});
    const fetch = vi.fn(async () => {});
    const caccia = vi.fn(async (pr: number) => {
      const result = await cacciaEffect({ cwd, projectCwd: project, task: 'Review PR',
        prExecutionContext: context }, pr);
      cacciaResults.push(result);
      return result;
    });
    const context = { prNumber: number, headBranch: 'feature/pr', baseBranch: 'main',
      headSha: 'a'.repeat(40), headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'] };
    // AI判断は固定し、報告の生成・転送と既存の判定・コメント処理は実行する。
    const review = normalizeWorkflowConfig({ name: 'review-fixture', subworkflow: { callable: true },
      initial_step: 'write_report', steps: [{ name: 'write_report', persona: 'reviewer', edit: false,
        instruction: 'Report the PR review result.',
        output_contracts: { report: [{ name: 'review-summary.md', format: 'Review result' }] },
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }],
    }, project);
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      const step = options?.workflowMeta?.currentStep;
      if (options?.executionPhase === 1) agents.push({ step: step!, edit: options.edit });
      options?.onPromptResolved?.({ systemPrompt: 'reviewer', userInstruction: prompt });
      if (step === 'write_report') return { persona: persona!, status: 'done', content: report, timestamp: new Date() };
      expect(step).toBe('judge');
      expect(prompt).toContain(report);
      expect(prompt).not.toContain('{report:review-summary.md}');
      const decision = { approved, reason };
      return { persona: persona!, status: 'done', content: JSON.stringify(decision),
        structuredOutput: decision, timestamp: new Date() };
    });
    const services = createDefaultSystemStepServices({ cwd, projectCwd: project, task: 'Review PR',
      prExecutionContext: context, cacciaService: { execute: caccia },
      gitProvider: { checkCliStatus: vi.fn(), fetchIssue: vi.fn(), createIssue: vi.fn(), closeIssue: vi.fn(),
        fetchPrReviewComments: vi.fn(), listOpenIssues: vi.fn(), listOpenPrs: vi.fn(), findExistingPr: vi.fn(),
        commentOnPr, closePr: vi.fn(), mergePr, fetchPrStatus },
    });
    const engine = new WorkflowEngine(workflow, cwd, `Review PR ${number}`, {
      provider: 'mock', language, projectCwd: project, reportDirName,
      runPathsDirectory: join(project, '.takt', 'runs'),
      prContext: { source: 'pr_review', prNumber: number, headBranch: 'feature/pr', baseBranch: 'main',
        baseBranchSource: 'pull_request' },
      prExecutionContext: context, prGitOperations: { fetch, push },
      workflowCallResolver: (request) => request.step.call === 'review' ? review
        : resolveWorkflowCallTarget(request.parentWorkflow, request.step, request.projectCwd, request.lookupCwd),
      systemStepServicesFactory: (options) => {
        expect(options.prExecutionContext).toMatchObject(context);
        expect(options.cwd).toBe(cwd);
        expect(options.projectCwd).toBe(project);
        return {
          resolveSystemInput: services.resolveSystemInput,
          executeEffect: (effect: WorkflowEffect, payload: Record<string, unknown>, state: WorkflowState) => {
            effects.push(effect.type);
            return services.executeEffect(effect, payload, state);
          },
        };
      },
    });
    engine.on('workflow:abort', (_state, reason) => failures.push(reason));
    engine.on('workflow_call:start', (lifecycle) => reviewStarts.push(lifecycle.childWorkflow));
    return { engine, number, reason, report, reportDirectory, agents, reviewStarts, effects,
      caccia, cacciaResults, commentOnPr, mergePr, push, fetch, failures };
  }

  async function runSingle(h: ReturnType<typeof harness>, workflow: string) {
    let state: WorkflowState | undefined;
    const listOpenPrNumbers = vi.fn();
    const fetchPrListItem = vi.fn();
    const result = await runMerge({ projectCwd: project, prNumber: h.number, concurrency: 1,
      workflow, settings: resolveMergeSettings(undefined) }, {
      listOpenPrNumbers, fetchPrListItem,
      executePrWorkflow: async (request) => {
        expect(request.workflow).toBe(workflow);
        expect(request.prNumber).toBe(h.number);
        state = await h.engine.run();
        return { success: state.status === 'completed', merged: false,
          outcome: state.status === 'completed' ? 'prepared' : 'unresolved' };
      },
    });
    expect(listOpenPrNumbers).not.toHaveBeenCalled();
    expect(fetchPrListItem).not.toHaveBeenCalled();
    return { result, state };
  }

  it.each(unsuccessfulCi)('skips review and all effects for a numbered PR with $label CI', async ({ checks }) => {
    const h = harness(123, checks, 'merge-review-ci', true);
    const { result, state } = await runSingle(h, 'merge-review-ci');
    expect(state?.status, h.failures.join('\n')).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(h.reviewStarts).toEqual([]);
    expect(h.agents).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
    expect(h.effects).toEqual([]);
    expect(h.caccia).not.toHaveBeenCalled();
    expect(h.commentOnPr).not.toHaveBeenCalled();
    expect(runPrCommand).toHaveBeenCalledOnce();
    expect(git).not.toHaveBeenCalled();
  });

  it.each(['SUCCESS', 'NEUTRAL', 'SKIPPED'])('starts existing merge-review for %s CI and comments without changing code', async (conclusion) => {
    const h = harness(123, [check(conclusion)], 'merge-review-ci', true);
    const { state } = await runSingle(h, 'merge-review-ci');
    expect(state?.status, h.failures.join('\n')).toBe('completed');
    expect(h.reviewStarts).toContain('merge-review');
    expect(h.reviewStarts, h.failures.join('\n')).toContain('review');
    expect(h.agents.map(({ step }) => step)).toEqual(['write_report', 'judge']);
    expect(h.agents.every(({ edit }) => edit === false)).toBe(true);
    expect(h.commentOnPr).toHaveBeenCalledExactlyOnceWith(123,
      `TAKT evaluation: approved=true. ${h.reason}`, project);
    expect(h.cacciaResults).toEqual([expect.objectContaining({ success: true, outcome: 'skipped',
      skipReason: 'config_disabled', headSha: 'a'.repeat(40) })]);
    expect(runCaccia).not.toHaveBeenCalled();
    expect(h.effects).toEqual(['caccia', 'comment_pr']);
    expect(h.mergePr).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(git.mock.calls.map(([, args]) => args)).toEqual([
      ['symbolic-ref', '--short', 'HEAD'], ['rev-parse', 'HEAD'],
    ]);
    const reports = readdirSync(h.reportDirectory, { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('review-summary.md'));
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.some((path) => readFileSync(join(h.reportDirectory, path), 'utf8').includes(h.report))).toBe(true);
  });

  it('preserves the rejected evaluation comment and child ABORT', async () => {
    const h = harness(456, [check('SUCCESS')], 'merge-review-ci', false);
    const { result, state } = await runSingle(h, 'merge-review-ci');
    expect(h.reviewStarts).toContain('merge-review');
    expect(h.agents.map(({ step }) => step)).toContain('judge');
    expect(h.commentOnPr).toHaveBeenCalledExactlyOnceWith(456,
      `TAKT evaluation: approved=false. ${h.reason}`, project);
    expect(state?.status).toBe('aborted');
    expect(result.exitCode).toBe(1);
    expect(h.mergePr).not.toHaveBeenCalled();
  });

  it('reviews and comments only on successful PRs in a mixed batch', async () => {
    const cases = [
      { number: 101, checks: [check('SUCCESS')], success: true },
      { number: 102, checks: [check(null, 'IN_PROGRESS')], success: false },
      { number: 103, checks: [check('FAILURE')], success: false },
      { number: 104, checks: [], success: false },
    ];
    const observations: Array<ReturnType<typeof harness>> = [];
    const result = await runMerge({ projectCwd: project, concurrency: 1,
      workflow: 'merge-review-ci', settings: resolveMergeSettings(undefined) }, {
      listOpenPrNumbers: () => cases.map(({ number }) => number),
      fetchPrListItem: (number) => ({ number, author: 'alice', labels: [], base_branch: 'main',
        head_branch: 'feature/pr', managed_by_takt: false, same_repository: true, draft: false, updated_at: '' }),
      executePrWorkflow: async (request) => {
        const scenario = cases.find(({ number }) => number === request.prNumber)!;
        const h = harness(request.prNumber, scenario.checks, request.workflow, true);
        observations.push(h);
        const state = await h.engine.run();
        expect(state.status, h.failures.join('\n')).toBe('completed');
        return { success: true, merged: false, outcome: 'prepared' };
      },
    });
    expect(result).toMatchObject({ processedCount: 4, mergedCount: 0, exitCode: 0 });
    expect(observations.map(({ number }) => number)).toEqual(cases.map(({ number }) => number));
    for (const h of observations) {
      const scenario = cases.find(({ number }) => number === h.number)!;
      if (scenario.success) {
        expect(h.reviewStarts).toContain('merge-review');
        expect(h.agents.map(({ step }) => step)).toContain('judge');
        expect(h.commentOnPr).toHaveBeenCalledExactlyOnceWith(h.number,
          `TAKT evaluation: approved=true. ${h.reason}`, project);
      } else {
        expect(h.reviewStarts).toEqual([]);
        expect(h.agents).toEqual([]);
        expect(h.effects).toEqual([]);
        expect(h.caccia).not.toHaveBeenCalled();
        expect(h.commentOnPr).not.toHaveBeenCalled();
      }
    }
  });

  it.each(['SUCCESS', 'FAILURE'])('keeps the existing merge-review entry reviewing a PR with %s CI', async (conclusion) => {
    const h = harness(123, [check(conclusion)], 'merge-review', true);
    const { state } = await runSingle(h, 'merge-review');
    expect(h.reviewStarts, h.failures.join('\n')).toContain('review');
    expect(h.agents.map(({ step }) => step)).toEqual(conclusion === 'SUCCESS' ? ['write_report', 'judge'] : ['write_report']);
    expect(h.caccia).toHaveBeenCalledOnce();
    expect(h.commentOnPr).toHaveBeenCalledExactlyOnceWith(123, conclusion === 'SUCCESS'
      ? `TAKT evaluation: approved=true. ${h.reason}`
      : `TAKT evaluation failed: CI checks failed for head ${'a'.repeat(40)}.`, project);
    expect(state?.status, h.failures.join('\n')).toBe(conclusion === 'SUCCESS' ? 'completed' : 'aborted');
  });
});
