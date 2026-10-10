import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../agents/runner.js';
import type { CacciaDependencies } from '../features/caccia/index.js';
import { runCaccia, runLinkedCacciaSafely } from '../features/caccia/index.js';
import * as githubPr from '../infra/github/pr.js';
import * as taskClone from '../infra/task/clone-exec.js';
import * as taskGit from '../infra/task/git.js';
import * as slackWebhook from '../shared/utils/slackWebhook.js';
import { getLabel } from '../shared/i18n/index.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';
import * as workflowApi from '../features/tasks/execute/workflowExecutionApi.js';
import * as config from '../infra/config/index.js';
import {
  invalidateGlobalConfigCache,
  loadGlobalConfig,
  saveGlobalConfig,
} from '../infra/config/global/globalConfigCore.js';
import { generateReportDir } from '../shared/utils/reportDir.js';
import { stripAnsi } from '../shared/utils/text.js';
import { TaskPrefixWriter } from '../shared/ui/TaskPrefixWriter.js';

const { mockRunAgent, mockRunStatusJudgmentPhase } = vi.hoisted(() => ({
  mockRunAgent: vi.fn(),
  mockRunStatusJudgmentPhase: vi.fn().mockResolvedValue({
    label: 'All valid findings are fixed and every thread has a complete decision report',
    method: 'phase3_tag',
  }),
}));

vi.mock('../agents/runner.js', () => ({ runAgent: mockRunAgent }));
vi.mock('../core/workflow/phase-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/workflow/phase-runner.js')>();
  return { ...actual, runStatusJudgmentPhase: mockRunStatusJudgmentPhase };
});

const temporaryRoots: string[] = [];

