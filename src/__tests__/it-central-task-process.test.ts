import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskRepository } from '../infra/task/centralStateRepository.js';
import { getProcessIdentity } from '../infra/task/process.js';

const temporaryDirectories = new Set<string>();

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  const directories = [...temporaryDirectories];
  temporaryDirectories.clear();
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const globalConfigDirectory = await createTemporaryDirectory('takt-central-process-global-');
  const projectDirectory = await createTemporaryDirectory('takt-central-process-project-');
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
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
}

describe('central task process ownership', () => {
  it.each((['activeExecution', 'drainingExecution'] as const).flatMap((field) => [
    '日 10/ 4 19:28:57 2026', 'ps-lstart-utc-v1:garbage',
    'ps-lstart-utc-v1:Sun Feb 29 10:28:57 2026', '2026-02-29T14:23:40.1234567Z',
  ].map((startTime) => ({ field, startTime }))))('旧形式・不正な開始時刻 $startTime の生存 $field を回収せず次の実行を拒否する', async ({ field, startTime }) => {
    const { repository } = await setup();
    expect(getProcessIdentity(process.pid)).toBeDefined();
    const started = await repository.enqueueAndClaim({ task: 'legacy worker', workflow: 'default', worktree: false });
    const adopted = await repository.adopt({ taskId: started.task.taskId, generation: started.task.generation,
      executionId: started.executionId, ownerToken: started.ownerToken });
    if (field === 'drainingExecution') {
      await repository.forceFailTask(started.task.taskId, 'stopped');
      await repository.requeueTask(started.task.taskId);
    }
    const stored = JSON.parse(await readFile(repository.paths.tasksFile, 'utf8')) as {
      version: number; tasks: Array<Record<string, unknown>>;
    };
    stored.tasks = stored.tasks.map((task) => ({ ...task, [field]: {
      ...(task[field] as Record<string, unknown>), processIdentity: { startTime },
    } }));
    await writeFile(repository.paths.tasksFile, JSON.stringify(stored));
    await expect(repository.reconcile()).resolves.toEqual(stored.tasks);
    await expect(repository.enqueueAndClaim({ task: 'second worker', workflow: 'default', worktree: false })).rejects.toThrow();
    await expect(repository.claimNextPending()).resolves.toBeUndefined();
    // The original worker still has token authority to finish after upgrading.
    await repository.terminal({ taskId: adopted.taskId, generation: adopted.generation,
      executionId: started.executionId, ownerToken: started.ownerToken, status: 'completed' });
  });

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
    try {
      await repository.setStartingPid({
        taskId: started.task.taskId,
        generation: started.task.generation,
        executionId: started.executionId,
        ownerToken: started.ownerToken,
        pid: child.pid!,
      });
      child.kill('SIGTERM');
      await waitForExit(child);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child).catch(() => undefined);
      }
    }

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
            processIdentity: { startTime: process.platform === 'win32' ? '2000-01-01T00:00:00.0000000Z'
              : process.platform === 'linux' ? currentIdentity.startTime.replace(/[0-9a-f]$/, (value) => value === '0' ? '1' : '0')
                : currentIdentity.startTime.replace(/:\d+$/, (value) => value === ':0' ? ':1' : ':0') },
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

  it.each([undefined, '日 10/ 4 19:28:57 2026', 'ps-lstart-utc-v1:garbage', '2026-02-29T14:23:40.1234567Z'])('終了済み PID の central lock は開始時刻 %j でも回収する', async (startTime) => {
    const { globalConfigDirectory, project, repository } = await setup();
    const lockPath = join(repository.paths.locksDirectory, 'state.lock');
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      ownerToken: 'dead-owner-token',
      pid: 2_147_483_647,
      inode: 0,
      startedAt: new Date(0).toISOString(),
      ...(startTime === undefined ? {} : { processIdentity: { startTime } }),
    }));
    const lockStat = await lstat(lockPath);
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      ownerToken: 'dead-owner-token',
      pid: 2_147_483_647,
      inode: lockStat.ino,
      startedAt: new Date(0).toISOString(),
      ...(startTime === undefined ? {} : { processIdentity: { startTime } }),
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

  it.each(['current', 'legacy', 'invalid-unix', 'invalid-windows'] as const)('does not recover a central lock owned by a live process (%s identity)', async (format) => {
    const { globalConfigDirectory, project, repository } = await setup();
    const lockPath = join(repository.paths.locksDirectory, 'state.lock');
    const processIdentity = format === 'current' ? getProcessIdentity(process.pid) : {
      startTime: format === 'legacy' ? '日 10/ 4 19:28:57 2026'
        : format === 'invalid-unix' ? 'ps-lstart-utc-v1:garbage' : '2026-02-29T14:23:40.1234567Z',
    };
    expect(getProcessIdentity(process.pid)).toBeDefined();
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
    await expect(readFile(lockPath, 'utf8').then(JSON.parse)).resolves.toMatchObject({ processIdentity });
  });

  it.each(['日 10/ 4 19:28:57 2026', 'ps-lstart-utc-v1:garbage', '2026-02-29T14:23:40.1234567Z'])('生存する旧形式・不正な開始時刻 %s の回収 claim を消さずロックを維持する', async (startTime) => {
    const { repository } = await setup();
    expect(getProcessIdentity(process.pid)).toBeDefined();
    const lockPath = join(repository.paths.locksDirectory, 'state.lock');
    const ownerToken = 'dead-owner-token';
    await writeFile(lockPath, JSON.stringify({ version: 1, ownerToken, pid: 2_147_483_647,
      inode: 0, startedAt: new Date(0).toISOString() }));
    const stats = await lstat(lockPath);
    const owner = JSON.stringify({ version: 1, ownerToken, pid: 2_147_483_647,
      inode: stats.ino, startedAt: new Date(0).toISOString() });
    await writeFile(lockPath, owner);
    const claimPath = `${lockPath}.${createHash('sha256').update(ownerToken).digest('hex')}.claim`;
    const claim = JSON.stringify({ version: 1, ownerToken, claimToken: 'legacy-claim-token',
      pid: process.pid, processIdentity: { startTime }, dev: stats.dev, ino: stats.ino });
    await writeFile(claimPath, claim);
    await expect(repository.reconcile()).rejects.toThrow(/central state lock is busy/i);
    await expect(readFile(claimPath, 'utf8')).resolves.toBe(claim);
    await expect(readFile(lockPath, 'utf8')).resolves.toBe(owner);
  });
});
