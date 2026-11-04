import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { executeTaskAndCompleteWithDetails, executeTaskWithResult } from '../features/tasks/execute/taskExecution.js';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../infra/config/index.js';
import { setGoalExecutionStatus } from '../infra/goals/execution.js';
import { GoalStore } from '../infra/goals/store.js';
import { resetScenario, setMockScenario } from '../infra/mock/index.js';
import { CloneManager } from '../infra/task/clone.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

describe('clone 準備中に停止したゴールのタスクを manager MCP から再試行する', () => {
  let root: string;
  let cwd: string;
  let client: Client;
  let server: ReturnType<typeof createTaktMcpServer>;
  const taskDir = '.takt/tasks/paused-task';

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-pause-retry-')));
    cwd = join(root, 'project');
    const globalDirectory = join(root, 'global');
    mkdirSync(join(cwd, taskDir), { recursive: true });
    mkdirSync(join(globalDirectory, 'workflows', 'personas'), { recursive: true });
    vi.stubEnv('TAKT_CONFIG_DIR', globalDirectory);
    writeFileSync(join(globalDirectory, 'config.yaml'), 'provider: mock\nlanguage: en\n');
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: false\n');
    writeFileSync(join(cwd, taskDir, 'order.md'), 'Original instructions.');
    writeFileSync(join(globalDirectory, 'workflows', 'personas', 'worker.md'), 'Execute the task.');
    writeFileSync(join(globalDirectory, 'workflows', 'pause-retry.yaml'), stringify({
      name: 'pause-retry', initial_step: 'work', max_steps: 1,
      steps: [{ name: 'work', persona: './personas/worker.md', instruction: '{task}',
        rules: [{ condition: 'when(true)', next: 'ABORT' }] }],
    }));
    const git = (args: string[], input?: string) => execFileSync('git', args,
      { cwd, encoding: 'utf8', stdio: 'pipe', input }).trim();
    git(['init', '--quiet', '--initial-branch=main']);
    const tree = git(['mktree'], '');
    const sha = git(['-c', 'user.name=TAKT test', '-c', 'user.email=takt-test@example.test', 'commit-tree', tree, '-m', 'fixture']);
    git(['update-ref', 'refs/heads/main', sha]);
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    await new GoalStore(cwd).create(goalRecord());
    server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    client = new Client({ name: 'pause-retry-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
  });

  afterEach(async () => {
    await client?.close();
    await server?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetScenario();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  it.each((['paused', 'aborted'] as const).flatMap((status) =>
    (['before clone', 'after clone'] as const).flatMap((phase) =>
      (['retry', 'requeue'] as const).map((action) => ({ status, phase, action })))))(
    '$phase で $status にしたタスクの $action を実際の保存状態から処理する', async ({ status, phase, action }) => {
      const runner = new TaskRunner(cwd);
      const store = new TaskStore(cwd);
      runner.addTask('Prepare a clone', { goal_id: goalId, task_dir: taskDir, worktree: true,
        workflow: 'pause-retry', slug: 'paused-task', base_branch: 'main' });
      const task = runner.claimNextTasks(1)[0]!;
      const createClone = CloneManager.prototype.createSharedCloneAbortable;
      const clone = vi.spyOn(CloneManager.prototype, 'createSharedCloneAbortable').mockImplementationOnce(async function (
        this: CloneManager, projectDir, options, signal,
      ) {
        const result = phase === 'after clone' ? await createClone.call(this, projectDir, options, signal) : undefined;
        await setGoalExecutionStatus(cwd, goalId, status, new AbortController().signal);
        await vi.waitFor(() => expect(signal!.aborted).toBe(true), { timeout: 3000 });
        if (result === undefined) signal!.throwIfAborted();
        return result!;
      });
      const executor = vi.fn(executeTaskWithResult);
      const stopped = await executeTaskAndCompleteWithDetails(task, runner, cwd, executor, { provider: 'mock' }, { outputMode: 'silent' });
      const saved = store.read().tasks[0]!;
      expect(stopped).toMatchObject({ success: false, runSlug: expect.stringMatching(/^setup-/),
        completion: { interrupted: true, workflowResult: 'error' } });
      expect(executor).not.toHaveBeenCalled();
      expect(saved).toMatchObject({ status: 'failed', owner_pid: null });
      expect(saved.failure!.retryable === false).toBe(status === 'aborted');
      expect(saved.run_slug).toEqual(status === 'paused' ? undefined : stopped.runSlug);
      if (phase === 'after clone') expect(existsSync(join(saved.worktree_path!, '.git', 'HEAD'))).toBe(true);
      else expect(saved.worktree_path).toBeUndefined();
      if (status === 'paused') await setGoalExecutionStatus(cwd, goalId, 'active', new AbortController().signal);
      const result = await client.callTool({ name: `takt_${action}_goal_task`, arguments: {
        cwd, goalId, taskName: task.name, ...(action === 'retry' ? { task: 'Revised instructions.' } : {}),
      } });
      if (status === 'aborted') {
        expect(result.isError).toBe(true);
        expect(store.read().tasks[0]).toEqual(saved);
        return;
      }
      expect(result.isError, firstTextContent(result.content)).not.toBe(true);
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ status: 'pending' });
      const pending = store.read().tasks[0]!;
      expect(pending.worktree_path).toBe(saved.worktree_path);
      expect(pending.source_run_slug).toBeUndefined();
      expect(readFileSync(join(cwd, taskDir, 'order.md'), 'utf8')).toBe(
        action === 'retry' ? 'Revised instructions.' : 'Original instructions.');
      setMockScenario([{ persona: 'worker', status: 'done', content: 'Retried in a real clone.' }]);
      const retried = runner.claimNextTasks(1)[0]!;
      const completed = await executeTaskAndCompleteWithDetails(retried, runner, cwd, executor, { provider: 'mock' }, { outputMode: 'silent' });
      expect(executor).toHaveBeenCalledOnce();
      expect(completed).toMatchObject({ success: false, completion: { workflowResult: 'aborted', interrupted: false } });
      expect(clone).toHaveBeenCalledTimes(phase === 'before clone' ? 2 : 1);
      const finished = store.read().tasks[0]!;
      if (phase === 'after clone') expect(finished.worktree_path).toBe(saved.worktree_path);
      expect(existsSync(join(finished.worktree_path!, '.takt', 'runs', finished.run_slug!, 'meta.json'))).toBe(true);
    });
});