describe('Caccia report lifecycle', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
    invalidateGlobalConfigCache();
  });

  it.each([false, true])('distinguishes a pushed-head review wait ending with rate limit=%s after cleanup', async (rateLimited) => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-pushed-wait-'));
    temporaryRoots.push(projectCwd);
    const reportDirectory = join(projectCwd, 'reports');
    mkdirSync(reportDirectory);
    writeFileSync(join(reportDirectory, 'caccia-decisions.json'), JSON.stringify([
      { thread_id: 'finding', valid: true, reason: 'Corrected the changed call site.' },
    ]));
    const initialHead = 'a'.repeat(40);
    const pushedHead = 'b'.repeat(40);
    let currentHead = initialHead;
    const configSpy = vi.spyOn(config, 'resolveConfigValue').mockImplementation((_cwd, key) =>
      key === 'vcsProvider' ? 'github' : undefined);
    const status = vi.spyOn(githubPr, 'fetchCodeRabbitReviewStatus').mockImplementation(async () => ({
      headSha: currentHead, hasCodeRabbitPost: true, hasCodeRabbitStatus: false,
      reviewedHeadShas: [initialHead], unresolvedThreadCount: 0,
      ...(rateLimited && currentHead === pushedHead ? {
        rateLimit: { retryAt: undefined, createdAt: 0, isCommandReply: true },
      } : {}),
    }));
    const threads = vi.spyOn(githubPr, 'fetchCodeRabbitReviewThreads').mockResolvedValue([{
      id: 'finding', author: 'coderabbitai', body: 'Correct the changed call site.', replies: [],
      path: 'src/example.ts', url: 'https://github.com/org/repo/pull/42#discussion_r1', isOutdated: false,
    }]);
    const details = vi.spyOn(githubPr, 'fetchCacciaPullRequestDetails').mockResolvedValue({
      number: 42, headBranch: 'feature/review', headSha: initialHead,
      headRepositoryUrl: 'https://github.com/org/repo.git', headRepositoryPushUrls: ['https://github.com/org/repo.git'],
    });
    const clone = vi.spyOn(taskClone, 'cloneAndIsolateAbortable').mockResolvedValue(undefined);
    const git = vi.spyOn(taskClone, 'runGitCommandAbortable').mockImplementation(async (_cwd, args) => ({
      stdout: args[0] === 'rev-parse' ? (args[1] === '--abbrev-ref' ? 'feature/review' : currentHead) : '', stderr: '',
    }));
    const workflow = vi.spyOn(workflowApi, 'runWorkflowExecution').mockResolvedValue({ success: true, reportDirectory });
    const commit = vi.spyOn(taskGit, 'stageAndCommit').mockImplementation(async () => {
      currentHead = pushedHead;
      return pushedHead;
    });
    const head = vi.spyOn(githubPr, 'fetchCacciaPullRequestHeadSha').mockImplementation(async () => currentHead);
    const resolve = vi.spyOn(githubPr, 'resolveReviewThread').mockResolvedValue(undefined);
    const comment = vi.spyOn(githubPr, 'commentOnPr').mockResolvedValue({ success: true });
    const webhook = vi.spyOn(slackWebhook, 'getSlackWebhookUrl').mockReturnValue(undefined);
    const controller = new AbortController();
    let terminal: Promise<unknown> | undefined;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      terminal = runCaccia({ entry: 'standalone', prNumber: 42, projectCwd, abortSignal: controller.signal,
        settings: { enabled: false, waitTimeoutMs: 10_000, maxIterations: 1, workflow: 'caccia' },
      }).then(() => undefined, (error: unknown) => error);
      let finished = false;
      void terminal.then(() => { finished = true; });
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 30_000, interval: 1_000 });
      const error = await terminal;

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(pushedHead);
      if (rateLimited) expect((error as Error).message).toMatch(/rate.?limit|レート制限/iu);
      else expect((error as Error).message).toMatch(/Timed out/u);
      expect(threads).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith('finding', projectCwd, expect.any(AbortSignal));
      expect(commit).toHaveBeenCalledOnce();
      const cloneCwd = clone.mock.calls[0]![1];
      expect(existsSync(cloneCwd)).toBe(false);
      expect(status.mock.calls.length).toBeGreaterThan(1);
      expect(comment).toHaveBeenCalledTimes(rateLimited ? 1 : 0);
    } finally {
      controller.abort();
      await terminal;
      for (const spy of [configSpy, status, threads, details, clone, git, workflow, commit, head, resolve, comment, webhook]) spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    { mode: 'terminal', language: 'en' },
    { mode: 'prefixed', language: 'en' },
    { mode: 'silent', language: 'en' },
    { mode: 'silent', language: 'ja' },
  ] as const)('renders the real $language Caccia workflow using the $mode display and applies its policy', async ({ mode, language }) => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-workflow-'));
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-display-clone-'));
    temporaryRoots.push(projectCwd, cloneCwd);
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), `language: ${language}\n`, 'utf8');
    const policy = readFileSync(new URL(`../../builtins/${language}/facets/policies/caccia-review.md`, import.meta.url), 'utf8').trim();
    mockRunStatusJudgmentPhase.mockResolvedValueOnce({
      label: language === 'ja'
        ? '妥当な指摘をすべて修正し、全スレッドの判断レポートを完成した'
        : 'All valid findings are fixed and every thread has a complete decision report',
      method: 'phase3_tag',
    });
    const chunks: string[] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); }),
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); }),
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); }),
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; }),
    ];
    const decisions = [{ thread_id: 'display-thread', valid: false, reason: 'Intentional behavior.' }];
    let calls = 0;
    mockRunAgent.mockImplementation(async (persona, instruction, options) => {
      calls += 1;
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      options?.onStream?.({ type: 'text', data: { text: 'display-stream-marker\n' } });
      if (calls === 1) {
        options?.onStream?.({ type: 'tool_output', data: { output: 'safe \x1b]52;c;' } });
        options?.onStream?.({ type: 'tool_output', data: { output: 'c2FmZQ==\x07\nnext\n' } });
        options?.onStream?.({ type: 'tool_output', data: { output: 'safe 52;c;c2FmZQ==\n' } });
        options?.onStream?.({ type: 'tool_result', data: { content: '', isError: false } });
      }
      return {
        persona: 'coder', status: 'done', timestamp: new Date(),
        content: calls === 1 ? 'Reviewed supplied thread.' : JSON.stringify(decisions),
        sessionId: `caccia-display-session-${calls}`,
      };
    });
    const display = mode === 'prefixed'
      ? { taskPrefix: 'parent-task-name', taskDisplayLabel: 'parent-display-label', taskColorIndex: 2 }
      : {};
    try {
      const result = await runWorkflowExecution({
        task: 'Review the display-thread for PR #42.', cwd: cloneCwd, projectCwd,
        workflowIdentifier: 'caccia', runPathsDirectory: join(projectCwd, '.takt', 'runs'),
        agentOverrides: { provider: 'mock', model: 'caccia-display-test' },
        outputMode: mode === 'silent' ? 'silent' : 'terminal', ...display,
      });
      expect(result.success, JSON.stringify(result)).toBe(true);
      const phaseOneInstruction = vi.mocked(runAgent).mock.calls[0]![1];
      expect(policy.length).toBeGreaterThan(0);
      expect(phaseOneInstruction).toContain(policy);
      const raw = chunks.join('');
      const text = stripAnsi(raw);
      if (mode === 'silent') {
        expect(raw).toBe('');
      } else {
        expect(raw).not.toMatch(/\x1b\]|[\x07\x80-\x9f]/u);
        expect(raw).toContain('safe');
        expect(raw).toContain('next');
        expect(raw).toContain('safe 52;c;c2FmZQ==');
        expect(text).toContain('Running Workflow: caccia');
        expect(text).toMatch(/\[1\/\d+\]/u);
        expect(text).toContain('display-stream-marker');
        expect(text).toContain('Status:');
        if (mode === 'prefixed') {
          const prefixLines: string[] = [];
          new TaskPrefixWriter({ taskName: 'parent-task-name', displayLabel: 'parent-display-label', colorIndex: 2, writeFn: (line) => prefixLines.push(line) }).writeLine('marker');
          const prefix = prefixLines[0]!.split('marker')[0]!.trimEnd();
          for (const line of raw.split('\n').filter((line) => stripAnsi(line).trim() !== '')) {
            expect(line.startsWith(prefix)).toBe(true);
          }
        }
      }
      rmSync(cloneCwd, { recursive: true, force: false });
      expect(JSON.parse(readFileSync(join(result.reportDirectory!, 'caccia-decisions.json'), 'utf8'))).toEqual(decisions);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it.each([
    { mode: 'terminal', outputMode: 'terminal', taskPrefix: undefined, taskDisplayLabel: undefined, taskColorIndex: undefined },
    { mode: 'prefixed label', outputMode: 'terminal', taskPrefix: 'parent-task-name', taskDisplayLabel: 'parent-display-label', taskColorIndex: 2 },
    { mode: 'prefixed default label', outputMode: 'terminal', taskPrefix: 'parent-task-name', taskDisplayLabel: undefined, taskColorIndex: 2 },
    { mode: 'prefixed other label', outputMode: 'terminal', taskPrefix: 'parent-task-name', taskDisplayLabel: 'other-label', taskColorIndex: 2 },
    { mode: 'prefixed other color', outputMode: 'terminal', taskPrefix: 'parent-task-name', taskDisplayLabel: 'parent-display-label', taskColorIndex: 1 },
    { mode: 'silent', outputMode: 'silent', taskPrefix: 'parent-task-name', taskDisplayLabel: 'parent-display-label', taskColorIndex: 2 },
  ] as const)('inherits the parent $mode display for progress and the real workflow through a successful linked wrapper', async ({ outputMode, taskPrefix, taskDisplayLabel, taskColorIndex }) => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-linked-display-'));
    temporaryRoots.push(projectCwd);
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), [
      'language: en', 'vcs_provider: github', 'provider: mock',
      'caccia:', '  enabled: true', '  max_iterations: 1',
    ].join('\n'), 'utf8');
    const globalConfigDir = join(projectCwd, 'global-config');
    mkdirSync(globalConfigDir);
    writeFileSync(join(globalConfigDir, 'config.yaml'), 'notification_sound: false\n', 'utf8');
    vi.stubEnv('TAKT_CONFIG_DIR', globalConfigDir);
    invalidateGlobalConfigCache();
    vi.stubEnv('TAKT_VERBOSE', 'false');
    const headSha = 'a'.repeat(40);
    const decisions = [{ thread_id: 'display-thread', valid: false, reason: 'Intentional behavior.' }];
    const chunks: string[] = [];
    const spies: Array<{ mockRestore(): void }> = [
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); }),
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); }),
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { chunks.push(args.join(' ') + '\n'); }),
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { chunks.push(String(chunk)); return true; }),
    ];
    const statusSpy = vi.spyOn(githubPr, 'fetchCodeRabbitReviewStatus').mockResolvedValue({
      headSha, hasCodeRabbitPost: true, hasCodeRabbitStatus: false, unresolvedThreadCount: 0, reviewedHeadShas: [headSha],
    });
    const threadsSpy = vi.spyOn(githubPr, 'fetchCodeRabbitReviewThreads')
      .mockResolvedValueOnce([{
        id: 'display-thread', author: 'coderabbitai', body: 'Review the display behavior.', replies: [],
        path: 'src/example.ts', url: 'https://github.com/org/repo/pull/42#discussion_r1', isOutdated: false,
      }])
      .mockResolvedValueOnce([]);
    const detailsSpy = vi.spyOn(githubPr, 'fetchCacciaPullRequestDetails').mockResolvedValue({
      number: 42, headBranch: 'feature/display', headSha,
      headRepositoryUrl: 'https://github.com/org/repo.git',
      headRepositoryPushUrls: ['https://github.com/org/repo.git'],
    });
    const cloneSpy = vi.spyOn(taskClone, 'cloneAndIsolateAbortable').mockImplementation(async (_project, cloneCwd) => {
      temporaryRoots.push(cloneCwd);
    });
    const gitSpy = vi.spyOn(taskClone, 'runGitCommandAbortable').mockImplementation(async (_cwd, args) => ({
      stdout: args[0] === 'rev-parse' ? `${headSha}\n` : '', stderr: '',
    }));
    const commitSpy = vi.spyOn(taskGit, 'stageAndCommit').mockResolvedValue(undefined);
    const headSpy = vi.spyOn(githubPr, 'fetchCacciaPullRequestHeadSha').mockResolvedValue(headSha);
    const resolveSpy = vi.spyOn(githubPr, 'resolveReviewThread').mockResolvedValue(undefined);
    const webhookSpy = vi.spyOn(slackWebhook, 'getSlackWebhookUrl').mockReturnValue(undefined);
    spies.push(statusSpy, threadsSpy, detailsSpy, cloneSpy, gitSpy, commitSpy, headSpy, resolveSpy, webhookSpy);
    let agentCalls = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      agentCalls += 1;
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '', userInstruction: instruction,
      });
      options?.onStream?.({ type: 'text', data: { text: 'linked-workflow-stream-marker\n' } });
      return {
        persona: 'coder', status: 'done', timestamp: new Date(),
        content: agentCalls === 1 ? 'Reviewed supplied thread.' : JSON.stringify(decisions),
        sessionId: `linked-display-session-${agentCalls}`,
      };
    });
    try {
      await runLinkedCacciaSafely(projectCwd, 'https://github.com/org/repo/pull/42', undefined, {
        outputMode, taskPrefix, taskDisplayLabel, taskColorIndex,
      });
      expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
      expect(mockRunStatusJudgmentPhase).toHaveBeenCalledOnce();
      expect(commitSpy).toHaveBeenCalledOnce();
      expect(resolveSpy).toHaveBeenCalledWith('display-thread', projectCwd, expect.any(AbortSignal));
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect(threadsSpy).toHaveBeenCalledTimes(2);
      for (const call of threadsSpy.mock.calls) {
        expect(call).toEqual([42, projectCwd, headSha, expect.any(AbortSignal)]);
      }
      const cloneCwd = cloneSpy.mock.calls[0]![1];
      expect(existsSync(cloneCwd)).toBe(false);
      const runsDirectory = join(projectCwd, '.takt', 'runs');
      const reports = readdirSync(runsDirectory, { recursive: true, encoding: 'utf8' })
        .filter((path) => path.endsWith(join('reports', 'caccia-decisions.json')));
      expect(reports).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(runsDirectory, reports[0]!), 'utf8'))).toEqual(decisions);
      const raw = chunks.join('');
      if (outputMode === 'silent') {
        expect(raw).toBe('');
      } else {
        const text = stripAnsi(raw);
        for (const progress of [
          getLabel('caccia.waitingForReview', 'en'),
          getLabel('caccia.threads', 'en', { count: '1' }),
          getLabel('caccia.iteration', 'en', { current: '1', maximum: '1' }),
          getLabel('caccia.cloning', 'en'),
          getLabel('caccia.resolved', 'en', { thread: 'display-thread' }),
          getLabel('caccia.threads', 'en', { count: '0' }),
          getLabel('caccia.success', 'en'),
        ]) expect(text).toContain(progress);
        expect(text).toContain('Running Workflow: caccia');
        expect(text).toMatch(/\[1\/\d+\]/u);
        expect(text).toContain('linked-workflow-stream-marker');
        expect(text).toContain('Status:');
        const lines = raw.split('\n').filter((line) => stripAnsi(line).trim() !== '');
        if (taskPrefix === undefined) {
          for (const line of lines) expect(line).not.toMatch(/^\x1b\[(?:33|35)m\[/u);
        } else {
          const label = taskDisplayLabel ?? 'pare';
          const color = taskColorIndex === 2 ? '\x1b[35m' : '\x1b[33m';
          for (const line of lines) expect(line.startsWith(`${color}[${label}]\x1b[0m`)).toBe(true);
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('reads and writes Caccia settings through an isolated global config file', () => {
    const globalConfigDir = mkdtempSync(join(tmpdir(), 'takt-caccia-global-config-'));
    temporaryRoots.push(globalConfigDir);
    vi.stubEnv('TAKT_CONFIG_DIR', globalConfigDir);
    invalidateGlobalConfigCache();
    const settings = {
      enabled: true,
      waitTimeoutMs: 900_000,
      maxIterations: 6,
      workflow: 'global-caccia',
    };

    saveGlobalConfig({ ...loadGlobalConfig(), caccia: settings });
    invalidateGlobalConfigCache();

    expect(loadGlobalConfig().caccia).toEqual(settings);
    const configText = readFileSync(join(globalConfigDir, 'config.yaml'), 'utf8');
    expect(configText).toContain('wait_timeout_ms: 900000');
    expect(configText).not.toContain('waitTimeoutMs');
  });

  it('keeps the workflow report after deleting its temporary clone', async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-project-'));
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-clone-'));
    temporaryRoots.push(projectCwd, cloneCwd);
    const reportPath = join(projectCwd, '.takt', 'runs', 'caccia-run', 'report.md');
    const threads = [{ id: 'finding-1', author: 'coderabbitai', body: 'Fix the changed call site.', replies: [] }];
    const waitForCodeRabbitReview = vi.fn(async () => ({ outcome: 'Completed' as const, headSha: 'reviewed-head' }));
    const fetchCodeRabbitReviewThreads = vi.fn()
      .mockResolvedValueOnce(threads)
      .mockResolvedValueOnce([]);
    const executeWorkflow = vi.fn(async () => {
      mkdirSync(join(projectCwd, '.takt', 'runs', 'caccia-run'), { recursive: true });
      writeFileSync(reportPath, 'The finding was valid and the call site was fixed.', 'utf8');
      return { reportPath, decisions: [{ threadId: 'finding-1', valid: true, reason: 'The call site was incorrect.' }] };
    });
    const removeTemporaryClone = vi.fn(async (cwd: string) => {
      rmSync(cwd, { recursive: true, force: true });
    });
    const dependencies: CacciaDependencies = {
      detectVcsProvider: vi.fn(() => 'github'),
      waitForCodeRabbitReview,
      fetchCodeRabbitReviewThreads,
      createTemporaryClone: vi.fn(async () => ({ cwd: cloneCwd })),
      executeWorkflow,
      commitAndPush: vi.fn(async () => ({ headSha: 'pushed-head', pushed: true })),
      fetchCurrentPullRequestHeadSha: vi.fn(async () => 'pushed-head'),
      resolveReviewThread: vi.fn(async () => undefined),
      removeTemporaryClone,
      logResult: vi.fn(),
      notifyResult: vi.fn(async () => undefined),
    };

    await runCaccia({
      entry: 'standalone',
      prNumber: 42,
      projectCwd,
      settings: {
        enabled: false,
        waitTimeoutMs: 100,
        maxIterations: 1,
        workflow: 'caccia',
      },
    }, dependencies);

    expect(existsSync(cloneCwd)).toBe(false);
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, 'utf8')).toContain('finding was valid');
    expect(executeWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      cwd: cloneCwd,
      projectCwd,
      task: expect.stringContaining('"thread_id": "finding-1"'),
    }));
    expect(removeTemporaryClone).toHaveBeenCalledWith(cloneCwd);
  });

  it('runs the built-in workflow, preserves a same-named run, and keeps valid and invalid decisions after clone cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T00:00:00.000Z'));
    const projectCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-real-workflow-'));
    const cloneCwd = mkdtempSync(join(tmpdir(), 'takt-caccia-real-clone-'));
    temporaryRoots.push(projectCwd, cloneCwd);
    mkdirSync(join(projectCwd, '.takt'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'config.yaml'), 'language: en\n', 'utf8');

    const task = [
      'Review CodeRabbit threads for pull request #42.',
      JSON.stringify([
        { thread_id: 'valid-thread', body: 'The implementation misses the requested null check.' },
        { thread_id: 'invalid-thread', body: 'Change an unrelated component outside this diff.' },
      ]),
    ].join('\n\n');
    const runsDirectory = join(projectCwd, '.takt', 'runs');
    const existingRunDirectory = join(runsDirectory, generateReportDir(task));
    const existingReportPath = join(existingRunDirectory, 'reports', 'caccia-decisions.json');
    mkdirSync(join(existingRunDirectory, 'reports'), { recursive: true });
    writeFileSync(existingReportPath, 'previous decision', 'utf8');

    const decisions = [
      { thread_id: 'valid-thread', valid: true, reason: 'The implementation is missing the requested null check.' },
      { thread_id: 'invalid-thread', valid: false, reason: 'The requested change is outside the reported diff.' },
    ];
    let agentCallCount = 0;
    vi.mocked(runAgent).mockImplementation(async (persona, instruction, options) => {
      agentCallCount += 1;
      options?.onPromptResolved?.({
        systemPrompt: typeof persona === 'string' ? persona : '',
        userInstruction: instruction,
      });
      return {
        persona: 'coder',
        status: 'done',
        content: agentCallCount === 1
          ? 'Reviewed both supplied CodeRabbit threads.'
          : JSON.stringify(decisions, null, 2),
        timestamp: new Date(),
        sessionId: `caccia-session-${agentCallCount}`,
      };
    });

    const result = await runWorkflowExecution({
      task,
      cwd: cloneCwd,
      projectCwd,
      workflowIdentifier: 'caccia',
      runPathsDirectory: runsDirectory,
      agentOverrides: { provider: 'mock', model: 'caccia-integration' },
      outputMode: 'silent',
    });

    expect(result.success).toBe(true);
    expect(result.reportDirectory).toBeDefined();
    expect(result.reportDirectory).not.toBe(join(existingRunDirectory, 'reports'));
    const generatedReportPath = join(result.reportDirectory!, 'caccia-decisions.json');
    expect(JSON.parse(readFileSync(generatedReportPath, 'utf8'))).toEqual(decisions);
    expect(mockRunStatusJudgmentPhase).toHaveBeenCalledOnce();
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);

    rmSync(cloneCwd, { recursive: true, force: false });
    expect(existsSync(cloneCwd)).toBe(false);
    expect(readFileSync(generatedReportPath, 'utf8')).toContain('valid-thread');
    expect(readFileSync(existingReportPath, 'utf8')).toBe('previous decision');
  });
});
