import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { DaemonConversations } from '../features/daemon/conversationState.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { createWatchSource } from './helpers/daemon-watch-source.js';
import type { RunWatchTarget } from '../features/daemon/watchers/checks.js';
import { executeTaskAndCompleteWithDetails, executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import { runWithWorkerPool } from '../features/tasks/execute/parallelExecution.js';
import { executePrWorkflow, resolveMergeSettings } from '../features/merge/index.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { ConversationStateStore } from '../infra/daemon/conversationStateStore.js';
import { DaemonNotifications } from '../infra/daemon/notifications.js';
import { GoalStore } from '../infra/goals/store.js';
import { readManagerEvents } from '../infra/goals/events.js';
import { setGoalExecutionStatus } from '../infra/goals/execution.js';
import * as gitProvider from '../infra/git/index.js';
import { parseGitHubPullRequestTarget } from '../infra/github/pull-request-target.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { MockProvider } from '../infra/providers/mock.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

describe('実際の run ログと daemon のプロセス観測', () => {
  let root: string;
  let project: string;
  let globalDirectory: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-daemon-run-log-')));
    project = join(root, 'project');
    globalDirectory = join(root, 'global');
    mkdirSync(join(project, '.takt'), { recursive: true });
    mkdirSync(join(globalDirectory, 'workflows', 'personas'), { recursive: true });
    vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
    writeFileSync(join(globalDirectory, 'config.yaml'), 'provider: mock\nlanguage: en\n');
    writeFileSync(join(project, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
    writeFileSync(join(globalDirectory, 'workflows', 'personas', 'worker.md'), 'Execute the task.');
    writeFileSync(join(globalDirectory, 'workflows', 'watch-log.yaml'), stringify({
      name: 'watch-log', initial_step: 'work', max_steps: 1,
      steps: [{ name: 'work', persona: './personas/worker.md', instruction: '{task}',
        rules: [{ condition: 'when(true)', next: 'ABORT' }] }],
    }));
    const git = (args: string[], input?: string) => execFileSync('git', args,
      { cwd: project, encoding: 'utf8', stdio: 'pipe', input }).trim();
    git(['init', '--quiet', '--initial-branch=main']);
    const tree = git(['mktree'], '');
    const sha = git(['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.test', 'commit-tree', tree, '-m', 'fixture']);
    git(['update-ref', 'refs/heads/main', sha]);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    await new GoalStore(project).create(goalRecord());
    await registerProject({ globalConfigDirectory: globalDirectory, projectDirectory: project, command: 'manager', managerUsed: true });
    setMockScenario([{ persona: 'worker', status: 'done', content: 'Real mock run for daemon log observation.' }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetScenario();
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  async function queuedGoalMerge() {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
    execFileSync('git', ['branch', 'feature/watch-log', headSha], { cwd: project });
    const prUrl = 'https://github.com/example/project/pull/9';
    const gitConfig = join(root, 'gitconfig');
    writeFileSync(gitConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    execFileSync('git', ['config', '--file', gitConfig, `url.file://${project}.insteadOf`,
      'git@github.com:example/project.git'], { cwd: project });
    const provider = new GitHubProvider();
    vi.spyOn(gitProvider, 'getGitProvider').mockReturnValue(provider);
    vi.spyOn(GitHubProvider.prototype, 'checkCliStatus').mockReturnValue({ available: true });
    vi.spyOn(GitHubProvider.prototype, 'fetchPrDetails').mockImplementation(async (_number, _cwd, signal) => {
      signal?.throwIfAborted();
      return { number: 9, headSha, headBranch: 'feature/watch-log', baseBranch: 'main',
        sameRepository: true, headRepositoryUrl: project, headRepositoryPushUrls: [project] };
    });
    const status = { number: 9, headSha, merged: false, ci: { finished: true, passed: true },
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' };
    vi.spyOn(GitHubProvider.prototype, 'fetchPrStatus').mockImplementation(async (_number, _cwd, options) => {
      options?.signal?.throwIfAborted();
      return status;
    });
    expect(await executePrWorkflow({ projectCwd: project, prNumber: 9, pullRequest: parseGitHubPullRequestTarget(prUrl), workflow: 'watch-log',
      settings: resolveMergeSettings(undefined), display: { outputMode: 'silent' } })).toMatchObject({ success: false, merged: false, outcome: 'unresolved',
        completion: { success: false, workflowResult: 'aborted', mergeOutcome: 'unresolved' }, runSlug: expect.any(String) });
    const runner = new TaskRunner(project);
    const failed = runner.listFailedTasks()[0]!;
    await new GoalStore(project).update(goalId, (goal) => ({ ...goal,
      branch: 'feature/watch-log', status: 'awaiting_merge', pullRequest: { number: 9, url: prUrl },
      completion: { goalBranch: 'feature/watch-log', goalSha: headSha, targetBranch: 'main', summary: 'Reviewed',
        instructions: [], changeSummary: { filesChanged: 0, additions: 0, deletions: 0,
          files: [], truncated: false, totalsTruncated: false } },
    }));
    new TaskStore(project).update((current) => ({
      tasks: current.tasks.map((task) => task.name === failed.name ? { ...task, goal_id: goalId, pr_url: prUrl } : task),
    }));
    runner.requeueTask(failed.name, ['failed']);
    const task = runner.claimNextTasks(1)[0]!;
    return { runner, task, provider, status };
  }

  it('本物の merge run を観測し、元リポジトリへログを書く', async () => {
    const { runner, task, provider, status } = await queuedGoalMerge();
    const errors = vi.fn();
    const conversations = new DaemonConversations(new ConversationStateStore(globalDirectory), new DaemonRouting(globalDirectory),
      new DaemonNotifications(globalDirectory), async () => {}, errors);
    const source = createWatchSource(conversations, async () => {}, errors);
    const observations: Array<readonly RunWatchTarget[]> = [];
    vi.mocked(provider.fetchPrStatus).mockImplementationOnce(async (_number, _cwd, options) => {
      options?.signal?.throwIfAborted();
      observations.push(await source.runs());
      return status;
    });
    setMockScenario([{ persona: 'worker', status: 'done', content: 'Actual merge run log.' }]);
    try {
      const result = await executeTaskAndCompleteWithDetails(task, runner, project, executeTaskWithResult,
        { provider: 'mock' }, { outputMode: 'silent' });
      expect(result.success).toBe(false);
      expect(observations, result.failureReason).toHaveLength(1);
      expect(observations[0]).toHaveLength(1);
      const target = observations[0]![0]!;
      const saved = new TaskStore(project).read().tasks[0]!;
      expect(saved.merge_task).toBe(true);
      expect(saved.worktree_path).not.toBe(project);
      expect(target.task).toMatchObject({ taskName: task.name, runSlug: saved.run_slug });
      const logsDirectory = join(project, '.takt', 'runs', saved.run_slug!, 'logs');
      const logs = readdirSync(logsDirectory).filter((file) => file.endsWith('.jsonl'));
      expect(logs).not.toHaveLength(0);
      expect(logs.map((file) => readFileSync(join(logsDirectory, file), 'utf8')).join('\n')).toContain('Actual merge run log.');
      expect(existsSync(join(saved.worktree_path!, '.takt', 'runs', saved.run_slug!, 'logs'))).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally { await conversations.close(); }
  });

  it.each(['paused', 'aborted'] as const)('ゴールの merge run を %s にした結果を worker から保存する', async (status) => {
    const { runner, task } = await queuedGoalMerge();
    const entered = vi.fn();
    const setup = MockProvider.prototype.setup;
    vi.spyOn(MockProvider.prototype, 'setup').mockImplementation(function (this: MockProvider, config) {
      const agent = setup.call(this, config);
      return { call: (prompt, options) => { entered(); return agent.call(prompt, options); } };
    });
    setMockScenario([{ persona: 'worker', status: 'done', content: 'Pending merge work.', waitForAbort: true }]);
    const execution = runWithWorkerPool(runner, [task], 1, project, { provider: 'mock' }, undefined, 10_000);
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce(), { timeout: 10_000 });
      await setGoalExecutionStatus(project, goalId, status, new AbortController().signal);
      expect(await execution).toMatchObject({ success: 0, fail: 1, executedTaskNames: [task.name] });
      const saved = new TaskStore(project).read().tasks[0]!;
      expect(saved).toMatchObject({ status: 'failed', owner_pid: null });
      expect(saved.failure!.retryable === false).toBe(status === 'aborted');
      const events = readManagerEvents(project).map(({ event }) => event);
      if (status === 'aborted') {
        expect(saved.completion).toMatchObject({ success: false, interrupted: false, workflowResult: 'aborted',
          mergeOutcome: 'unresolved', failureReason: saved.failure!.error });
        expect(events).toEqual([]);
        return;
      }
      expect(saved.completion).toMatchObject({ success: false, interrupted: true, workflowResult: 'aborted',
        failureReason: saved.failure!.error });
      expect(events).toEqual([expect.objectContaining({ kind: 'completion', goalId, taskName: task.name,
        runSlug: saved.run_slug, result: saved.completion })]);
      expect((await new GoalStore(project).get(goalId)).executionStatus).toBe('paused');
      await setGoalExecutionStatus(project, goalId, 'active', new AbortController().signal);
      expect(readManagerEvents(project).map(({ event }) => event.kind)).toEqual(['completion', 'resumed']);
      const server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: project });
      const client = new Client({ name: 'merge-pause-requeue', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(b); await client.connect(a);
        const result = await client.callTool({ name: 'takt_requeue_goal_task', arguments: { cwd: project, goalId, taskName: task.name } });
        expect(result.isError, firstTextContent(result.content)).not.toBe(true);
        expect(new TaskStore(project).read().tasks[0]).toMatchObject({ status: 'pending', worktree_path: saved.worktree_path });
      } finally { await client.close(); await server.close(); }
    } finally {
      if ((await new GoalStore(project).get(goalId)).executionStatus !== 'aborted') {
        await setGoalExecutionStatus(project, goalId, 'aborted', new AbortController().signal);
      }
      await execution;
    }
  });

  it.each([
    { worktree: true, relativePath: false }, { worktree: true, relativePath: true }, { worktree: false, relativePath: false },
  ])('worktree=$worktree・relativePath=$relativePath の実行ログを取得する', async ({ worktree, relativePath }) => {
    const errors = vi.fn();
    const conversations = new DaemonConversations(new ConversationStateStore(globalDirectory), new DaemonRouting(globalDirectory),
      new DaemonNotifications(globalDirectory), async () => {}, errors);
    const source = createWatchSource(conversations, async () => {}, errors);
    const runner = new TaskRunner(project);
    runner.addTask('Write a run log', { goal_id: goalId, worktree, workflow: 'watch-log', slug: 'watch-log' });
    const task = runner.claimNextTasks(1)[0]!;
    const observations: Array<readonly RunWatchTarget[]> = [];
    const executor = vi.fn(async (options: Parameters<typeof executeTaskWithResult>[0]) => {
      const result = await executeTaskWithResult(options);
      if (relativePath) {
        const path = relative(project, options.cwd);
        expect(isAbsolute(path)).toBe(false);
        expect(process.cwd()).not.toBe(project);
        new TaskStore(project).update((current) => ({
          tasks: current.tasks.map((saved) => saved.name === task.name ? { ...saved, worktree_path: path } : saved),
        }));
      }
      try {
        observations.push(await source.runs());
      } finally {
        if (relativePath) {
          new TaskStore(project).update((current) => ({
            tasks: current.tasks.map((saved) => saved.name === task.name ? { ...saved, worktree_path: options.cwd } : saved),
          }));
        }
      }
      return result;
    });
    try {
      const result = await executeTaskAndCompleteWithDetails(task, runner, project, executor, { provider: 'mock' }, { outputMode: 'silent' });
      expect(executor).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ success: false, completion: { workflowResult: 'aborted' } });
      expect(observations).toHaveLength(1);
      expect(observations[0]).toHaveLength(1);
      const target = observations[0]![0]!;
      const saved = new TaskStore(project).read().tasks[0]!;
      expect(target).toMatchObject({ running: true,
        task: { repositoryDirectory: project, taskName: task.name, runSlug: saved.run_slug } });
      const executionDirectory = worktree ? saved.worktree_path! : project;
      const logsDirectory = join(executionDirectory, '.takt', 'runs', saved.run_slug!, 'logs');
      const logs = readdirSync(logsDirectory).filter((file) => file.endsWith('.jsonl')).map((file) => join(logsDirectory, file));
      expect(logs).not.toHaveLength(0);
      const content = logs.map((path) => readFileSync(path, 'utf8')).join('\n');
      expect(content).toContain('Real mock run for daemon log observation.');
      expect(content.trim().split('\n').map((line) => JSON.parse(line))).not.toHaveLength(0);
      if (worktree) {
        expect(executionDirectory).not.toBe(project);
        expect(existsSync(join(executionDirectory, '.git', 'HEAD'))).toBe(true);
        expect(existsSync(join(project, '.takt', 'runs', saved.run_slug!, 'logs'))).toBe(false);
      } else {
        expect(saved.worktree_path).toBeUndefined();
      }
      expect(errors).not.toHaveBeenCalled();
    } finally { await conversations.close(); }
  });
});
