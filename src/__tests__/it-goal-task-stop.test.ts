import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaktMcpServer, TAKT_MCP_MANAGER_TOOL_NAMES } from '../features/mcp/server.js';
import { executeTaskAndCompleteWithDetails } from '../features/tasks/execute/taskExecution.js';
import type { ExecuteTaskOptions, WorkflowExecutionResult } from '../features/tasks/execute/types.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';
import { goalId, goalRecord } from './helpers/goal-fixtures.js';
import { firstTextContent } from './helpers/mcp-content.js';

const doubles = vi.hoisted(() => ({ resolve: vi.fn(), post: vi.fn() }));
vi.mock('../features/tasks/execute/postExecution.js', () => ({ postExecutionFlow: doubles.post }));
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({
  ...await original<typeof import('../infra/task/repositoryDirectory.js')>(),
  resolveGitRepositoryDirectory: async (directory: string) => directory,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn((...args: Parameters<typeof actual.execFileSync>) =>
    args[0] === 'git' ? 'a'.repeat(40) : Reflect.apply(actual.execFileSync, undefined, args)) };
});
vi.mock('../features/tasks/execute/resolveTask.js', async (original) => ({
  ...await original<typeof import('../features/tasks/execute/resolveTask.js')>(), resolveTaskExecution: doubles.resolve,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('goal task stop through manager MCP and the same live worker', () => {
  let root: string;
  let cwd: string;
  let runner: TaskRunner;
  let store: TaskStore;
  let client: Client;
  let server: ReturnType<typeof createTaktMcpServer>;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-goal-stop-')));
    cwd = join(root, 'project');
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nmanager:\n  auto_run: false\n');
    invalidateGlobalConfigCache();
    await new GoalStore(cwd).create(goalRecord());
    runner = new TaskRunner(cwd); store = new TaskStore(cwd);
    doubles.resolve.mockReset().mockImplementation(async () => ({ execCwd: cwd, workflowIdentifier: 'default',
      reportDirName: '20261021-stop-test', isWorktree: false, autoPr: false, draftPr: false,
      managedPr: false, shouldPublishBranchToOrigin: false }));
    doubles.post.mockReset().mockResolvedValue({});
    server = createTaktMcpServer({}, { toolSet: 'manager', allowedProjectRoot: cwd });
    client = new Client({ name: 'stop-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
  });
  afterEach(async () => {
    await client?.close(); await server?.close();
    vi.restoreAllMocks(); vi.unstubAllEnvs(); invalidateGlobalConfigCache();
    rmSync(root, { recursive: true, force: true });
  });
  const stopTool = 'takt_stop_goal_task';
  const request = (taskName: string, executionId: string) => ({ name: stopTool,
    arguments: { cwd, goalId, taskName, executionId } });

  it('publishes the stop tool and keeps running until the signalled worker finishes, then isolates its retry', async () => {
    runner.addTask('work', { goal_id: goalId, worktree: false, slug: 'target' });
    runner.addTask('other work', { goal_id: goalId, worktree: false, slug: 'sibling' });
    const [task, sibling] = runner.claimNextTasks(2);
    const release = deferred<WorkflowExecutionResult>();
    const siblingRelease = deferred<WorkflowExecutionResult>();
    const executor = vi.fn((_options: ExecuteTaskOptions) => release.promise);
    const siblingExecutor = vi.fn((_options: ExecuteTaskOptions) => siblingRelease.promise);
    const execution = executeTaskAndCompleteWithDetails(task!, runner, cwd, executor, undefined, { outputMode: 'silent' });
    const siblingExecution = executeTaskAndCompleteWithDetails(sibling!, runner, cwd, siblingExecutor, undefined, { outputMode: 'silent' });
    try {
      await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
      const signal = executor.mock.calls[0]![0].abortSignal!;
      expect(signal.aborted).toBe(false);
      expect(TAKT_MCP_MANAGER_TOOL_NAMES).toContain(stopTool);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(stopTool);
      const listing = await client.callTool({ name: 'takt_list_tasks', arguments: { cwd } });
      expect(listing.isError, firstTextContent(listing.content)).not.toBe(true);
      const listed = JSON.parse(firstTextContent(listing.content));
      expect(listed.tasks.find((item: { name: string }) => item.name === task!.name)).toMatchObject({
        goalId, name: task!.name, executionId: task!.executionId, status: 'running',
      });
      const result = await client.callTool(request(task!.name, task!.executionId!));
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(firstTextContent(result.content))).toMatchObject({ status: 'stop_requested', executionId: task!.executionId });
      const accepted = store.read().tasks.find((t) => t.name === task!.name)!;
      expect(accepted).toMatchObject({ status: 'running', owner_pid: process.pid, completed_at: null,
        stop_request: { execution_id: task!.executionId } });
      const duplicate = await client.callTool(request(task!.name, task!.executionId!));
      expect(JSON.parse(firstTextContent(duplicate.content)).requestedAt).toBe(accepted.stop_request!.requested_at);
      await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 3000 });
      expect(store.read().tasks.find((t) => t.name === task!.name)!.status).toBe('running');
      release.resolve({ success: false, interrupted: true, reason: 'Workflow interrupted' });
      const finished = await execution;
      const saved = store.read().tasks.find((t) => t.name === task!.name)!;
      expect(saved).toMatchObject({ status: 'failed', owner_pid: null,
        completion: { success: false, interrupted: true, workflowResult: 'aborted' } });
      expect(saved.completed_at).toEqual(expect.any(String));
      expect(saved.failure!.error).toContain('stopped by manager');
      expect(saved.completion).toEqual(finished.completion);
      expect(finished.failureReason).toBe(saved.failure!.error);
      expect(store.read().tasks.find((t) => t.name === sibling!.name)!.status).toBe('running');
      expect(siblingExecutor.mock.calls[0]![0].abortSignal!.aborted).toBe(false);
      expect((await new GoalStore(cwd).get(goalId)).executionStatus).toBe('active');
      runner.requeueTask(task!.name, ['failed'], { freshStart: false });
      expect(store.read().tasks.find((t) => t.name === task!.name)!.stop_request).toBeUndefined();
      const [retried] = runner.claimNextTasks(1);
      expect(retried!.executionId).not.toBe(task!.executionId);
      const before = readFileSync(runner.getTasksFilePath());
      expect((await client.callTool(request(task!.name, task!.executionId!))).isError).toBe(true);
      expect(readFileSync(runner.getTasksFilePath())).toEqual(before);
      const nextExecutor = vi.fn(async (options: ExecuteTaskOptions) => {
        expect(options.abortSignal!.aborted).toBe(false); return { success: true };
      });
      expect((await executeTaskAndCompleteWithDetails(retried!, runner, cwd, nextExecutor, undefined, { outputMode: 'silent' })).success).toBe(true);
    } finally {
      release.resolve({ success: false, reason: 'test cleanup' });
      siblingRelease.resolve({ success: true });
      await Promise.all([execution, siblingExecution]);
    }
  });

  it.each(['wrong goal', 'wrong name', 'wrong execution', 'ended', 'dead owner', 'reused PID'] as const)(
    'rejects %s with a reason and leaves the persisted file unchanged', async (condition) => {
      runner.addTask('work', { goal_id: goalId, worktree: false, slug: 'target' });
      const [task] = runner.claimNextTasks(1);
      if (condition === 'wrong goal') {
        await new GoalStore(cwd).create({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' });
      }
      if (condition === 'ended') runner.completeTask({ task: task!, success: true, response: 'done', executionLog: [],
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
      if (condition === 'dead owner' || condition === 'reused PID') store.update((current) => ({ tasks: current.tasks.map((t) => ({
        ...t, ...(condition === 'dead owner' ? { owner_pid: 2147483647 } : { owner_start_time: 'different-start-time' }),
      })) }));
      const call = request(task!.name, task!.executionId!);
      if (condition === 'wrong goal') call.arguments.goalId = '550e8400-e29b-41d4-a716-446655440001';
      if (condition === 'wrong name') call.arguments.taskName = 'missing-task';
      if (condition === 'wrong execution') call.arguments.executionId = 'old-execution';
      const before = readFileSync(runner.getTasksFilePath());
      const result = await client.callTool(call);
      expect(result.isError).toBe(true);
      expect(firstTextContent(result.content)).toMatch(/goal|name|execution|running|owner/i);
      expect(readFileSync(runner.getTasksFilePath())).toEqual(before);
    });

  it.each(['success', 'failure', 'setup failure', 'exceeded', 'PR failure'] as const)(
    'keeps a request received at the final %s persistence boundary in the saved and returned result', async (outcome) => {
      runner.addTask('work', { goal_id: goalId, worktree: false, slug: 'target' });
      const [task] = runner.claimNextTasks(1);
      const method = outcome === 'success' ? 'completeTask' : outcome === 'failure' || outcome === 'setup failure' ? 'failTask'
        : outcome === 'exceeded' ? 'exceedTask' : 'prFailTask';
      const save = runner[method].bind(runner);
      // Insert the request after the worker's last monitor check, before the store update.
      vi.spyOn(runner, method).mockImplementationOnce(((...args: unknown[]) => {
        runner.requestTaskStop(goalId, task!.name, task!.executionId!);
        return Reflect.apply(save, runner, args);
      }) as never);
      if (outcome === 'PR failure') {
        doubles.post.mockResolvedValue({ prFailed: true, prError: 'PR creation failed' });
        doubles.resolve.mockResolvedValue({ execCwd: cwd, workflowIdentifier: 'default', reportDirName: 'stop-pr',
          isWorktree: true, autoPr: false, shouldPublishBranchToOrigin: false,
          taskSpec: { taskPrompt: 'work', orderContent: 'work' } });
      }
      if (outcome === 'setup failure') doubles.resolve.mockRejectedValue(new Error('Setup error'));
      const executor = async (): Promise<WorkflowExecutionResult> => outcome === 'exceeded'
        ? { success: false, exceeded: true, exceededInfo: { currentStep: 'implement', newMaxSteps: 20, currentIteration: 10 } }
        : outcome === 'failure' ? { success: false, reason: 'Provider error' } : { success: true };
      const result = await executeTaskAndCompleteWithDetails(task!, runner, cwd, executor, undefined, { outputMode: 'silent' });
      expect(result.success).toBe(false);
      const saved = store.read().tasks[0]!;
      expect(saved.status).toBe('failed');
      expect(saved.failure!.error).toContain('stopped by manager');
      expect(result.failureReason).toBe(saved.failure!.error);
      expect(result.completion).toEqual(saved.completion);
    });
});
