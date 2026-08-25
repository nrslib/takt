import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  launchTaktRun,
  parseLaunchRequest,
} from '../features/web-ui/launcher.js';
import {
  buildCentralWorkerStderrPath,
  buildWorkerArguments,
  spawnCentralWorker,
} from '../features/web-ui/central-worker-spawn.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { CentralTaskRepository } from '../infra/task/centralStateRepository.js';

describe('Web UI central launcher', () => {
  it('normalizes a request with the default worktree policy', () => {
    expect(parseLaunchRequest({ prompt: '  Build it  ', workflow: ' default ' })).toEqual({
      prompt: 'Build it',
      workflow: 'default',
      worktree: true,
    });
  });

  it('normalizes safe worktree paths and rejects traversal', () => {
    expect(parseLaunchRequest({ prompt: 'task', workflow: 'default', worktree: '  worktree  ' }).worktree)
      .toBe('worktree');
    expect(() => parseLaunchRequest({ prompt: 'task', workflow: 'default', worktree: '../outside' }))
      .toThrow(/worktree/);
  });

  it('uses an internal worker command', () => {
    expect(buildWorkerArguments('/opt/takt/worker.js', {
      stateId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      generation: 0,
      executionId: '33333333-3333-4333-8333-333333333333',
    })).not.toContain('run');
  });

  it('rejects a symlinked detached-worker stderr path before spawning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'takt-launcher-stderr-'));
    const target = join(directory, 'outside.log');
    const stderrPath = join(directory, 'worker.log');
    await writeFile(target, 'outside');
    await symlink(target, stderrPath);

    await expect(spawnCentralWorker({
      workerEntryPath: '/opt/takt/worker.js',
      projectDirectory: directory,
      globalConfigDirectory: directory,
      stateId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      generation: 0,
      executionId: '33333333-3333-4333-8333-333333333333',
      ownerToken: 'owner-token-for-test',
      stderrPath,
      spawnProcess: (() => { throw new Error('must not spawn'); }) as never,
    })).rejects.toThrow(/diagnostics|symbolic|symlink|ELOOP|EEXIST|already exists/i);
    await expect(readFile(target, 'utf8')).resolves.toBe('outside');
  });

  it('uses an execution-specific stderr path and rejects an existing collision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'takt-launcher-stderr-'));
    const firstPath = buildCentralWorkerStderrPath(directory, 'task-id', 'execution-one');
    const secondPath = buildCentralWorkerStderrPath(directory, 'task-id', 'execution-two');
    expect(firstPath).not.toBe(secondPath);

    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: () => undefined });
    const spawnProcess = (() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as never;
    const options = {
      workerEntryPath: '/opt/takt/worker.js',
      projectDirectory: directory,
      globalConfigDirectory: directory,
      stateId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      generation: 0,
      executionId: '33333333-3333-4333-8333-333333333333',
      ownerToken: 'owner-token-for-test',
      stderrPath: firstPath,
      spawnProcess,
    };
    await spawnCentralWorker(options);
    await expect(spawnCentralWorker(options)).rejects.toThrow(/EEXIST|already exists|diagnostics/i);
  });

  it('does not serialize a Web task into project .takt', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-launcher-global-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-launcher-project-'));
    const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: () => undefined });
    let command = '';
    let args: readonly string[] = [];
    const result = await launchTaktRun({
      projectDirectory,
      globalConfigDirectory,
      registeredProject: project,
      request: { prompt: 'central task', workflow: 'default', worktree: false },
      spawnProcess: ((_command: string, childArgs: readonly string[]) => {
        command = _command;
        args = childArgs;
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }) as never,
    });
    expect(result).toEqual({ pid: process.pid, disposition: 'started', mode: 'run' });
    expect(command).toBe(process.execPath);
    expect(args).not.toContain('run');
    await expect(readFile(join(projectDirectory, '.takt', 'tasks.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const repository = await CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    });
    await expect(repository.readTasks()).resolves.toHaveLength(1);
  });

  it('returns reused when another UI request already owns the state', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-launcher-global-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-launcher-project-'));
    const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
    const child = Object.assign(new EventEmitter(), { pid: process.pid, unref: () => undefined });
    const spawnProcess = ((_command: string, _args: readonly string[]) => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as never;
    await launchTaktRun({ projectDirectory, globalConfigDirectory, registeredProject: project, request: { prompt: 'one', workflow: 'default', worktree: false }, spawnProcess });
    const second = await launchTaktRun({ projectDirectory, globalConfigDirectory, registeredProject: project, request: { prompt: 'two', workflow: 'default', worktree: false }, spawnProcess: (() => { throw new Error('must not spawn'); }) as never });
    expect(second).toMatchObject({ disposition: 'reused', mode: 'run' });
  });

  it('terminalizes a child that exits before startup adoption without a later request', async () => {
    const globalConfigDirectory = await mkdtemp(join(tmpdir(), 'takt-launcher-global-'));
    const projectDirectory = await mkdtemp(join(tmpdir(), 'takt-launcher-project-'));
    const project = await registerProject({ globalConfigDirectory, projectDirectory, command: 'ui' });
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      unref: () => undefined,
    });
    await launchTaktRun({
      projectDirectory,
      globalConfigDirectory,
      registeredProject: project,
      request: { prompt: 'crash before adopt', workflow: 'default', worktree: false },
      spawnProcess: ((_command: string, _args: readonly string[]) => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }) as never,
    });

    child.exitCode = 1;
    child.emit('exit', 1, null);
    const repository = await CentralTaskRepository.open({
      globalConfigDirectory,
      stateId: project.stateId,
      locationId: project.locationId,
      canonicalDirectory: project.canonicalDirectory,
      displayName: project.displayName,
      fingerprint: project.fingerprint,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await repository.readTasks();
      if (current[0]?.status === 'failed') break;
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    }
    const tasks = await repository.readTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'failed', failure: { code: 'spawn_failed' } });
  });
});
