import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTaskAndCompleteWithDetails } from '../features/tasks/execute/taskExecution.js';
import type { ExecuteTaskOptions, WorkflowExecutionResult } from '../features/tasks/execute/types.js';
import { stopRunningTask } from '../features/tasks/list/taskStopActions.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { invalidateGlobalConfigCache } from '../infra/config/global/globalConfig.js';

const doubles = vi.hoisted(() => ({ resolve: vi.fn(), confirm: vi.fn() }));
vi.mock('../features/tasks/execute/resolveTask.js', async (original) => ({
  ...await original<typeof import('../features/tasks/execute/resolveTask.js')>(), resolveTaskExecution: doubles.resolve,
}));
vi.mock('../infra/task/repositoryDirectory.js', async (original) => ({
  ...await original<typeof import('../infra/task/repositoryDirectory.js')>(),
  resolveGitRepositoryDirectory: async (directory: string) => directory,
}));
vi.mock('../shared/prompt/index.js', () => ({ confirm: doubles.confirm }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('list Stop and the same standalone worker', () => {
  let root: string;
  let cwd: string;
  let runner: TaskRunner;
  let store: TaskStore;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-list-stop-')));
    cwd = join(root, 'project');
    mkdirSync(join(cwd, '.takt'), { recursive: true });
    vi.stubEnv('TAKT_CONFIG_DIR', join(root, 'global'));
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    invalidateGlobalConfigCache();
    runner = new TaskRunner(cwd);
    store = new TaskStore(cwd);
    doubles.confirm.mockReset().mockResolvedValue(true);
    doubles.resolve.mockReset().mockResolvedValue({ execCwd: cwd, workflowIdentifier: 'default',
      reportDirName: 'standalone-stop', isWorktree: false, autoPr: false, draftPr: false,
      managedPr: false, shouldPublishBranchToOrigin: false });
  });
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); invalidateGlobalConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  it('saves only a request, waits for the signalled worker, then persists its stopped result and leaves its sibling running', async () => {
    runner.addTask('work', { worktree: false, slug: 'target' });
    runner.addTask('other work', { worktree: false, slug: 'sibling' });
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
      const listed = runner.listAllTaskItems().find((item) => item.name === task!.name)!;
      expect(listed.executionId).toBe(task!.executionId);
      expect(listed.goalId).toBeUndefined();
      const before = store.read().tasks.find((item) => item.name === task!.name)!;
      expect(await stopRunningTask(listed, cwd, 'en')).toBe(true);
      const requested = store.read().tasks.find((item) => item.name === task!.name)!;
      expect(requested).toEqual({ ...before, stop_request: {
        execution_id: task!.executionId, requested_at: expect.any(String),
      } });
      await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 3000 });
      expect(store.read().tasks.find((item) => item.name === task!.name)!.status).toBe('running');
      release.resolve({ success: false, interrupted: true, reason: 'Workflow interrupted' });
      const result = await execution;
      const saved = store.read().tasks.find((item) => item.name === task!.name)!;
      expect(saved).toMatchObject({ status: 'failed', owner_pid: null,
        completion: { success: false, interrupted: true, workflowResult: 'aborted' } });
      expect(saved.completed_at).toEqual(expect.any(String));
      expect(saved.failure!.error).toContain('stopped by manager');
      expect(result.failureReason).toBe(saved.failure!.error);
      expect(result.completion).toEqual(saved.completion);
      expect(store.read().tasks.find((item) => item.name === sibling!.name)!.status).toBe('running');
      expect(siblingExecutor.mock.calls[0]![0].abortSignal!.aborted).toBe(false);
    } finally {
      release.resolve({ success: false, reason: 'cleanup' });
      siblingRelease.resolve({ success: true });
      await Promise.all([execution, siblingExecution]);
    }
  });

  it.each(['success', 'failure', 'setup failure', 'exceeded'] as const)(
    'persists and returns a late stop accepted at the %s write boundary', async (outcome) => {
      runner.addTask('work', { worktree: false, slug: 'target' });
      const task = runner.claimNextTasks(1)[0]!;
      const method = outcome === 'success' ? 'completeTask' : outcome === 'exceeded' ? 'exceedTask' : 'failTask';
      const save = runner[method].bind(runner);
      vi.spyOn(runner, method).mockImplementationOnce(((...args: unknown[]) => {
        runner.requestTaskStop(undefined, task.name, task.executionId!);
        return Reflect.apply(save, runner, args);
      }) as never);
      if (outcome === 'setup failure') doubles.resolve.mockRejectedValue(new Error('setup failed'));
      const executor = async (): Promise<WorkflowExecutionResult> => outcome === 'exceeded'
        ? { success: false, exceeded: true, exceededInfo: { currentStep: 'implement', newMaxSteps: 20, currentIteration: 10 } }
        : outcome === 'failure' ? { success: false, reason: 'provider failed' } : { success: true };
      const result = await executeTaskAndCompleteWithDetails(task, runner, cwd, executor, undefined, { outputMode: 'silent' });
      const saved = store.read().tasks[0]!;
      expect(result.success).toBe(false);
      expect(saved.status).toBe('failed');
      expect(saved.failure!.error).toContain('stopped by manager');
      expect(result.failureReason).toBe(saved.failure!.error);
      expect(saved.completion).toEqual(result.completion);
    });
});
