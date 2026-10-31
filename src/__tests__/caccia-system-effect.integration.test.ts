import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import { invalidateResolvedConfigCache } from '../infra/config/index.js';
import { renderPullRequestContext } from '../core/workflow/pr-context.js';
import type { CacciaInput, CacciaResult } from '../features/caccia/index.js';

const mocks = vi.hoisted(() => ({
  caccia: vi.fn<(input: CacciaInput) => Promise<CacciaResult>>(),
  details: vi.fn(), status: vi.fn(), comment: vi.fn(), merge: vi.fn(), review: vi.fn(),
  threat: vi.fn(), execution: vi.fn(), metadataAvailable: true,
  reviewStatus: vi.fn(), threads: vi.fn(), resolveThread: vi.fn(),
  gitlab: false, glab: vi.fn(), gitlabUrl: 'https://gitlab.example/org/repo.git', localRemote: '',
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual,
    execFile: (...args: unknown[]) => {
      if (mocks.gitlab && (args[0] === 'glab' || (args[0] === 'git' && (args[1] as string[])[0] === 'remote'))) {
        const callback = args[3] as (error: Error | null, output: string) => void;
        const output: string = args[0] === 'git' ? mocks.gitlabUrl : mocks.glab(args[1]);
        queueMicrotask(() => callback(null, output));
        return { kill: vi.fn() };
      }
      return Reflect.apply(actual.execFile, undefined, args);
    },
    execFileSync: (...args: unknown[]) => {
      if (mocks.gitlab && args[0] === 'glab') return mocks.glab(args[1]);
      return Reflect.apply(actual.execFileSync, undefined, args);
    },
    spawn: (...args: unknown[]) => {
      if (mocks.gitlab && args[0] === 'git' && ['fetch', 'push'].includes((args[1] as string[])[0]!)) {
        const gitArgs = (args[1] as string[]).map((arg) => arg === mocks.gitlabUrl ? mocks.localRemote : arg);
        return Reflect.apply(actual.spawn, undefined, [args[0], gitArgs, ...args.slice(2)]);
      }
      return Reflect.apply(actual.spawn, undefined, args);
    },
  };
});
vi.mock('../features/caccia/index.js', async (original) => ({
  ...await original<typeof import('../features/caccia/index.js')>(), runCaccia: mocks.caccia,
}));
vi.mock('../infra/git/index.js', async (original) => ({
  ...await original<typeof import('../infra/git/index.js')>(),
  getGitProvider: () => mocks.gitlab ? new GitLabProvider() : ({ checkCliStatus: () => ({ available: true }),
    fetchPrDetails: mocks.metadataAvailable ? mocks.details : undefined, fetchPrStatus: mocks.status, fetchPrReviewComments: mocks.review,
    commentOnPr: mocks.comment, mergePr: mocks.merge }),
}));
vi.mock('../infra/github/pr.js', async (original) => ({
  ...await original<typeof import('../infra/github/pr.js')>(),
  fetchPrDetails: mocks.details, fetchPrStatus: mocks.status, fetchPrReviewComments: mocks.review,
  fetchCacciaPullRequestDetails: mocks.details,
  fetchCacciaPullRequestHeadSha: async () => (await mocks.details()).headSha,
  fetchCodeRabbitReviewStatus: mocks.reviewStatus,
  fetchCodeRabbitReviewThreads: mocks.threads, resolveReviewThread: mocks.resolveThread,
}));
vi.mock('../features/merge/threat-check.js', async (original) => ({
  ...await original<typeof import('../features/merge/threat-check.js')>(), checkForkThreats: mocks.threat,
}));
vi.mock('../features/tasks/execute/workflowExecutionApi.js', async (original) => {
  const actual = await original<typeof import('../features/tasks/execute/workflowExecutionApi.js')>();
  return { ...actual, runWorkflowExecution: (...args: Parameters<typeof actual.runWorkflowExecution>) => {
    const result = actual.runWorkflowExecution(...args);
    mocks.execution(result);
    return result;
  } };
});
vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(async (persona, prompt, options) => {
    options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: prompt });
    writeFileSync(join(options.cwd, 'workflow-fix.txt'), 'change before Caccia\n');
    return { persona: 'coder', status: 'done', content: 'Fixed', timestamp: new Date() };
  }),
}));

import { executePrWorkflow, executePersistedPrMergeTask, resolveMergeSettings } from '../features/merge/index.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';
import { resolveTaskExecution } from '../features/tasks/execute/resolveTask.js';
import { executeTaskAndCompleteWithDetails } from '../features/tasks/execute/taskExecution.js';
import { addTask } from '../features/tasks/add/index.js';
import { createDefaultSystemStepServices } from '../infra/workflow/system/DefaultSystemStepServices.js';
import { TaskRunner } from '../infra/task/index.js';
import { GitLabProvider } from '../infra/gitlab/GitLabProvider.js';
import type { WorkflowState } from '../core/models/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

