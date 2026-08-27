import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskRepository } from '../infra/task/centralStateRepository.js';
import { runCentralTask } from '../features/web-ui/central-worker.js';
import { waitForCentralWorkerStartup } from '../features/web-ui/central-worker-spawn.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';
import { createSharedCloneAbortable } from '../infra/task/clone.js';
import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';

vi.mock('../features/tasks/execute/workflowExecutionApi.js', () => ({
  runWorkflowExecution: vi.fn(async () => ({ success: true })),
}));

vi.mock('../infra/task/clone.js', () => ({
  createSharedCloneAbortable: vi.fn(),
}));

vi.mock('../features/tasks/execute/postExecution.js', () => ({
  postExecutionFlow: vi.fn(),
}));

async function setupWorkerFixture() {
  const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-central-worker-global-'));
  const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-central-worker-project-'));
  const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
  const repository = await CentralTaskRepository.open({
    globalConfigDirectory,
    stateId: project.stateId,
    locationId: project.locationId,
    canonicalDirectory: project.canonicalDirectory,
    displayName: project.displayName,
    fingerprint: project.fingerprint,
  });
  return { globalConfigDirectory, projectDirectory, project, repository };
}

async function withCentralConfig<T>(
  globalConfigDirectory: string,
  action: () => Promise<T>,
): Promise<T> {
  const previousConfigDirectory = process.env.TAKT_CONFIG_DIR;
  process.env.TAKT_CONFIG_DIR = globalConfigDirectory;
  try {
    return await action();
  } finally {
    if (previousConfigDirectory === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDirectory;
  }
}

describe('central Web UI worker', () => {
  it('terminalizes ledger failures from the worker execution boundary', async () => {
    const { globalConfigDirectory, project, repository } = await setupWorkerFixture();
    const reserved = await repository.enqueueAndClaim({ task: 'metadata failure', workflow: 'default', worktree: false });
    vi.mocked(runWorkflowExecution).mockRejectedValueOnce(new Error('workflow failed'));
    await expect(runCentralTask({
      globalConfigDirectory,
      stateId: project.stateId,
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
    })).rejects.toThrow('workflow failed');
    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'worker_failed' },
    });
  });

  it('commits a mock one-shot run entirely below central state', async () => {
    const { globalConfigDirectory, projectDirectory, project, repository } = await setupWorkerFixture();
    await mkdir(join(projectDirectory, '.takt'), { recursive: true });
    await writeFile(join(projectDirectory, '.takt', 'sentinel'), 'project-local state');
    const projectLocalSnapshot = await readFile(join(projectDirectory, '.takt', 'sentinel'), 'utf8');
    const reserved = await repository.enqueueAndClaim({
      task: 'central mock task',
      workflow: 'default',
      worktree: false,
    });
    await withCentralConfig(globalConfigDirectory, async () => {
      await runCentralTask({
        globalConfigDirectory,
        stateId: project.stateId,
        taskId: reserved.task.taskId,
        generation: reserved.task.generation,
        executionId: reserved.executionId,
        ownerToken: reserved.ownerToken,
      });
    });

    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({ status: 'completed' });
    await expect(readFile(join(projectDirectory, '.takt', 'sentinel'), 'utf8')).resolves.toBe(projectLocalSnapshot);
    await expect(lstat(join(projectDirectory, '.takt', 'tasks.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.mocked(runWorkflowExecution)).toHaveBeenCalledWith(expect.objectContaining({
      runPathsDirectory: repository.paths.runsDirectory,
      sessionStorageDirectory: repository.paths.sessionsDirectory,
      skipWorktreeRuntimeProtection: true,
    }));
  });

  it('applies saved worktree and pull-request settings after a successful run', async () => {
    const { globalConfigDirectory, projectDirectory, project, repository } = await setupWorkerFixture();
    const worktreeDirectory = await mkdtemp(join(tmpdir(), 'takt-central-worker-worktree-'));
    vi.mocked(createSharedCloneAbortable).mockResolvedValueOnce({
      path: worktreeDirectory,
      branch: 'feature/web-task',
    });
    vi.mocked(postExecutionFlow).mockResolvedValueOnce({ prUrl: 'https://example.test/pull/1' });
    const reserved = await repository.enqueueAndClaim({
      task: 'central PR task',
      workflow: 'default',
      worktree: true,
      branch: 'feature/web-task',
      baseBranch: 'main',
      autoPr: true,
      draftPr: true,
    });

    await withCentralConfig(globalConfigDirectory, async () => {
      await runCentralTask({
        globalConfigDirectory,
        stateId: project.stateId,
        taskId: reserved.task.taskId,
        generation: reserved.task.generation,
        executionId: reserved.executionId,
        ownerToken: reserved.ownerToken,
      });
    });

    expect(vi.mocked(createSharedCloneAbortable)).toHaveBeenCalledWith(
      projectDirectory,
      expect.objectContaining({ branch: 'feature/web-task', baseBranch: 'main' }),
    );
    expect(vi.mocked(postExecutionFlow)).toHaveBeenCalledWith(expect.objectContaining({
      execCwd: worktreeDirectory,
      projectCwd: projectDirectory,
      branch: 'feature/web-task',
      baseBranch: 'main',
      shouldCreatePr: true,
      draftPr: true,
    }));
    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({
      status: 'completed',
      prUrl: 'https://example.test/pull/1',
    });
  });

  it('records pull-request publication failures as requeueable task failures', async () => {
    const { globalConfigDirectory, projectDirectory, project, repository } = await setupWorkerFixture();
    vi.mocked(createSharedCloneAbortable).mockResolvedValueOnce({
      path: projectDirectory,
      branch: 'feature/pr-failure',
    });
    vi.mocked(postExecutionFlow).mockResolvedValueOnce({
      prFailed: true,
      prError: 'Pull request creation failed',
    });
    const reserved = await repository.enqueueAndClaim({
      task: 'central PR failure task',
      workflow: 'default',
      worktree: true,
      autoPr: true,
      draftPr: true,
    });

    await withCentralConfig(globalConfigDirectory, async () => {
      await runCentralTask({
        globalConfigDirectory,
        stateId: project.stateId,
        taskId: reserved.task.taskId,
        generation: reserved.task.generation,
        executionId: reserved.executionId,
        ownerToken: reserved.ownerToken,
      });
    });

    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({
      status: 'failed',
      failure: {
        code: 'pr_failed',
        message: 'Pull request creation failed',
      },
    });
  });

  it('claims and spawns exactly one successor from the central pending queue', async () => {
    const { globalConfigDirectory, project, repository } = await setupWorkerFixture();
    const first = await repository.enqueueOrReuse({ task: 'first', workflow: 'default', worktree: false });
    const queued = await repository.enqueueOrReuse({ task: 'second', workflow: 'default', worktree: false });
    expect(first.kind).toBe('started');
    expect(queued.kind).toBe('reused');
    let spawnCount = 0;
    await withCentralConfig(globalConfigDirectory, async () => {
      await runCentralTask({
        globalConfigDirectory,
        stateId: project.stateId,
        taskId: first.task.taskId,
        generation: first.task.generation,
        executionId: first.executionId!,
        ownerToken: first.ownerToken!,
      }, {
        spawnProcess: ((_command: string, args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv }) => {
          spawnCount += 1;
          expect(args).not.toContain(first.ownerToken!);
          expect(options.env?.TAKT_CENTRAL_OWNER_TOKEN).toBeTruthy();
          const child = Object.assign(new EventEmitter(), {
            pid: 7777,
            exitCode: null,
            signalCode: null,
            unref: () => undefined,
          });
          queueMicrotask(() => {
            void repository.adopt({
              taskId: queued.task.taskId,
              generation: Number(args[args.indexOf('--generation') + 1]),
              executionId: args[args.indexOf('--execution-id') + 1]!,
              ownerToken: options.env?.TAKT_CENTRAL_OWNER_TOKEN ?? '',
              pid: 7777,
            }).then(
              () => child.emit('spawn'),
              (error: unknown) => child.emit('error', error),
            ).catch(() => undefined);
          });
          return child;
        }) as never,
      });
    });

    expect(spawnCount).toBe(1);
    await expect(repository.readTask(queued.task.taskId)).resolves.toMatchObject({
      status: 'running',
      generation: queued.task.generation + 2,
      activeExecution: { pid: 7777 },
    });
  });

  it('terminalizes a successor reservation when detached spawn fails', async () => {
    const { globalConfigDirectory, project, repository } = await setupWorkerFixture();
    const first = await repository.enqueueOrReuse({ task: 'first', workflow: 'default', worktree: false });
    const queued = await repository.enqueueOrReuse({ task: 'second', workflow: 'default', worktree: false });
    await withCentralConfig(globalConfigDirectory, async () => {
      await expect(runCentralTask({
        globalConfigDirectory,
        stateId: project.stateId,
        taskId: first.task.taskId,
        generation: first.task.generation,
        executionId: first.executionId!,
        ownerToken: first.ownerToken!,
      }, { spawnProcess: () => { throw new Error('successor spawn failed'); } })).rejects.toThrow('successor spawn failed');
    });
    await expect(repository.readTask(queued.task.taskId)).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'spawn_failed' },
    });
  });

  it('terminalizes a successor whose child exits before adoption', async () => {
    const { globalConfigDirectory, project, repository } = await setupWorkerFixture();
    const first = await repository.enqueueOrReuse({ task: 'first', workflow: 'default', worktree: false });
    const queued = await repository.enqueueOrReuse({ task: 'second', workflow: 'default', worktree: false });
    await withCentralConfig(globalConfigDirectory, async () => {
      await expect(runCentralTask({
        globalConfigDirectory,
        stateId: project.stateId,
        taskId: first.task.taskId,
        generation: first.task.generation,
        executionId: first.executionId!,
        ownerToken: first.ownerToken!,
      }, {
        spawnProcess: ((_command: string, _args: readonly string[]) => {
          const child = Object.assign(new EventEmitter(), {
            pid: 7788,
            exitCode: null as number | null,
            signalCode: null as NodeJS.Signals | null,
            unref: () => undefined,
          });
          queueMicrotask(() => {
            child.emit('spawn');
            queueMicrotask(() => {
              child.exitCode = 1;
              child.emit('exit', 1, null);
            });
          });
          return child;
        }) as never,
      })).rejects.toThrow(/exited before adopting/i);
    });
    await expect(repository.readTask(queued.task.taskId)).resolves.toMatchObject({
      status: 'failed',
      failure: { code: 'spawn_failed' },
    });
  });

  it('does not steal a live unknown child when successor startup times out', async () => {
    const { project, repository } = await setupWorkerFixture();
    const reserved = await repository.enqueueAndClaim({ task: 'timeout', workflow: 'default', worktree: false });
    const child = Object.assign(new EventEmitter(), {
      pid: 7799,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      unref: () => undefined,
    });

    await expect(waitForCentralWorkerStartup(repository, {
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
      runId: reserved.runId,
    }, child as never, 0)).rejects.toMatchObject({ recoveryRequired: true });
    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({ status: 'starting' });
  });
});
