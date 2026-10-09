import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEffect, WorkflowStep } from '../core/models/types.js';
import { WorkflowEngine } from '../core/workflow/index.js';
import { loadWorkflowByIdentifier } from '../infra/config/loaders/workflowResolver.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';
import { resolveWorkflowCallTarget } from '../infra/config/loaders/workflowCallResolver.js';

vi.mock('../agents/runner.js', () => ({ runAgent: vi.fn() }));
import { runAgent } from '../agents/runner.js';

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

  function harness(name: string, scenario: Scenario = {}, language = 'ja') {
    const prNumber = scenario.prNumber ?? 123;
    const workflow = loadWorkflowByIdentifier(join(process.cwd(), 'builtins', language, 'workflows', `${name}.yaml`), project);
    if (!workflow) throw new Error(`Missing builtin workflow: ${name}`);
    let ciFinished = scenario.ciRunning !== true || name === 'merge-review-fix';
    let headSha = 'a'.repeat(40);
    let conflictsResolved = false;
    const calls: string[] = [];
    const comments: string[] = [];
    const failures: string[] = [];
    const observedStatuses: Array<{ headSha: string; finished: boolean }> = [];
    const childContexts: Array<{ cwd: string; projectCwd: string; prNumber: number | undefined }> = [];
    const cloneCwd = join(project, 'clone');
    mkdirSync(cloneCwd);
    const reportDirectory = join(project, '.takt', 'runs', 'merge-workflow-report', 'reports');
    const decision = { approved: scenario.approved !== false,
      reason: scenario.reason ?? (scenario.approved === false ? 'AI denied this PR' : 'AI approved this PR') };
    vi.mocked(runAgent).mockImplementation(async (_persona, prompt, options) => {
      options?.onPromptResolved?.({ systemPrompt: 'supervisor', userInstruction: prompt });
      if (prompt.includes('review-summary.md')) {
        return { persona: 'reviewer', status: 'done', content: `CHILD_REVIEW_REPORT: PR ${prNumber} review completed.`, timestamp: new Date() };
      }
      expect(prompt).toContain(join(reportDirectory, 'subworkflows'));
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
    const resolveChild = vi.fn(({ step }: { step: { call: string } }) => {
      calls.push(`call:${step.call}`);
      return child;
    });
    const resolveSystemInput = vi.fn((input: NonNullable<WorkflowStep['systemInputs']>[number]) => {
      if (input.type === 'task_context') return { exists: true, body: `Review PR ${prNumber}` };
      if (input.type === 'branch_context') return { exists: true, name: 'feature/pr' };
      observedStatuses.push({ headSha, finished: ciFinished });
      return { exists: true, number: prNumber, headSha, branch: 'feature/pr', baseBranch: 'main',
        ci: { finished: ciFinished, passed: ciFinished && scenario.ciPassed !== false },
        mergeable: scenario.syncFailed && !conflictsResolved ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: 'CLEAN',
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
      provider: 'mock', projectCwd: project, reportDirName: 'merge-workflow-report',
      runPathsDirectory: join(project, '.takt', 'runs'),
      prContext: { source: 'pr_review', prNumber, baseBranch: 'main', headBranch: 'feature/pr', baseBranchSource: 'pull_request' },
      ...{ prExecutionContext: { prNumber, headBranch: 'feature/pr', baseBranch: 'main',
        headSha, headRepositoryUrl: 'https://github.com/author/repo.git',
        headRepositoryPushUrls: ['https://github.com/author/repo.git'] } },
      workflowCallResolver: resolveChild,
      structuredCaller: { judgeStatus: vi.fn().mockResolvedValue({ candidateIndex: 0, method: 'structured' }),
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
    return { engine, calls, comments, failures, observedStatuses, childContexts, cloneCwd, executeEffect, finishCi: () => { ciFinished = true; } };
  }

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

  it.each(['ja', 'en'].flatMap((language) => [
    { language, reason: 'REASON_A', absentReason: 'REASON_B' },
    { language, reason: 'REASON_B', absentReason: 'REASON_A' },
  ]))('$languageの修正builtinはCIと承認後にmergeし$reasonを対象PRへ反映する', async ({ language, reason, absentReason }) => {
    const h = harness('merge-review-fix', { ciRunning: true, reason }, language);
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
    expect(h.observedStatuses).toContainEqual({ headSha: 'a'.repeat(40), finished: true });
    expect(h.observedStatuses).toContainEqual({ headSha: 'b'.repeat(40), finished: false });
    expect(h.observedStatuses.at(-1)).toEqual({ headSha: 'b'.repeat(40), finished: true });
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toMatch(/\bmerged\b/);
    expect(h.comments[0]).toContain(reason);
    expect(h.comments[0]).not.toContain(absentReason);
    expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
      .toEqual([[expect.objectContaining({ type: 'comment_pr' }), expect.objectContaining({ pr: 123, body: h.comments[0] }), expect.anything()]]);
    expect(h.calls).not.toContain('close_pr');
  });

  it.each(['ja', 'en'])('%sの修正builtinは否認時にmergeせず同じ評価理由を投稿する', async (language) => {
    const h = harness('merge-review-fix', { approved: false, reason: 'REASON_A' }, language);
    await h.engine.run();
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]).toContain('approved=false');
    expect(h.comments[0]).toContain('REASON_A');
    expect(h.comments[0]).not.toMatch(/\bmerged\b/);
    expect(h.executeEffect.mock.calls.filter(([effect]) => effect.type === 'comment_pr'))
      .toEqual([[expect.objectContaining({ type: 'comment_pr' }), expect.objectContaining({ pr: 123, body: h.comments[0] }), expect.anything()]]);
    expect(h.calls).not.toContain('merge_pr');
    expect(h.calls).not.toContain('close_pr');
  });

  it.each(['ja', 'en'])('%sの修正builtinはCHANGES_REQUESTEDならjudgeの承認に関わらずmergeしない', async (language) => {
    const h = harness('merge-review-fix', { approved: true, reviewDecision: 'CHANGES_REQUESTED' }, language);
    await h.engine.run();
    expect(h.calls).not.toContain('merge_pr');
    expect(h.calls).toContain('comment_pr');
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
