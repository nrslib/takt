import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskCasError, CentralTaskRepository } from '../infra/task/centralStateRepository.js';
import { launchTaktRun } from '../features/web-ui/launcher.js';

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
  const globalConfigDirectory = await createTemporaryDirectory('takt-central-global-');
  const projectDirectory = await createTemporaryDirectory('takt-central-project-');
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

describe('central task CAS repository', () => {
  it('keeps central directories private and state files owner-only', async () => {
    const { repository } = await setup();
    const [stateDirectory, stateFile, tasksFile] = await Promise.all([
      stat(repository.paths.stateDirectory),
      stat(repository.paths.stateFile),
      stat(repository.paths.tasksFile),
    ]);
    expect(stateDirectory.mode & 0o777).toBe(0o700);
    expect(stateFile.mode & 0o777).toBe(0o600);
    expect(tasksFile.mode & 0o777).toBe(0o600);
  });

  it('never exposes an incomplete state lock during publication', async () => {
    const { repository } = await setup();
    const lockPath = join(repository.paths.locksDirectory, 'state.lock');
    let stop = false;
    let malformed = false;
    const poll = (async () => {
      while (!stop) {
        try {
          const raw = await readFile(lockPath, 'utf8');
          const owner = JSON.parse(raw) as { version?: number };
          if (owner.version !== 1) malformed = true;
        } catch (error) {
          if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
            malformed = true;
          }
        }
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      }
    })();
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await repository.claimNextPending();
      }
    } finally {
      stop = true;
      await poll;
    }
    expect(malformed).toBe(false);
  });

  it('allows one UI start and reuses the active execution without a second claim', async () => {
    const { repository } = await setup();
    const [first, second] = await Promise.all([
      repository.enqueueOrReuse({ task: 'first', workflow: 'default', worktree: false }),
      repository.enqueueOrReuse({ task: 'second', workflow: 'default', worktree: false }),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(['reused', 'started']);
    const started = first.kind === 'started' ? first : second;
    const reused = first.kind === 'reused' ? first : second;
    expect(reused.active?.executionId).toBe(started.executionId);
    expect(started.ownerToken).toBeTruthy();
    const raw = await readFile(repository.paths.tasksFile, 'utf8');
    expect(raw).not.toContain(started.ownerToken!);
    await expect(repository.adopt({
      taskId: started.task.taskId,
      generation: started.task.generation,
      executionId: started.executionId!,
      ownerToken: started.ownerToken!,
    })).resolves.toMatchObject({ status: 'running' });
    await expect(repository.adopt({
      taskId: started.task.taskId,
      generation: started.task.generation,
      executionId: started.executionId!,
      ownerToken: started.ownerToken!,
    })).rejects.toBeInstanceOf(CentralTaskCasError);
  });

  it('keeps separate TAKT_CONFIG_DIR namespaces independent', async () => {
    const { projectDirectory, globalConfigDirectory, project, repository } = await setup();
    const otherGlobal = await createTemporaryDirectory('takt-central-other-global-');
    const otherProject = await registerProject({ globalConfigDirectory: otherGlobal, projectDirectory, command: 'ui' });
    const otherRepository = await CentralTaskRepository.open({
      globalConfigDirectory: otherGlobal,
      stateId: otherProject.stateId,
      locationId: otherProject.locationId,
      canonicalDirectory: otherProject.canonicalDirectory,
      displayName: otherProject.displayName,
      fingerprint: otherProject.fingerprint,
    });
    expect(otherProject.stateId).not.toBe(project.stateId);
    await expect(repository.enqueueAndClaim({ task: 'namespace-a', workflow: 'default', worktree: false })).resolves.toBeDefined();
    await expect(otherRepository.enqueueAndClaim({ task: 'namespace-b', workflow: 'default', worktree: false })).resolves.toBeDefined();
    await expect(repository.readTasks()).resolves.toEqual([expect.objectContaining({ task: 'namespace-a' })]);
    await expect(otherRepository.readTasks()).resolves.toEqual([expect.objectContaining({ task: 'namespace-b' })]);
  });

  it('keeps the resolved state handle usable after the project directory disappears', async () => {
    const { projectDirectory, repository } = await setup();
    const started = await repository.enqueueAndClaim({ task: 'move-safe', workflow: 'default', worktree: false });
    const adopted = await repository.adopt({
      taskId: started.task.taskId,
      generation: started.task.generation,
      executionId: started.executionId,
      ownerToken: started.ownerToken,
    });
    await rm(projectDirectory, { recursive: true, force: true });
    await expect(repository.terminal({
      taskId: adopted.taskId,
      generation: adopted.generation,
      executionId: started.executionId,
      ownerToken: started.ownerToken,
      status: 'completed',
    })).resolves.toMatchObject({ status: 'completed' });
  });

  it('revalidates the project fingerprint before a worker attaches to state', async () => {
    const { globalConfigDirectory, projectDirectory, project } = await setup();
    const replacementPath = join(projectDirectory, '..', 'project-replacement');
    await mkdir(replacementPath);
    await rm(projectDirectory, { recursive: true, force: true });
    await rename(replacementPath, projectDirectory);

    await expect(CentralTaskRepository.openByState({
      globalConfigDirectory,
      stateId: project.stateId,
    })).rejects.toThrow(/fingerprint|identity|canonical/i);
  });

  it('linearizes a project swap with adopt under the state lock', async () => {
    const { projectDirectory, repository } = await setup();
    const reserved = await repository.enqueueAndClaim({
      task: 'swap during adopt verification',
      workflow: 'default',
      worktree: false,
    });
    const replacementPath = join(projectDirectory, '..', 'project-replacement');
    await mkdir(replacementPath);

    await expect(repository.adoptVerified({
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
    }, async () => {
      await rm(projectDirectory, { recursive: true, force: true });
      await rename(replacementPath, projectDirectory);
    })).rejects.toThrow(/identity|fingerprint|registered/i);
    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({ status: 'starting' });
  });

  it('rejects an atomic state replacement before adopting the starting task', async () => {
    const { repository } = await setup();
    const reserved = await repository.enqueueAndClaim({
      task: 'state replacement during adopt',
      workflow: 'default',
      worktree: false,
    });
    const persisted = JSON.parse(await readFile(repository.paths.stateFile, 'utf8')) as Record<string, unknown>;
    const replacementPath = join(repository.paths.stateDirectory, '.state-replacement.json');
    await expect(repository.adoptVerified({
      taskId: reserved.task.taskId,
      generation: reserved.task.generation,
      executionId: reserved.executionId,
      ownerToken: reserved.ownerToken,
    }, async () => {
      await writeFile(replacementPath, `${JSON.stringify({
        ...persisted,
        stateId: '00000000-0000-4000-8000-000000000000',
      })}\n`, { flag: 'wx', mode: 0o600 });
      await rename(replacementPath, repository.paths.stateFile);
    })).rejects.toThrow(/persisted state|identity|registry/i);
    await expect(repository.readTask(reserved.task.taskId)).resolves.toMatchObject({ status: 'starting' });
  });

  it('compares the persisted state fingerprint with the open options', async () => {
    const { globalConfigDirectory, project, repository } = await setup();
    const persisted = JSON.parse(await readFile(repository.paths.stateFile, 'utf8')) as Record<string, unknown>;
    const fingerprint = persisted.fingerprint as { dev: number; ino: number };
    await writeFile(repository.paths.stateFile, JSON.stringify({
      ...persisted,
      fingerprint: { dev: fingerprint.dev + 1, ino: fingerprint.ino },
    }));

    await expect(CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    })).rejects.toThrow(/identity|fingerprint/i);
  });

  it('claims one queued task for the next detached worker after the active one terminates', async () => {
    const { repository } = await setup();
    const first = await repository.enqueueOrReuse({ task: 'first', workflow: 'default', worktree: false });
    expect(first.kind).toBe('started');
    const queued = await repository.enqueueOrReuse({ task: 'second', workflow: 'default', worktree: false });
    expect(queued.kind).toBe('reused');
    const adopted = await repository.adopt({
      taskId: first.task.taskId,
      generation: first.task.generation,
      executionId: first.executionId!,
      ownerToken: first.ownerToken!,
    });
    await repository.terminal({
      taskId: adopted.taskId,
      generation: adopted.generation,
      executionId: first.executionId!,
      ownerToken: first.ownerToken!,
      status: 'completed',
    });

    const claimResults = await Promise.all([
      repository.claimNextPending(),
      repository.claimNextPending(),
    ]);
    const claimed = claimResults.find((result) => result !== undefined);
    const duplicate = claimResults.find((result) => result === undefined);
    expect(claimed).toBeDefined();
    expect(duplicate).toBeUndefined();
    expect(claimed?.task.taskId).toBe(queued.task.taskId);
    expect(claimed?.task.status).toBe('starting');
    expect(claimed?.task.generation).toBe(queued.task.generation + 1);
    expect(claimed?.ownerToken).not.toBe(first.ownerToken);
    expect(claimed?.executionId).not.toBe(first.executionId);
  });

  it('rejects stale terminal generations and records a terminal outcome by token', async () => {
    const { repository } = await setup();
    const started = await repository.enqueueAndClaim({ task: 'first', workflow: 'default', worktree: false });
    const adopted = await repository.adopt({
      taskId: started.task.taskId,
      generation: started.task.generation,
      executionId: started.executionId,
      ownerToken: started.ownerToken,
    });
    await expect(repository.terminal({
      taskId: adopted.taskId,
      generation: started.task.generation,
      executionId: started.executionId,
      ownerToken: started.ownerToken,
      status: 'completed',
    })).rejects.toBeInstanceOf(CentralTaskCasError);
    await expect(repository.terminal({
      taskId: adopted.taskId,
      generation: adopted.generation,
      executionId: started.executionId,
      ownerToken: started.ownerToken,
      status: 'failed',
      failure: { code: 'test', message: 'failed' },
    })).resolves.toMatchObject({ status: 'failed', failure: { code: 'test' } });
  });

  it('reconciles a dead worker without auto-requeue', async () => {
    const { repository } = await setup();
    const started = await repository.enqueueAndClaim({ task: 'first', workflow: 'default', worktree: false });
    await repository.setStartingPid({
      taskId: started.task.taskId,
      generation: started.task.generation,
      executionId: started.executionId,
      ownerToken: started.ownerToken,
      pid: 999_999,
    });
    const reconciled = await repository.reconcile();
    expect(reconciled.find((task) => task.taskId === started.task.taskId)).toMatchObject({
      status: 'failed',
      failure: { code: 'worker_crashed' },
    });
    expect((await repository.readTasks()).filter((task) => task.status === 'pending')).toHaveLength(0);
  });

  it('expires only an unadopted startup reservation at its fixed deadline', async () => {
    const { repository } = await setup();
    const started = await repository.enqueueAndClaim({ task: 'startup', workflow: 'default', worktree: false });
    const stored = JSON.parse(await readFile(repository.paths.tasksFile, 'utf8')) as {
      version: number;
      tasks: Array<Record<string, unknown>>;
    };
    stored.tasks = stored.tasks.map((task) => task.taskId === started.task.taskId
      ? {
          ...task,
          activeExecution: {
            ...(task.activeExecution as Record<string, unknown>),
            startedAt: '2000-01-01T00:00:00.000Z',
          },
        }
      : task);
    await writeFile(repository.paths.tasksFile, `${JSON.stringify(stored)}\n`);

    const reconciled = await repository.reconcile();
    expect(reconciled.find((task) => task.taskId === started.task.taskId)).toMatchObject({
      status: 'failed',
      failure: { code: 'startup_timeout' },
    });
  });

  it('keeps the project .takt snapshot unchanged and passes only the private token through env', async () => {
    const { globalConfigDirectory, projectDirectory, project } = await setup();
    const before = await readFile(join(projectDirectory, '.takt-snapshot'), 'utf8').catch(() => 'absent');
    await writeFile(join(projectDirectory, '.takt-snapshot'), 'sentinel');
    const child = Object.assign(new EventEmitter(), { pid: 1234, unref: () => undefined });
    let args: readonly string[] = [];
    let env: NodeJS.ProcessEnv = {};
    const result = await launchTaktRun({
      projectDirectory,
      globalConfigDirectory,
      registeredProject: project,
      request: { prompt: 'central', workflow: 'default', worktree: false },
      spawnProcess: ((_command: string, childArgs: readonly string[], options: { readonly env?: NodeJS.ProcessEnv }) => {
        args = childArgs;
        env = options.env ?? {};
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }) as never,
    });
    expect(result).toMatchObject({ pid: 1234, disposition: 'started', mode: 'run' });
    expect(args).not.toContain('run');
    expect(args).not.toContain(env.TAKT_CENTRAL_OWNER_TOKEN ?? 'missing');
    expect(env.TAKT_CONFIG_DIR).toBe(globalConfigDirectory);
    expect(await readFile(join(projectDirectory, '.takt-snapshot'), 'utf8')).toBe('sentinel');
    expect(before).toBe('absent');
  });

  it('marks a spawn failure terminal and retains the failed task for inspection', async () => {
    const { repository, globalConfigDirectory, projectDirectory, project } = await setup();
    await expect(launchTaktRun({
      projectDirectory,
      globalConfigDirectory,
      registeredProject: project,
      request: { prompt: 'central', workflow: 'default', worktree: false },
      spawnProcess: () => { throw new Error('spawn failed'); },
    })).rejects.toThrow('spawn failed');
    await expect(repository.readTasks()).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        failure: expect.objectContaining({ code: 'spawn_failed', message: 'spawn failed' }),
      }),
    ]);
  });

  it('fails closed for unsupported or incomplete central state', async () => {
    const { globalConfigDirectory, project, repository } = await setup();
    await writeFile(repository.paths.stateFile, JSON.stringify({ ...repository.state, version: 999 }));
    await expect(CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    })).rejects.toThrow(/unsupported/i);

    await writeFile(repository.paths.stateFile, JSON.stringify(repository.state));
    await unlink(repository.paths.tasksFile);
    await expect(CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    })).rejects.toThrow(/incomplete/i);
  });

  it('fails closed when an attached repository loses its task ledger', async () => {
    const { repository } = await setup();
    await unlink(repository.paths.tasksFile);

    await expect(repository.readTasks()).rejects.toBeInstanceOf(CentralTaskCasError);
    await expect(repository.enqueueAndClaim({
      task: 'must not recreate ledger',
      workflow: 'default',
      worktree: false,
    })).rejects.toBeInstanceOf(CentralTaskCasError);
  });
});