describe('Caccia effect through PR workflow execution', () => {
  it('delivers a linked Caccia warning through the workflow parent sink while preserving success', async () => {
    writeWorkflow();
    const execute = mocks.caccia.getMockImplementation()!;
    mocks.caccia.mockImplementationOnce(async (input) => {
      await input.eventSink?.({ type: 'progress', level: 'warn', message: 'Caccia child trace failed' });
      return execute(input);
    });
    const eventSink = vi.fn();
    expect(await executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: workflowFile,
      settings: resolveMergeSettings(undefined), display: { outputMode: 'silent', eventSink } }))
      .toEqual({ merged: true });
    expect(eventSink).toHaveBeenCalledExactlyOnceWith({ type: 'progress', level: 'warn', message: 'Caccia child trace failed' });
    expect(await mocks.execution.mock.calls[0]?.[0]).toMatchObject({ success: true });
  });

  let root: string;
  let project: string;
  let remote: string;
  let author: string;
  let workflowFile: string;
  let initialHead: string;
  let pushedHead: string;
  let effectHead: string;
  let activeClone: string;
  let merged: boolean;
  let sameRepository: boolean;
  let effectOutcome: 'success' | 'skipped' | 'limit';
  let effectReason: string | null;
  let skipReason: string | null;
  let unresolvedCount: number;

  function configure(caccia: Record<string, unknown> | undefined, vcsProvider = 'github') {
    writeFileSync(join(project, '.takt', 'config.yaml'), stringify({
      provider: 'mock', language: 'en', vcs_provider: vcsProvider,
      ...(caccia === undefined ? {} : { caccia }),
    }));
    invalidateResolvedConfigCache(project);
  }

  function writeWorkflow() {
    const outcome = effectOutcome;
    const reasonCondition = skipReason === 'config_disabled'
      ? 'effect.external_review.caccia.reason != null'
      : `effect.external_review.caccia.reason == ${effectReason === null ? 'null' : JSON.stringify(effectReason)}`;
    const skip = skipReason === null ? 'null' : JSON.stringify(skipReason);
    writeFileSync(workflowFile, stringify({
      name: 'caccia-contract', initial_step: 'identify', max_steps: 20,
      steps: [
        { name: 'identify', kind: 'system',
          system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          rules: [{ condition: 'when(true)', next: 'fix' }] },
        { name: 'fix', persona: 'coder', instruction: 'Apply the change',
          rules: [{ condition: 'when(true)', next: 'push' }] },
        { name: 'push', kind: 'system', effects: [{ type: 'commit_and_push', pr: 123 }],
          rules: [{ condition: 'when(effect.push.commit_and_push.success == true)', next: 'external_review' },
            { condition: 'when(true)', next: 'ABORT' }] },
        { name: 'external_review', kind: 'system', effects: [{ type: 'caccia', pr: '{context:identify.pr.number}' }],
          rules: [
            { condition: 'when(effect.external_review.caccia.success == false)', next: 'error' },
            { condition: `when(effect.external_review.caccia.outcome == "${outcome}" && effect.external_review.caccia.unresolvedCount == ${unresolvedCount} && effect.external_review.caccia.skipReason == ${skip} && ${reasonCondition})`, next: 'report' },
            { condition: 'when(true)', next: 'ABORT' },
          ] },
        { name: 'report', kind: 'system', effects: [{ type: 'comment_pr', pr: 123,
          body: 'outcome={effect:external_review.caccia.outcome}; head={effect:external_review.caccia.headSha}; unresolved={effect:external_review.caccia.unresolvedCount}' }],
          rules: [{ condition: 'when(effect.report.comment_pr.success == true)', next: outcome === 'limit' ? 'COMPLETE' : 'ci' },
            { condition: 'when(true)', next: 'ABORT' }] },
        { name: 'ci', kind: 'system',
          system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          wait: { until: 'when(context.ci.pr.headSha == effect.external_review.caccia.headSha && context.ci.pr.ci.finished == true)',
            interval_ms: 1, max_retries: 0, on_timeout: 'ABORT' },
          rules: [{ condition: 'when(context.ci.pr.ci.passed == true)', next: 'merge' },
            { condition: 'when(true)', next: 'ABORT' }] },
        { name: 'merge', kind: 'system', effects: [{ type: 'merge_pr', pr: 123 }],
          rules: [{ condition: 'when(effect.merge.merge_pr.success == true)', next: 'COMPLETE' },
            { condition: 'when(true)', next: 'merge_failed' }] },
        { name: 'merge_failed', kind: 'system', effects: [{ type: 'comment_pr', pr: 123, body: 'Merge failed' }],
          rules: [{ condition: 'when(effect.merge_failed.comment_pr.success == true)', next: 'COMPLETE' },
            { condition: 'when(true)', next: 'ABORT' }] },
        { name: 'error', kind: 'system', effects: [{ type: 'comment_pr', pr: 123,
          body: '{effect:external_review.caccia.error}' }],
          rules: [{ condition: 'when(true)', next: 'ABORT' }] },
      ],
    }));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.gitlab = false;
    mocks.gitlabUrl = 'https://gitlab.example/org/repo.git';
    mocks.metadataAvailable = true;
    root = mkdtempSync(join(tmpdir(), 'takt-caccia-effect-'));
    project = join(root, 'project');
    remote = join(root, 'head.git');
    author = join(root, 'author');
    workflowFile = join(root, 'workflow.yaml');
    git(root, 'init', '--initial-branch=main', project);
    git(project, 'config', 'user.name', 'Effect Test');
    git(project, 'config', 'user.email', 'effect@example.com');
    writeFileSync(join(project, 'code.txt'), 'base\n');
    writeFileSync(join(project, '.gitignore'), '.takt/\n');
    git(project, 'add', 'code.txt', '.gitignore');
    git(project, 'commit', '-m', 'base');
    git(root, 'clone', '--bare', project, remote);
    git(project, 'remote', 'add', 'origin', remote);
    git(root, 'clone', remote, author);
    git(author, 'config', 'user.name', 'Effect Author');
    git(author, 'config', 'user.email', 'author@example.com');
    git(author, 'checkout', '-b', 'feature/pr');
    writeFileSync(join(author, 'code.txt'), 'PR change\n');
    git(author, 'add', 'code.txt');
    git(author, 'commit', '-m', 'PR change');
    git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
    initialHead = git(author, 'rev-parse', 'HEAD');
    pushedHead = initialHead;
    effectHead = initialHead;
    activeClone = '';
    merged = false;
    sameRepository = true;
    effectOutcome = 'success';
    effectReason = null;
    skipReason = null;
    unresolvedCount = 0;
    mkdirSync(join(project, '.takt'), { recursive: true });
    configure({ enabled: true, wait_timeout_ms: 17, max_iterations: 2, workflow: 'custom-caccia' });
    const details = () => ({ number: 123, headBranch: 'feature/pr', baseBranch: 'main',
      headSha: git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/feature/pr'),
      headRepositoryUrl: remote, headRepositoryPushUrls: [remote], sameRepository });
    mocks.details.mockImplementation(async () => details());
    mocks.status.mockImplementation(async () => ({ number: 123, headSha: details().headSha,
      ci: { finished: true, passed: true }, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED', merged }));
    mocks.review.mockReturnValue({ number: 123, headRefName: 'feature/pr', baseRefName: 'main',
      url: 'https://github.com/org/repo/pull/123', title: 'Review PR', body: '', comments: [], reviews: [], files: ['code.txt'] });
    mocks.comment.mockReturnValue({ success: true });
    mocks.merge.mockImplementation((_pr, _cwd, _method, expectedSha) => {
      expect(git(activeClone, 'rev-parse', 'HEAD')).toBe(expectedSha);
      expect(readFileSync(join(activeClone, 'coderabbit-fix.txt'), 'utf8')).toBe('Caccia change\n');
      expect(expectedSha).toBe(effectHead);
      merged = true;
      return { success: true };
    });
    mocks.threat.mockResolvedValue({ passed: true });
    mocks.caccia.mockImplementation(async (input) => {
      const runner = new TaskRunner(project);
      if (!activeClone) {
        const clone = runner.listAllTaskItems().find((task) => task.worktreePath)?.worktreePath;
        if (!clone) throw new Error('PR workflow did not retain its clone');
        activeClone = clone;
      }
      pushedHead = git(activeClone, 'rev-parse', 'HEAD');
      expect(pushedHead).not.toBe(initialHead);
      expect(input).toMatchObject({ projectCwd: project, prNumber: 123,
        expectedInitialHeadSha: pushedHead,
        settings: { enabled: true, waitTimeoutMs: 17, maxIterations: 2, workflow: 'custom-caccia' } });
      git(author, 'fetch', 'origin', 'refs/heads/feature/pr');
      git(author, 'merge', '--ff-only', 'FETCH_HEAD');
      writeFileSync(join(author, 'coderabbit-fix.txt'), 'Caccia change\n');
      git(author, 'add', 'coderabbit-fix.txt');
      git(author, 'commit', '-m', 'Caccia fix');
      git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
      effectHead = git(author, 'rev-parse', 'HEAD');
      if (input.entry === 'linked') input.onPushedHead?.(effectHead);
      expect(git(activeClone, 'rev-parse', 'HEAD')).toBe(pushedHead);
      return { outcome: effectOutcome, headSha: effectHead, unresolvedCount,
        ...(skipReason === null ? {} : { skipReason: skipReason as CacciaResult['skipReason'] }),
        ...(effectReason === null ? {} : { reason: effectReason }) };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  async function run(entry: 'merge' | 'from_pr' | 'from_pr_local_origin' | 'from_pr_custom_base', expectedSuccess = true) {
    writeWorkflow();
    if (entry === 'merge') {
      return executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: workflowFile,
        settings: resolveMergeSettings(undefined), display: { outputMode: 'silent' } });
    }
    if (entry === 'from_pr_custom_base') {
      git(root, '--git-dir', remote, 'branch', 'review-base', 'refs/heads/main');
      git(project, 'branch', 'review-base', 'refs/heads/main');
      sameRepository = false;
      mocks.threat.mockImplementation(async ({ cwd, baseRef }) => {
        expect(baseRef).toBe('refs/takt/pr-base/main');
        expect(git(cwd, 'rev-parse', baseRef)).toBe(git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main'));
        return { passed: true };
      });
    }
    const services = createDefaultSystemStepServices({ cwd: project, projectCwd: project, task: 'enqueue PR' });
    const effect = { type: 'enqueue_task', mode: 'from_pr', pr: 123, workflow: workflowFile, task: 'Review PR',
      ...(entry === 'from_pr_custom_base' ? { base_branch: 'review-base' } : {}) } as const;
    expect(await services.executeEffect(effect, effect, {} as WorkflowState)).toMatchObject({ success: true, prNumber: 123 });
    const runner = new TaskRunner(project);
    const task = runner.claimNextTasks(1)[0]!;
    const result = await executeTaskAndCompleteWithDetails(task, runner, project, async (request) => {
      if (entry === 'from_pr_custom_base') expect(request.prContext?.baseBranch).toBe('review-base');
      activeClone = request.cwd;
      if (entry === 'from_pr_local_origin') git(activeClone, 'remote', 'add', 'origin', project);
      const remotesBefore = git(activeClone, 'remote');
      const result = await runWorkflowExecution({ ...request,
        runPathsDirectory: join(project, '.takt', 'runs') });
      expect(git(activeClone, 'remote')).toBe(remotesBefore);
      if (entry === 'from_pr_local_origin') expect(git(activeClone, 'remote', 'get-url', 'origin')).toBe(project);
      return result;
    }, { provider: 'mock' }, { outputMode: 'silent' });
    expect(result.success, JSON.stringify(result)).toBe(expectedSuccess);
    return { merged };
  }

  async function useRealCaccia(pushUrls: string[]) {
    const actual = await vi.importActual<typeof import('../features/caccia/index.js')>('../features/caccia/index.js');
    const details = mocks.details.getMockImplementation()!;
    mocks.details.mockImplementation(async () => ({ ...await details(), headRepositoryPushUrls: pushUrls }));
    const cacciaWorkflow = join(root, 'caccia.yaml');
    writeFileSync(cacciaWorkflow, stringify({ name: 'real-caccia', max_steps: 1, initial_step: 'address',
      steps: [{ name: 'address', persona: 'coder', capabilities: 'edit', edit: true, instruction: 'Fix the supplied review finding',
        output_contracts: { report: [{ name: 'caccia-decisions.json', format: 'caccia-decisions' }] },
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }] }));
    configure({ enabled: true, wait_timeout_ms: 10_000, max_iterations: 2, workflow: cacciaWorkflow });
    mocks.reviewStatus.mockImplementation(async () => {
      const headSha = (await mocks.details()).headSha;
      return { headSha, hasCodeRabbitPost: true, reviewedHeadShas: [headSha] };
    });
    mocks.threads.mockImplementation(async () => git(root, '--git-dir', remote, 'ls-tree', '--name-only', 'refs/heads/feature/pr')
      .includes('coderabbit-fix.txt') ? []
      : [{ id: 'finding', author: 'coderabbitai', body: 'Fix the changed code', replies: [] }]);
    mocks.resolveThread.mockResolvedValue(undefined);
    vi.mocked(runAgent).mockImplementation(async (...args) => {
      const [persona, prompt, options] = args;
      if (!activeClone) activeClone = new TaskRunner(project).listAllTaskItems().find((task) => task.worktreePath)!.worktreePath!;
      options?.onPromptResolved?.({ systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: prompt });
      if (options?.cwd === activeClone) {
        writeFileSync(join(activeClone, 'workflow-fix.txt'), 'change before Caccia\n');
      } else if (options?.permissionMode !== 'readonly') {
        git(options!.cwd!, 'config', 'user.name', 'Caccia Author');
        git(options!.cwd!, 'config', 'user.email', 'caccia@example.com');
        writeFileSync(join(options!.cwd!, 'coderabbit-fix.txt'), 'Caccia change\n');
      }
      return { persona: 'coder', status: 'done', timestamp: new Date(),
        content: options?.cwd === activeClone ? 'Fixed'
          : JSON.stringify([{ thread_id: 'finding', valid: true, reason: 'Fixed the changed code' }]) };
    });
    mocks.caccia.mockImplementation(async (input) => {
      pushedHead = git(activeClone, 'rev-parse', 'HEAD');
      try {
        return await actual.runCaccia(input);
      } finally {
        effectHead = git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/feature/pr');
      }
    });
  }

  it.each([
    ['merge', false, false], ['merge', false, true], ['merge', true, false], ['merge', true, true],
    ['from_pr_custom_base', false, false], ['from_pr_custom_base', false, true],
    ['from_pr_custom_base', true, false], ['from_pr_custom_base', true, true],
  ] as const)('%sは実Cacciaの部分push成功を保存し再投入する: 先行拒否=%s 外部変更=%s',
    async (entry, firstFails, externalChange) => {
      const mirror = join(root, 'mirror.git');
      git(root, 'clone', '--bare', remote, mirror);
      mkdirSync(join(mirror, 'hooks'), { recursive: true });
      git(mirror, 'config', 'core.hooksPath', join(mirror, 'hooks'));
      writeFileSync(join(mirror, 'hooks/pre-receive'),
        '#!/bin/sh\nwhile read old new ref; do\n  if git cat-file -e "$new:coderabbit-fix.txt" 2>/dev/null; then exit 1; fi\ndone\n',
        { mode: 0o755 });
      const pushUrls = firstFails ? [mirror, remote] : [remote, mirror];
      await useRealCaccia(pushUrls);
      const record = vi.spyOn(TaskRunner.prototype, entry === 'merge' ? 'recordPrMergePushedHead' : 'recordCacciaPushedHead');
      expect(await run(entry, false)).toEqual({ merged: false });
      const runner = new TaskRunner(project);
      const failed = runner.listFailedTasks()[0]!;
      const clone = activeClone;
      const savedHead = effectHead;
      const executions = await Promise.all(mocks.execution.mock.calls.map(([result]) => result));
      expect(savedHead, JSON.stringify({ executions, comments: mocks.comment.mock.calls })).not.toBe(pushedHead);
      expect(git(root, '--git-dir', remote, 'show', 'feature/pr:coderabbit-fix.txt')).toBe('Caccia change');
      expect(git(root, '--git-dir', mirror, 'rev-parse', 'refs/heads/feature/pr')).toBe(pushedHead);
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(pushedHead);
      expect(record).toHaveBeenCalledOnce();
      if (entry === 'merge') expect(failed.data).toMatchObject({ merge_pushed_head_sha: savedHead,
        merge_push_base_head_sha: pushedHead, merge_push_source: 'caccia' });
      else expect(failed.data).toMatchObject({ base_branch: 'review-base', caccia_pushed_head: {
        headSha: savedHead, baseBranch: 'main', headRepositoryUrl: remote, headRepositoryPushUrls: pushUrls } });
      expect(mocks.resolveThread).not.toHaveBeenCalled();
      expect(mocks.reviewStatus).toHaveBeenCalledOnce();
      expect(mocks.status).toHaveBeenCalledTimes(entry === 'merge' ? 2 : 1);
      expect(mocks.merge).not.toHaveBeenCalled();
      runner.requeueTask(failed.name, ['failed']);
      const claimed = new TaskRunner(project).claimNextTasks(1)[0]!;
      expect(claimed.worktreePath).toBe(clone);
      expect(claimed.data).toEqual(expect.objectContaining(entry === 'merge'
        ? { merge_pushed_head_sha: savedHead, merge_push_base_head_sha: pushedHead, merge_push_source: 'caccia' }
        : { caccia_pushed_head: failed.data!.caccia_pushed_head }));
      writeFileSync(join(mirror, 'hooks/pre-receive'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      if (externalChange) {
        git(author, 'fetch', 'origin', 'refs/heads/feature/pr');
        git(author, 'merge', '--ff-only', 'FETCH_HEAD');
        writeFileSync(join(author, 'external.txt'), 'external\n');
        git(author, 'add', 'external.txt');
        git(author, 'commit', '-m', 'External change');
        git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
      }
      const retryHead = git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/feature/pr');
      mocks.caccia.mockClear(); mocks.status.mockClear(); mocks.execution.mockClear();
      vi.mocked(runAgent).mockClear();
      if (entry === 'merge') {
        const retry = executePersistedPrMergeTask(claimed, runner, project, undefined, { outputMode: 'silent' });
        expect(await retry).toEqual({ merged: true });
      } else {
        const retry = await executeTaskAndCompleteWithDetails(claimed, runner, project, async (request) => {
          expect(request.cwd).toBe(clone);
          expect(request.prContext?.baseBranch).toBe('review-base');
          return runWorkflowExecution({ ...request, runPathsDirectory: join(project, '.takt', 'runs') });
        }, { provider: 'mock' }, { outputMode: 'silent' });
        expect(retry.success).toBe(!externalChange);
      }
      if (externalChange && entry !== 'merge') {
        expect(git(clone, 'rev-parse', 'HEAD')).toBe(pushedHead);
        expect(runAgent).not.toHaveBeenCalled();
        expect(mocks.caccia).not.toHaveBeenCalled();
        expect(mocks.status).not.toHaveBeenCalled();
        expect(mocks.merge).not.toHaveBeenCalled();
      } else {
        expect(mocks.caccia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedInitialHeadSha: retryHead }));
        expect(mocks.status).toHaveBeenCalled();
        expect(mocks.merge).toHaveBeenCalledWith(123, project, entry === 'merge' ? 'squash' : undefined, retryHead);
      }
    },
  );

  it('実Cacciaは同じcommitの複数送信成功を一度だけ記録する', async () => {
    const mirror = join(root, 'mirror.git');
    git(root, 'clone', '--bare', remote, mirror);
    await useRealCaccia([remote, mirror]);
    const record = vi.spyOn(TaskRunner.prototype, 'recordPrMergePushedHead');
    const result = await run('merge');
    const executions = await Promise.all(mocks.execution.mock.calls.map(([execution]) => execution));
    expect(result, JSON.stringify({ executions, comments: mocks.comment.mock.calls })).toEqual({ merged: true });
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.any(String), effectHead, pushedHead, 'caccia');
    expect(git(root, '--git-dir', mirror, 'rev-parse', 'refs/heads/feature/pr')).toBe(effectHead);
    expect(mocks.resolveThread).toHaveBeenCalledOnce();
  });

  it.each(([
    ['merge', false], ['merge', true], ['from_pr_custom_base', false], ['from_pr_custom_base', true],
  ] as const).flatMap(([entry, externalChange]) =>
    (['success', 'config_disabled', 'review_skipped', 'limit'] as const).map((result) => ({ entry, externalChange, result })),
  ))('$entryは通常push後のpushなし$resultを保存し再投入する: 外部変更=$externalChange', async ({ entry, externalChange, result }) => {
    await useRealCaccia([remote]);
    const worker = mocks.caccia.getMockImplementation()!;
    mocks.caccia.mockImplementationOnce(async (input) => {
      await worker(input);
      throw new Error('Review failed after push');
    });
    expect(await run(entry, false)).toEqual({ merged: false });
    const runner = new TaskRunner(project);
    const firstFailed = runner.listFailedTasks()[0]!;
    const clone = activeClone;
    const firstSavedHead = effectHead;
    if (entry === 'merge') expect(firstFailed.data?.merge_pushed_head_sha).toBe(firstSavedHead);
    else expect(firstFailed.data?.caccia_pushed_head?.headSha).toBe(firstSavedHead);

    async function retry(task: Parameters<typeof executePersistedPrMergeTask>[0], restoredRunner: TaskRunner) {
      expect(task.worktreePath).toBe(clone);
      if (entry === 'merge') {
        return (await executePersistedPrMergeTask(task, restoredRunner, project, undefined, { outputMode: 'silent' })).merged;
      }
      return (await executeTaskAndCompleteWithDetails(task, restoredRunner, project, async (request) => {
        expect(request.cwd).toBe(clone);
        expect(request.prContext?.baseBranch).toBe('review-base');
        return runWorkflowExecution({ ...request, runPathsDirectory: join(project, '.takt', 'runs') });
      }, { provider: 'mock' }, { outputMode: 'silent' })).success;
    }

    runner.requeueTask(firstFailed.name, ['failed']);
    const secondRunner = new TaskRunner(project);
    const secondTask = secondRunner.claimNextTasks(1)[0]!;
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      expect(options?.cwd).toBe(clone);
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      writeFileSync(join(clone, 'workflow-fix.txt'), 'change on retry before Caccia\n');
      return { persona: 'coder', status: 'done', content: 'Fixed again', timestamp: new Date() };
    });
    effectOutcome = result === 'success' ? 'success' : result === 'limit' ? 'limit' : 'skipped';
    unresolvedCount = result === 'limit' ? 1 : 0;
    skipReason = result === 'config_disabled' || result === 'review_skipped' ? result : null;
    effectReason = result === 'review_skipped' ? 'Review is unavailable' : null;
    if (result === 'config_disabled') configure({ enabled: false });
    else if (result !== 'success') {
      mocks.caccia.mockImplementation(async (input) => {
        if (input.entry !== 'linked' || !input.expectedInitialHeadSha) throw new Error('Expected current PR head');
        effectHead = input.expectedInitialHeadSha;
        return { outcome: effectOutcome, headSha: effectHead, unresolvedCount,
          ...(result === 'review_skipped' ? { skipReason: result, reason: effectReason! } : {}) };
      });
    }
    writeWorkflow();
    mocks.merge.mockReturnValue({ success: false, error: 'Merge unavailable' });
    mocks.comment.mockClear();
    mocks.comment.mockImplementation((_pr, body) => body === 'Merge failed' || result === 'limit'
      ? { success: false, error: 'Comment unavailable' } : { success: true });
    const record = vi.spyOn(TaskRunner.prototype, entry === 'merge' ? 'recordPrMergePushedHead' : 'recordCacciaPushedHead');
    mocks.caccia.mockClear(); mocks.resolveThread.mockClear();
    expect(await retry(secondTask, secondRunner)).toBe(false);
    const secondExecution = await mocks.execution.mock.calls.at(-1)![0];
    expect(secondExecution.success).toBe(false);
    const savedHead = git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/feature/pr');
    expect(savedHead).not.toBe(firstSavedHead);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(savedHead);
    expect(record).toHaveBeenCalledOnce();
    if (result === 'config_disabled') expect(mocks.caccia).not.toHaveBeenCalled();
    else {
      expect(mocks.caccia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedInitialHeadSha: savedHead }));
      expect(await mocks.caccia.mock.results[0]!.value).toMatchObject({ outcome: effectOutcome, headSha: savedHead });
    }
    expect(mocks.resolveThread).not.toHaveBeenCalled();
    expect(mocks.comment).toHaveBeenCalledWith(123,
      `outcome=${effectOutcome}; head=${savedHead}; unresolved=${unresolvedCount}`, project);
    if (result === 'limit') expect(mocks.merge).not.toHaveBeenCalled();
    else {
      expect(mocks.merge).toHaveBeenCalledWith(123, project, entry === 'merge' ? 'squash' : undefined, savedHead);
      expect(mocks.comment).toHaveBeenCalledWith(123, 'Merge failed', project);
    }
    const failed = new TaskRunner(project).listFailedTasks()[0]!;
    expect(failed.name).toBe(firstFailed.name);
    if (entry === 'merge') expect(failed.data).toMatchObject({ merge_pushed_head_sha: savedHead,
      merge_push_base_head_sha: savedHead, merge_push_source: 'caccia' });
    else expect(failed.data).toMatchObject({ base_branch: 'review-base', caccia_pushed_head: {
      headSha: savedHead, baseBranch: 'main', headRepositoryUrl: remote, headRepositoryPushUrls: [remote] } });
    new TaskRunner(project).requeueTask(failed.name, ['failed']);
    const thirdRunner = new TaskRunner(project);
    const thirdTask = thirdRunner.claimNextTasks(1)[0]!;
    if (entry === 'merge') expect(thirdTask.data).toMatchObject({ merge_pushed_head_sha: savedHead,
      merge_push_base_head_sha: savedHead, merge_push_source: 'caccia' });
    else expect(thirdTask.data).toMatchObject({ base_branch: 'review-base',
      caccia_pushed_head: failed.data!.caccia_pushed_head });
    if (externalChange) {
      git(author, 'fetch', 'origin', 'refs/heads/feature/pr');
      git(author, 'merge', '--ff-only', 'FETCH_HEAD');
      writeFileSync(join(author, 'external.txt'), 'external\n');
      git(author, 'add', 'external.txt');
      git(author, 'commit', '-m', 'External change');
      git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
    }
    mocks.caccia.mockClear(); mocks.status.mockClear(); mocks.execution.mockClear(); mocks.merge.mockClear();
    vi.mocked(runAgent).mockClear();
    effectOutcome = 'success'; unresolvedCount = 0; skipReason = null; effectReason = null;
    configure({ enabled: true, wait_timeout_ms: 17, max_iterations: 2, workflow: 'custom-caccia' });
    const retryHead = git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/feature/pr');
    mocks.caccia.mockImplementation(async (input) => {
      if (input.entry !== 'linked' || !input.expectedInitialHeadSha) throw new Error('Expected current PR head');
      expect(input.expectedInitialHeadSha).toBe(retryHead);
      return { outcome: 'success', headSha: retryHead, unresolvedCount: 0 };
    });
    writeWorkflow();
    mocks.comment.mockReturnValue({ success: true });
    mocks.merge.mockImplementation((_pr, _cwd, _method, expectedSha) => {
      expect(expectedSha).toBe(retryHead);
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(retryHead);
      merged = true;
      return { success: true };
    });
    expect(await retry(thirdTask, thirdRunner)).toBe(entry === 'merge' || !externalChange);
    if (externalChange && entry !== 'merge') {
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(savedHead);
      expect(runAgent).not.toHaveBeenCalled();
      expect(mocks.caccia).not.toHaveBeenCalled();
      expect(mocks.status).not.toHaveBeenCalled();
      expect(mocks.merge).not.toHaveBeenCalled();
    } else {
      expect(mocks.caccia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedInitialHeadSha: retryHead }));
      expect(mocks.status).toHaveBeenCalled();
      expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(123, project, entry === 'merge' ? 'squash' : undefined, retryHead);
    }
  });

  it.each(['merge', 'from_pr', 'from_pr_local_origin', 'from_pr_custom_base'] as const)('%sは同じcloneをCaccia後のheadへ同期しCIとmergeへ渡す', async (entry) => {
    const result = await run(entry);
    const execution = await mocks.execution.mock.calls.at(-1)?.[0];
    expect(result, JSON.stringify(execution)).toEqual({ merged: true });
    expect(mocks.caccia).toHaveBeenCalledOnce();
    expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(123, project, entry === 'merge' ? 'squash' : undefined, effectHead);
    expect(mocks.comment).toHaveBeenCalledWith(123,
      `outcome=success; head=${effectHead}; unresolved=0`, project);
    expect(readFileSync(join(author, 'coderabbit-fix.txt'), 'utf8')).toBe('Caccia change\n');
  });

  it.each(['from_pr', 'cli', 'cli_review'] as const)('%sの実際の生成元を保存してCacciaの適用を分ける', async (entry) => {
    writeFileSync(workflowFile, stringify({ name: 'entry-contract', initial_step: 'inspect',
      steps: [entry === 'cli_review'
        ? { name: 'inspect', persona: 'reviewer', edit: false, instruction: 'Review the PR context',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }
        : { name: 'inspect', kind: 'system', effects: [{ type: 'caccia', pr: 123 }],
        rules: [{ condition: 'when(effect.inspect.caccia.success == true)', next: 'COMPLETE' },
          { condition: 'when(true)', next: 'ABORT' }] }] }));
    if (entry === 'from_pr') {
      const services = createDefaultSystemStepServices({ cwd: project, projectCwd: project, task: 'enqueue PR' });
      const effect = { type: 'enqueue_task', mode: 'from_pr', pr: 123, workflow: workflowFile, task: 'Review PR' } as const;
      expect(await services.executeEffect(effect, effect, {} as WorkflowState)).toMatchObject({ success: true });
    } else {
      const review = mocks.review();
      mocks.review.mockReturnValue({ ...review, comments: [{ author: 'reviewer', body: 'Review PR', createdAt: '2026-10-14T00:00:00Z' }] });
      await addTask(project, undefined, { prNumber: 123, workflow: workflowFile });
    }
    const runner = new TaskRunner(project);
    const task = runner.claimNextTasks(1)[0]!;
    expect(task.data).toMatchObject({ source: 'pr_review', pr_number: 123,
      branch: 'feature/pr', base_branch: 'main', workflow: workflowFile });
    expect(task.data?.caccia_execution_source).toBe(entry === 'from_pr' ? 'from_pr' : undefined);
    mocks.details.mockClear();
    mocks.caccia.mockResolvedValue({ outcome: 'success', headSha: initialHead, unresolvedCount: 0 });
    if (entry === 'cli_review') {
      mocks.details.mockRejectedValue(new Error('Caccia metadata unavailable'));
      vi.mocked(runAgent).mockImplementation(async (_persona, prompt, options) => {
        expect(prompt).toContain('feature/pr');
        options?.onPromptResolved?.({ systemPrompt: 'reviewer', userInstruction: prompt });
        return { persona: 'reviewer', status: 'done', content: 'Reviewed', timestamp: new Date() };
      });
    }
    const result = await executeTaskAndCompleteWithDetails(task, runner, project,
      (request) => runWorkflowExecution({ ...request, runPathsDirectory: join(project, '.takt', 'runs') }),
      { provider: 'mock' }, { outputMode: 'silent' });
    expect(result.success, JSON.stringify(result)).toBe(entry !== 'cli');
    if (entry === 'from_pr') expect(mocks.details).toHaveBeenCalled();
    else expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.caccia).toHaveBeenCalledTimes(entry === 'from_pr' ? 1 : 0);
    expect(runAgent).toHaveBeenCalledTimes(entry === 'cli_review' ? 1 : 0);
  });

  it.each(['root', 'clone'] as const)('%sの既存GitLab PRレビューはmerge metadata APIを要求せずPR文脈を維持する', async (entry) => {
    writeFileSync(workflowFile, stringify({ name: 'readonly-pr', initial_step: 'inspect',
      steps: [{ name: 'inspect', persona: 'coder', edit: false, instruction: 'Review the PR context',
        rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }] }));
    configure({ enabled: true }, 'gitlab');
    const services = createDefaultSystemStepServices({ cwd: project, projectCwd: project, task: 'enqueue' });
    const effect = { type: 'enqueue_task', mode: 'from_pr', pr: 123, workflow: workflowFile, task: 'Review current PR' } as const;
    await services.executeEffect(effect, effect, {} as WorkflowState);
    const task = new TaskRunner(project).claimNextTasks(1)[0]!;
    const resolved = await resolveTaskExecution(task, project, undefined, { outputMode: 'silent' });
    mocks.metadataAvailable = false;
    vi.mocked(runAgent).mockImplementation(async (persona, prompt, options) => {
      expect(prompt).toContain(renderPullRequestContext(resolved.prContext!, 'en'));
      options?.onPromptResolved?.({ systemPrompt: String(persona), userInstruction: prompt });
      return { persona: 'coder', status: 'done', content: 'Reviewed', timestamp: new Date() };
    });
    const result = await runWorkflowExecution({
      cwd: entry === 'root' ? project : resolved.execCwd, projectCwd: project,
      task: task.content, workflowIdentifier: workflowFile, prContext: resolved.prContext,
      outputMode: 'silent', runPathsDirectory: join(project, '.takt', 'runs'), reportDirName: 'readonly-pr-contract',
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.caccia).not.toHaveBeenCalled();
  });

  it.each((['merge', 'from_pr'] as const).flatMap((entry) =>
    (['running', 'old_success', 'merged_results'] as const).map((pipeline) => ({ entry, pipeline }))))(
    'GitLabの$entryは実providerでskip後に返却headのCIを待つ: $pipeline', async ({ entry, pipeline }) => {
    configure({ enabled: true }, 'gitlab');
    mocks.gitlab = true;
    const subfolder = pipeline === 'running' ? 'apps/gitlab' : '';
    if (subfolder !== '') mocks.gitlabUrl = `https://gitlab.example/${subfolder}/org/repo.git`;
    mocks.localRemote = remote;
    const requests: string[][] = [];
    let ciCompleted = false;
    mocks.glab.mockImplementation((args: string[]) => {
      requests.push(args);
      if (args[0] === 'config') {
        expect(args).toEqual(['config', 'get', 'subfolder', '--host', 'gitlab.example']);
        return subfolder === '' ? '' : `/${subfolder}/`;
      }
      if (args[0] === 'auth') return '';
      if (args[0] === 'mr' && args[1] === 'note') return '';
      if (args[0] === 'mr' && args[1] === 'view') return JSON.stringify({ iid: 123, title: 'MR', description: '',
        web_url: `${mocks.gitlabUrl.replace(/\.git$/u, '')}/-/merge_requests/123`, source_branch: 'feature/pr', target_branch: 'main' });
      const endpoint = args.at(-1)!;
      if (endpoint === 'projects/1') return JSON.stringify({ id: 1, path_with_namespace: 'org/repo' });
      if (endpoint === `projects/1/repository/commits/${'c'.repeat(40)}`) return JSON.stringify({
        id: 'c'.repeat(40), parent_ids: ['b'.repeat(40), initialHead],
      });
      if (/\/(diffs|notes|discussions)\?/u.test(endpoint)) return '[]';
      if (endpoint === 'projects/org%2Frepo/merge_requests/123') return JSON.stringify({
        iid: 123, project_id: 1, source_project_id: 1, target_project_id: 1,
        source_branch: 'feature/pr', target_branch: 'main', sha: initialHead, state: 'opened', detailed_merge_status: 'mergeable',
        head_pipeline: {
          sha: pipeline === 'merged_results' ? 'c'.repeat(40) : pipeline === 'old_success' && !ciCompleted ? 'b'.repeat(40) : initialHead,
          project_id: 1, source: pipeline === 'merged_results' ? 'merge_request_event' : 'push',
          ref: pipeline === 'merged_results' ? 'refs/merge-requests/123/merge' : 'feature/pr',
          status: ciCompleted || pipeline === 'old_success' ? 'success' : 'running',
        },
      });
      throw new Error(`Unexpected glab request: ${JSON.stringify(args)}`);
    });
    writeFileSync(workflowFile, stringify({ name: 'gitlab-caccia', initial_step: 'external_review',
      steps: [
        { name: 'external_review', kind: 'system', effects: [{ type: 'caccia', pr: 123 }],
          rules: [{ condition: `when(effect.external_review.caccia.success == true && effect.external_review.caccia.outcome == "skipped" && effect.external_review.caccia.skipReason == "github_unavailable" && effect.external_review.caccia.headSha == "${initialHead}")`, next: 'wait_ci' },
            { condition: 'when(true)', next: 'ABORT' }] },
        { name: 'wait_ci', kind: 'system', system_inputs: [{ type: 'pr_status', source: 'current_pr', as: 'pr' }],
          wait: { until: 'when(context.wait_ci.pr.headSha == effect.external_review.caccia.headSha && context.wait_ci.pr.ci.finished == true)',
            interval_ms: 5, max_retries: 200, on_timeout: 'ABORT' },
          rules: [{ condition: 'when(context.wait_ci.pr.ci.passed == true)', next: 'after_ci' },
            { condition: 'when(true)', next: 'ABORT' }] },
        { name: 'after_ci', kind: 'system', effects: [{ type: 'comment_pr', pr: 123, body: 'CI passed' }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] },
      ] }));
    const runner = new TaskRunner(project);
    const execute = async () => {
      if (entry === 'merge') return executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: workflowFile,
        settings: resolveMergeSettings(undefined), display: { outputMode: 'silent' } });
      const services = createDefaultSystemStepServices({ cwd: project, projectCwd: project, task: 'enqueue' });
      const effect = { type: 'enqueue_task', mode: 'from_pr', pr: 123, workflow: workflowFile, task: 'Review current PR' } as const;
      await services.executeEffect(effect, effect, {} as WorkflowState);
      const task = runner.claimNextTasks(1)[0]!;
      return executeTaskAndCompleteWithDetails(task, runner, project, (request) => runWorkflowExecution({ ...request,
        runPathsDirectory: join(project, '.takt', 'runs') }), { provider: 'mock' }, { outputMode: 'silent' });
    };
    const running = execute();
    const completed = vi.fn();
    void running.then(completed, completed);
    try {
      await vi.waitFor(() => {
        const saved = runner.listAllTaskItems().find((task) => task.kind === 'running');
        expect(saved?.data).toMatchObject(entry === 'merge'
          ? { merge_pushed_head_sha: initialHead, merge_push_source: 'caccia' }
          : { caccia_pushed_head: { headSha: initialHead } });
        expect(requests.filter((args) => args.at(-1) === 'projects/org%2Frepo/merge_requests/123').length)
          .toBeGreaterThan(entry === 'merge' ? 3 : 2);
      }, { timeout: 60_000 });
      expect(completed).not.toHaveBeenCalled();
      expect(requests.filter((args) => args[0] === 'mr' && args[1] === 'note')).toEqual([]);
    } finally {
      ciCompleted = true;
      await running;
    }
    const result = await running;
    expect(entry === 'merge' ? (result as { merged: boolean }).merged : (result as { success: boolean }).success).toBe(entry !== 'merge');
    expect(requests.filter((args) => args[0] === 'mr' && args[1] === 'note')).toEqual([
      ['mr', 'note', '123', '--message', 'CI passed'],
    ]);
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.caccia).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each([
    { withEffect: false, withMetadata: false },
    { withEffect: true, withMetadata: false },
    { withEffect: true, withMetadata: true },
  ])('実行元未指定では追加取得やCaccia実行を行わない: %j', async ({ withEffect, withMetadata }) => {
    writeFileSync(workflowFile, stringify({ name: 'pipeline-pr', initial_step: 'inspect',
      steps: [withEffect
        ? { name: 'inspect', kind: 'system', effects: [{ type: 'caccia', pr: 123 }],
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }
        : { name: 'inspect', persona: 'coder', edit: false, instruction: 'Review the PR context',
          rules: [{ condition: 'when(true)', next: 'COMPLETE' }] }] }));
    const clone = join(root, 'pipeline-clone');
    git(root, 'clone', remote, clone);
    git(clone, 'checkout', 'feature/pr');
    const prContext = { source: 'pr_review' as const, prNumber: 123,
      baseBranch: 'main', headBranch: 'feature/pr', baseBranchSource: 'pull_request' as const,
      baseDiffRef: 'refs/remotes/origin/main', headDiffRef: 'refs/heads/feature/pr' };
    vi.mocked(runAgent).mockImplementation(async (_persona, prompt, options) => {
      expect(prompt).toContain(renderPullRequestContext(prContext, 'en'));
      options?.onPromptResolved?.({ systemPrompt: 'reviewer', userInstruction: prompt });
      return { persona: 'reviewer', status: 'done', content: 'Reviewed', timestamp: new Date() };
    });
    mocks.details.mockRejectedValue(new Error('Caccia metadata unavailable'));
    const request = { cwd: clone, projectCwd: project, task: 'Review PR', workflowIdentifier: workflowFile,
      prContext, outputMode: 'silent' as const, runPathsDirectory: join(project, '.takt', 'runs'),
      ...(withMetadata ? { prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main',
        headSha: initialHead, headRepositoryUrl: remote, headRepositoryPushUrls: [remote] } } : {}),
      reportDirName: 'pipeline-contract' };
    expect((await runWorkflowExecution(request)).success).toBe(!withEffect);
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.caccia).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledTimes(withEffect ? 0 : 1);
    if (!withMetadata) {
      await expect(runWorkflowExecution({ ...request, cacciaExecutionSource: 'from_pr' })).rejects.toThrow();
      expect(mocks.details).toHaveBeenCalledOnce();
    }
  });

  it('修正push後のrate limitも最新headのskippedとして後続へ渡す', async () => {
    effectOutcome = 'skipped'; skipReason = 'review_rate_limited'; effectReason = 'Review rate limited';
    expect(await run('merge')).toEqual({ merged: true });
    expect(mocks.caccia).toHaveBeenCalledOnce();
    expect(mocks.comment).toHaveBeenCalledWith(123,
      `outcome=skipped; head=${effectHead}; unresolved=0`, project);
    expect(mocks.merge).toHaveBeenCalledWith(123, project, 'squash', effectHead);
  });

  it('limitを実行エラーへ変換せず件数と同期後headを返す', async () => {
    effectOutcome = 'limit'; unresolvedCount = 3;
    expect(await run('merge')).toEqual({ merged: false });
    expect(mocks.caccia).toHaveBeenCalledOnce();
    expect(git(activeClone, 'rev-parse', 'HEAD')).toBe(effectHead);
    expect(mocks.comment).toHaveBeenCalledWith(123,
      `outcome=limit; head=${effectHead}; unresolved=3`, project);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it.each([undefined, { enabled: false }])('設定%jでは待機処理を呼ばずskippedから続行する', async (settings) => {
    configure(settings);
    effectOutcome = 'skipped'; skipReason = 'config_disabled';
    writeWorkflow();
    mocks.merge.mockImplementation((_pr, _cwd, _method, expectedSha) => {
      effectHead = expectedSha;
      merged = true;
      return { success: true };
    });
    await executePrWorkflow({ projectCwd: project, prNumber: 123, workflow: workflowFile,
      settings: resolveMergeSettings(undefined), display: { outputMode: 'silent' } });
    expect(mocks.caccia).not.toHaveBeenCalled();
    expect(mocks.merge).toHaveBeenCalledOnce();
    expect(mocks.comment).toHaveBeenCalledWith(123,
      `outcome=skipped; head=${effectHead}; unresolved=0`, project);
  });

  it('本体例外をerror結果へ変換して後続コメントへ渡す', async () => {
    const error = 'Pull request #123 head changed before resolving review thread';
    mocks.caccia.mockRejectedValue(new Error(error));
    expect(await run('merge')).toEqual({ merged: false });
    expect(mocks.comment).toHaveBeenCalledWith(123, expect.stringContaining(error), project);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it.each(['unchanged', 'initial_head', 'clone_head', 'external_head', 'fetch_head', 'fast_forward'] as const)(
    'Cacciaのpush後の失敗を保存し同じcloneで再投入する: %s', async (condition) => {
      const worker = mocks.caccia.getMockImplementation()!;
      mocks.caccia.mockImplementationOnce(async (input) => {
        await worker(input);
        throw new Error('Timed out waiting for CodeRabbit after push');
      });
      expect(await run('merge')).toEqual({ merged: false });
      const runner = new TaskRunner(project);
      const failed = runner.listFailedTasks()[0]!;
      const clone = activeClone;
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(pushedHead);
      expect(failed.data).toMatchObject({ merge_pushed_head_sha: effectHead,
        merge_push_base_head_sha: pushedHead, merge_push_source: 'caccia' });
      runner.requeueTask(failed.name, ['failed']);
      const claimed = runner.claimNextTasks(1)[0]!;
      expect(claimed.worktreePath).toBe(clone);
      expect(claimed.data).toMatchObject({ merge_pushed_head_sha: effectHead,
        merge_push_base_head_sha: pushedHead, merge_push_source: 'caccia' });
      if (condition === 'initial_head' || condition === 'clone_head') {
        const externalHead = condition === 'initial_head' ? initialHead : pushedHead;
        git(author, 'push', '--force', 'origin', `${externalHead}:refs/heads/feature/pr`);
      }
      if (condition === 'external_head' || condition === 'fetch_head') {
        const confirmed = await mocks.details();
        writeFileSync(join(author, 'external.txt'), 'external\n');
        git(author, 'add', 'external.txt');
        git(author, 'commit', '-m', 'External change');
        git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
        if (condition === 'fetch_head') mocks.details.mockResolvedValue(confirmed);
      }
      if (condition === 'fast_forward') {
        git(clone, 'config', 'user.name', 'Retained Author');
        git(clone, 'config', 'user.email', 'retained@example.com');
        writeFileSync(join(clone, 'local.txt'), 'local\n');
        git(clone, 'add', 'local.txt');
        git(clone, 'commit', '-m', 'Retained local change');
      }
      const beforeRetry = git(clone, 'rev-parse', 'HEAD');
      const remoteBeforeRetry = git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/feature/pr');
      if (condition === 'initial_head' || condition === 'clone_head') {
        expect(remoteBeforeRetry).not.toBe(effectHead);
        expect(git(root, '--git-dir', remote, 'merge-base', effectHead, remoteBeforeRetry))
          .toBe(remoteBeforeRetry);
      }
      let synchronizedHead: string | undefined;
      mocks.execution.mockClear();
      mocks.status.mockClear();
      mocks.caccia.mockClear();
      mocks.caccia.mockImplementation(async (input) => {
        synchronizedHead = git(clone, 'rev-parse', 'HEAD');
        expect(input.entry === 'linked' && input.expectedInitialHeadSha).toBe(synchronizedHead);
        expect(git(clone, 'merge-base', beforeRetry, 'HEAD')).toBe(beforeRetry);
        expect(git(clone, 'merge-base', remoteBeforeRetry, 'HEAD')).toBe(remoteBeforeRetry);
        if (condition === 'fast_forward') expect(readFileSync(join(clone, 'local.txt'), 'utf8')).toBe('local\n');
        if (condition === 'external_head') expect(readFileSync(join(clone, 'external.txt'), 'utf8')).toBe('external\n');
        return { outcome: 'success', headSha: synchronizedHead, unresolvedCount: 0 };
      });
      mocks.merge.mockImplementation((_pr, _cwd, _method, expectedSha) => {
        expect(expectedSha).toBe(synchronizedHead);
        expect(git(clone, 'rev-parse', 'HEAD')).toBe(synchronizedHead);
        merged = true;
        return { success: true };
      });
      const retry = executePersistedPrMergeTask(claimed, runner, project, undefined, { outputMode: 'silent' });
      if (condition !== 'fetch_head' && condition !== 'initial_head' && condition !== 'clone_head') {
        expect(await retry).toEqual({ merged: true });
        expect(mocks.execution).toHaveBeenCalledOnce();
        expect(mocks.caccia).toHaveBeenCalledOnce();
        expect(mocks.merge).toHaveBeenCalledWith(123, project, 'squash', synchronizedHead);
        expect(mocks.status).toHaveBeenCalled();
        expect(mocks.comment).toHaveBeenCalledWith(123,
          `outcome=success; head=${synchronizedHead}; unresolved=0`, project);
      } else {
        if (condition === 'fetch_head') {
          await expect(retry).rejects.toThrow('PR head changed during retry synchronization');
        } else {
          await expect(retry).rejects.toThrow();
        }
        expect(git(clone, 'rev-parse', 'HEAD')).toBe(beforeRetry);
        expect(mocks.execution).not.toHaveBeenCalled();
        expect(mocks.status).not.toHaveBeenCalled();
        expect(mocks.caccia).not.toHaveBeenCalled();
        expect(mocks.merge).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['unchanged', 'initial_head', 'clone_head', 'external_head', 'fetch_head', 'fast_forward', 'threat'] as const)(
    'from_prの実enqueueからpush後の失敗・再投入を同じcloneで扱う: %s', async (condition) => {
      const worker = mocks.caccia.getMockImplementation()!;
      mocks.caccia.mockImplementationOnce(async (input) => {
        await worker(input);
        throw new Error('Timed out waiting for CodeRabbit after push');
      });
      await run('from_pr_custom_base', false);
      const runner = new TaskRunner(project);
      const failed = runner.listFailedTasks()[0]!;
      const clone = activeClone;
      const saved = { headSha: effectHead, baseBranch: 'main', headRepositoryUrl: remote,
        headRepositoryPushUrls: [remote] };
      expect(git(clone, 'rev-parse', 'HEAD')).toBe(pushedHead);
      expect(failed.data).toMatchObject({ caccia_execution_source: 'from_pr',
        base_branch: 'review-base', caccia_pushed_head: saved });
      runner.requeueTask(failed.name, ['failed']);
      const claimed = new TaskRunner(project).claimNextTasks(1)[0]!;
      expect(claimed.worktreePath).toBe(clone);
      expect(claimed.data?.caccia_pushed_head).toEqual(saved);
      if (condition === 'initial_head' || condition === 'clone_head') {
        git(author, 'push', '--force', 'origin',
          `${condition === 'initial_head' ? initialHead : pushedHead}:refs/heads/feature/pr`);
      }
      if (condition === 'external_head' || condition === 'fetch_head') {
        const confirmed = await mocks.details();
        writeFileSync(join(author, 'external.txt'), 'external\n');
        git(author, 'add', 'external.txt');
        git(author, 'commit', '-m', 'External change');
        git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
        if (condition === 'fetch_head') mocks.details.mockResolvedValue(confirmed);
      }
      if (condition === 'fast_forward') {
        git(clone, 'config', 'user.name', 'Retained Author');
        git(clone, 'config', 'user.email', 'retained@example.com');
        writeFileSync(join(clone, 'local.txt'), 'local\n');
        git(clone, 'add', 'local.txt');
        git(clone, 'commit', '-m', 'Retained local change');
      }
      if (condition === 'threat') mocks.threat.mockResolvedValue({
        passed: false, comment: '危険な定義: .github/workflows/@org/team',
      });
      const beforeRetry = git(clone, 'rev-parse', 'HEAD');
      mocks.caccia.mockClear(); mocks.status.mockClear(); mocks.comment.mockClear(); mocks.threat.mockClear();
      mocks.caccia.mockImplementation(async (input) => {
        expect(input.entry === 'linked' && input.expectedInitialHeadSha).toBe(effectHead);
        return { outcome: 'success', headSha: effectHead, unresolvedCount: 0 };
      });
      const result = await executeTaskAndCompleteWithDetails(claimed, runner, project, async (request) => {
        expect(request.cwd).toBe(clone);
        expect(request.prContext?.baseBranch).toBe('review-base');
        return runWorkflowExecution({ ...request, runPathsDirectory: join(project, '.takt', 'runs') });
      }, { provider: 'mock' }, { outputMode: 'silent' });
      expect(result.success).toBe(condition === 'unchanged');
      if (condition === 'unchanged') {
        expect(git(clone, 'rev-parse', 'HEAD')).toBe(effectHead);
        expect(mocks.caccia).toHaveBeenCalledOnce();
        expect(mocks.merge).toHaveBeenCalledWith(123, project, undefined, effectHead);
        expect(mocks.status).toHaveBeenCalled();
        expect(mocks.threat).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'refs/takt/pr-base/main' }));
      } else {
        expect(git(clone, 'rev-parse', 'HEAD')).toBe(condition === 'threat' ? effectHead : beforeRetry);
        expect(mocks.caccia).not.toHaveBeenCalled();
        expect(mocks.status).not.toHaveBeenCalled();
        expect(mocks.merge).not.toHaveBeenCalled();
        if (condition === 'threat') expect(mocks.comment).toHaveBeenCalledExactlyOnceWith(123,
          '危険な定義: .github/workflows/＠org/team', project);
        else expect(mocks.comment).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['initial_review_unavailable', 'review_rate_limited', 'review_skipped'] as const)(
    '%sを理由付きskippedとしてルールから参照できる', async (reason) => {
      effectOutcome = 'skipped'; skipReason = reason; effectReason = 'Review is unavailable';
      mocks.caccia.mockImplementation(async (input) => {
        if (input.entry !== 'linked' || !input.expectedInitialHeadSha) throw new Error('Expected current PR head');
        effectHead = input.expectedInitialHeadSha;
        return { outcome: 'skipped', unresolvedCount: 0, reason: effectReason!, skipReason: reason,
          ...(reason === 'initial_review_unavailable' ? {} : { headSha: effectHead }) };
      });
      mocks.merge.mockImplementation((_pr, _cwd, _method, expectedSha) => {
        expect(expectedSha).toBe(effectHead);
        merged = true;
        return { success: true };
      });
      expect(await run('merge')).toEqual({ merged: true });
      expect(mocks.caccia).toHaveBeenCalledOnce();
      expect(mocks.comment).toHaveBeenCalledWith(123,
        `outcome=skipped; head=${effectHead}; unresolved=0`, project);
    },
  );

  it.each(['number', 'headBranch', 'baseBranch', 'headRepositoryUrl', 'headRepositoryPushUrls'] as const)(
    'Caccia中にPRの%sが変われば取り込まずerrorをコメントする', async (field) => {
      const worker = mocks.caccia.getMockImplementation()!;
      const details = mocks.details.getMockImplementation()!;
      mocks.caccia.mockImplementation(async (input) => {
        const result = await worker(input);
        const changed = field === 'number' ? 456 : field === 'headRepositoryPushUrls' ? ['/different'] : 'different';
        mocks.details.mockImplementation(async () => ({ ...await details(), [field]: changed }));
        return result;
      });
      expect(await run('merge')).toEqual({ merged: false });
      expect(git(activeClone, 'rev-parse', 'HEAD')).toBe(pushedHead);
      expect(mocks.comment).toHaveBeenCalledWith(123, expect.stringMatching(/\S/u), project);
      expect(mocks.merge).not.toHaveBeenCalled();
    },
  );

  it('効果が返したheadとPRの最新headが違う場合はcloneを更新しない', async () => {
    const worker = mocks.caccia.getMockImplementation()!;
    mocks.caccia.mockImplementation(async (input) => {
      const result = await worker(input);
      return { ...result, headSha: pushedHead };
    });
    expect(await run('merge')).toEqual({ merged: false });
    expect(git(activeClone, 'rev-parse', 'HEAD')).toBe(pushedHead);
    expect(mocks.comment).toHaveBeenCalledWith(123, expect.stringMatching(/\S/u), project);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('PR確認後のfetchで別headを取得した場合はcloneをfast-forwardしない', async () => {
    const worker = mocks.caccia.getMockImplementation()!;
    const details = mocks.details.getMockImplementation()!;
    mocks.caccia.mockImplementation(async (input) => {
      const result = await worker(input);
      mocks.details.mockImplementationOnce(async () => {
        const confirmed = await details();
        writeFileSync(join(author, 'external.txt'), 'External push\n');
        git(author, 'add', 'external.txt');
        git(author, 'commit', '-m', 'External change');
        git(author, 'push', 'origin', 'HEAD:refs/heads/feature/pr');
        return confirmed;
      });
      return result;
    });
    expect(await run('merge')).toEqual({ merged: false });
    expect(git(activeClone, 'rev-parse', 'HEAD')).toBe(pushedHead);
    expect(mocks.comment).toHaveBeenCalledWith(123, expect.stringMatching(/\S/u), project);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it('forkの修正後の再検査に失敗した場合はerrorを返してmergeしない', async () => {
    sameRepository = false;
    mocks.threat.mockResolvedValueOnce({ passed: true }).mockResolvedValue({ passed: false, comment: 'unsafe change' });
    expect(await run('merge')).toEqual({ merged: false });
    expect(mocks.caccia).toHaveBeenCalledOnce();
    expect(mocks.threat).toHaveBeenCalledTimes(2);
    expect(mocks.comment).toHaveBeenCalledWith(123, expect.stringMatching(/\S/u), project);
    expect(mocks.merge).not.toHaveBeenCalled();
  });
});
