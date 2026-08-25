import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskRepository } from '../infra/task/centralStateRepository.js';
import { getProcessIdentity } from '../infra/task/process.js';

async function setup() {
  const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-central-process-global-'));
  const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-central-process-project-'));
  const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
  const repository = await CentralTaskRepository.open({
    globalConfigDirectory,
    stateId: project.stateId,
    locationId: project.locationId,
    canonicalDirectory: project.canonicalDirectory,
    displayName: project.displayName,
    fingerprint: project.fingerprint,
  });
  return { globalConfigDirectory, project, repository };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
}

describe('central task process ownership', () => {
  it('reconciles a real worker process after it exits without requeueing', async () => {
    const { repository } = await setup();
    const started = await repository.enqueueAndClaim({ task: 'crash', workflow: 'default', worktree: false });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      shell: false,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve());
    });
    expect(child.pid).toBeGreaterThan(0);
    await repository.setStartingPid({
      taskId: started.task.taskId,
      generation: started.task.generation,
      executionId: started.executionId,
      ownerToken: started.ownerToken,
      pid: child.pid!,
    });
    child.kill('SIGTERM');
    await waitForExit(child);

    await expect(repository.reconcile()).resolves.toEqual([
      expect.objectContaining({
        taskId: started.task.taskId,
        status: 'failed',
        failure: expect.objectContaining({ code: 'worker_crashed' }),
      }),
    ]);
    await expect(repository.readTasks()).resolves.toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
  });

  it('does not keep a reused PID when its recorded process identity differs', async () => {
    const { repository } = await setup();
    const started = await repository.enqueueAndClaim({ task: 'reused-pid', workflow: 'default', worktree: false });
    const currentIdentity = getProcessIdentity(process.pid);
    if (currentIdentity === undefined) {
      await expect(repository.reconcile()).resolves.toEqual([
        expect.objectContaining({ status: 'starting' }),
      ]);
      return;
    }
    const stored = JSON.parse(await readFile(repository.paths.tasksFile, 'utf8')) as {
      version: number;
      tasks: Array<Record<string, unknown>>;
    };
    stored.tasks = stored.tasks.map((task) => task.taskId === started.task.taskId
      ? {
          ...task,
          activeExecution: {
            ...(task.activeExecution as Record<string, unknown>),
            pid: process.pid,
            processIdentity: { startTime: `${currentIdentity.startTime}-unrelated` },
          },
        }
      : task);
    await writeFile(repository.paths.tasksFile, `${JSON.stringify(stored)}\n`);

    await expect(repository.reconcile()).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({ code: 'worker_crashed' }),
      }),
    ]);
  });

  it('recovers a central lock only when its recorded owner process is dead', async () => {
    const { globalConfigDirectory, project, repository } = await setup();
    const lockPath = join(repository.paths.locksDirectory, 'state.lock');
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      ownerToken: 'dead-owner-token',
      pid: 2_147_483_647,
      inode: 0,
      startedAt: new Date(0).toISOString(),
    }));
    const lockStat = await lstat(lockPath);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      ownerToken: 'dead-owner-token',
      pid: 2_147_483_647,
      inode: lockStat.ino,
      startedAt: new Date(0).toISOString(),
    }));

    await expect(CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    })).resolves.toBeDefined();
  });

  it('does not recover a central lock owned by a live process', async () => {
    const { globalConfigDirectory, project, repository } = await setup();
    const lockPath = join(repository.paths.locksDirectory, 'state.lock');
    const processIdentity = getProcessIdentity(process.pid);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      ownerToken: 'live-owner-token',
      pid: process.pid,
      ...(processIdentity === undefined ? {} : { processIdentity }),
      inode: 0,
      startedAt: new Date(0).toISOString(),
    }));
    const lockStat = await lstat(lockPath);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      ownerToken: 'live-owner-token',
      pid: process.pid,
      ...(processIdentity === undefined ? {} : { processIdentity }),
      inode: lockStat.ino,
      startedAt: new Date(0).toISOString(),
    }));

    await expect(CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    })).rejects.toThrow(/central state lock is busy/i);
  });
});
