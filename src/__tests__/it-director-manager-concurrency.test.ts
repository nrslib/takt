import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { createWorkspace, readWorkspace } from '../infra/config/global/workspaceRegistry.js';
import { conversationId } from '../infra/conversations/identity.js';
import type { ConversationAssignment } from '../infra/conversations/schema.js';
import { withManagerLifecycleLock } from '../infra/conversations/managerLifecycleLock.js';
import { DirectorManagerStateStore } from '../infra/director/managerState.js';
import { FileAsyncLock } from '../infra/daemon/lock.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTaktMcpServer } from '../features/mcp/server.js';
import { createTaktGoal } from '../features/mcp/goalOperations.js';
import { readManagerEvents } from '../infra/goals/events.js';
import { goalId, goalInput } from './helpers/goal-fixtures.js';
import { GoalStore } from '../infra/goals/store.js';
import * as registration from '../infra/goals/service.js';
import { fireDirectorManager } from '../features/director/managerLifecycle.js';
import { listDirectorManagers } from '../features/director/managers.js';
import { DaemonRouting } from '../features/daemon/routing.js';
import { managerApproval } from './helpers/manager-approval.js';
import { deferred } from './helpers/daemon-turn.js';

let config: string;
let repository: string;
const signal = () => new AbortController().signal;
const cleanups: Array<() => Promise<void>> = [];

function repositoryAt(name: string) {
  const directory = join(realpathSync(config), name);
  mkdirSync(directory);
  execFileSync('git', ['init', '-b', 'main', directory], { stdio: 'pipe' });
  execFileSync('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'pipe' });
  return directory;
}
beforeEach(async () => {
  config = getGlobalConfigDir();
  repository = repositoryAt('repository');
  await registerProject({ globalConfigDirectory: config, projectDirectory: repository, command: 'manager', managerUsed: true });
});
afterEach(async () => {
  try { for (const close of cleanups.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

async function assignment(workspace: boolean) {
  if (!workspace) return { kind: 'repository' as const, repositoryDirectory: repository };
  const first = repositoryAt('first-member');
  const value = await createWorkspace({ globalConfigDirectory: config, name: 'apps', repositoryDirectories: [first, repository] });
  return { kind: 'workspace' as const, workspaceId: value.id };
}

function childOperation(identity: Exclude<ConversationAssignment, { kind: 'daemon' }>, mode: 'fire' | 'approve' | 'create' | 'add') {
  const messages: Array<Record<string, unknown>> = [];
  const changed = new Set<() => void>();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./helpers/manager-lifecycle-child.ts', import.meta.url)),
    config, JSON.stringify(identity), repository, mode], {
    env: { ...process.env, TAKT_CONFIG_DIR: config }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 20_000,
  });
  let errors = '';
  child.stderr!.on('data', (data: Buffer) => { errors += data.toString(); });
  child.stdout!.resume();
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Child failed: ${code}/${signal}: ${errors}`)));
  });
  void exited.catch(() => {});
  child.on('message', (message: Record<string, unknown>) => { messages.push(message); for (const update of changed) update(); });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
  });
  const waitFor = async (matches: (value: Record<string, unknown>) => boolean) => {
    while (true) {
      const message = messages.find(matches);
      if (message !== undefined) return message;
      const update = deferred<void>(); const notify = () => update.resolve(); changed.add(notify);
      try {
        await Promise.race([update.promise, exited.then(() => { throw new Error(`Child exited before expected message: ${JSON.stringify(messages)}`); })]);
      } finally { changed.delete(notify); }
    }
  };
  return { wait: (kind: string) => waitFor((value) => value.kind === kind), waitFor, messages, exited };
}

it.each([false, true])('waits for approval in another process before fire checks every goal (workspace: %s)', async (workspace) => {
  const identity = await assignment(workspace); const id = conversationId(identity);
  const entered = deferred<void>(); const release = deferred<void>();
  const register = registration.registerReservedGoal;
  vi.spyOn(registration, 'registerReservedGoal').mockImplementation(async (...args) => {
    entered.resolve(); await release.promise; return register(...args);
  });
  const approval = managerApproval(config, identity, repository, signal(), () => {}).run();
  cleanups.push(async () => { release.resolve(); await approval; });
  await entered.promise;
  const child = childOperation(identity, 'fire');
  const attempt = await child.waitFor(attemptedHeldLock);
  expect(JSON.parse(readFileSync(String(attempt.path), 'utf8')).pid).toBe(process.pid);
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  expect(await new DirectorManagerStateStore(config).isFired(id)).toBe(false);
  release.resolve();
  const outcome = await approval;
  expect(outcome).toMatchObject({ kind: 'completed', result: { kind: 'goal_registered' } });
  if (outcome.kind !== 'completed' || outcome.result.kind !== 'goal_registered') throw new Error('Expected registered goal');
  expect(await child.wait('result')).toMatchObject({ fired: false, error: expect.stringContaining(outcome.result.goal.id) });
  await child.exited;
  expect((await new GoalStore(repository).list()).goals).toHaveLength(1);
  expect(await new DirectorManagerStateStore(config).isFired(id)).toBe(false);
  expect((await listDirectorManagers(config)).managers.map(conversationId)).toContain(id);
});

async function publicGoalCreator() {
  const client = new Client({ name: 'lifecycle-test', version: '1.0.0' });
  const server = createTaktMcpServer({}, { allowedProjectRoot: repository, toolSet: 'all' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return () => client.callTool({ name: 'takt_create_goal', arguments: { cwd: repository, id: goalId, ...goalInput() } });
}

async function managerClient(identity: Exclude<ConversationAssignment, { kind: 'daemon' }>) {
  const client = new Client({ name: 'lifecycle-workspace-test', version: '1.0.0' });
  const server = createTaktMcpServer({}, { toolSet: 'manager', managerAssignment: identity });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function attemptedHeldLock(message: Record<string, unknown>) {
  return message.kind === 'attempt' && typeof message.path === 'string' && existsSync(message.path)
    && JSON.parse(readFileSync(message.path, 'utf8')).pid === process.pid;
}

it.each([1, 2, 3].flatMap((run) => ['add', 'create', 'remove'].flatMap((mutation) =>
  [true, false].map((before) => ({ run, mutation, before })))))(
  'serializes public creation across workspace $mutation (before creation: $before, run: $run)', async ({ before, mutation }) => {
    const first = repositoryAt('first-member');
    const workspace = mutation === 'create' ? undefined : await createWorkspace({ globalConfigDirectory: config, name: 'apps',
      repositoryDirectories: mutation === 'remove' ? [first, repository] : [first] });
    const source = workspace === undefined ? { kind: 'repository' as const, repositoryDirectory: first }
      : { kind: 'workspace' as const, workspaceId: workspace.id };
    const manager = await managerClient(source);
    const mutate = async () => {
      const result = await manager.callTool({ name: mutation === 'remove' ? 'takt_remove_workspace_repository' : 'takt_add_workspace_repository',
        arguments: { repositoryDirectory: repository } });
      expect(result.isError).toBeUndefined();
      const saved = JSON.parse((result.content as Array<{ text: string }>)[0]!.text).workspace;
      expect(saved.repositoryDirectories).toEqual(mutation === 'remove' ? [first] : [first, repository]);
      return mutation === 'remove' ? { kind: 'repository' as const, repositoryDirectory: repository }
        : { kind: 'workspace' as const, workspaceId: saved.id as string };
    };
    let identity = before ? await mutate() : undefined;
    const create = await publicGoalCreator();
    const entered = deferred<void>(); const release = deferred<void>();
    const register = registration.createGoal;
    vi.spyOn(registration, 'createGoal').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; return register(...args);
    });
    const creation = create();
    cleanups.push(async () => { release.resolve(); await creation; });
    await entered.promise;
    if (identity === undefined) identity = await mutate();
    const id = conversationId(identity);
    const child = childOperation(identity, 'fire');
    const boundary = await child.waitFor((value) => attemptedHeldLock(value) || value.kind === 'result');
    expect((await new GoalStore(repository).list()).goals).toEqual([]);
    release.resolve();
    expect((await creation).isError).toBeUndefined();
    const result = await child.wait('result');
    await child.exited;
    const listed = (await listDirectorManagers(config)).managers.map(conversationId);
    console.info(JSON.stringify({ scenario: 'workspace-membership', mutation, before, boundary, messages: child.messages, listed,
      goal: await new GoalStore(repository).get(goalId), branches: goalBranches() }));
    expect(result).toMatchObject({ fired: false, error: expect.stringContaining(goalId) });
    expect(await new DirectorManagerStateStore(config).isFired(id)).toBe(false);
    expect(listed).toContain(id);
    expect(goalBranches()).toHaveLength(1);
  },
);

it.each([1, 2, 3].flatMap((run) => [true, false].map((before) => ({ run, before }))))(
  'orders workspace addition and fire after scanning (before fire: $before, run: $run)', async ({ before }) => {
    const first = repositoryAt('first-member');
    const workspace = await createWorkspace({ globalConfigDirectory: config, name: 'apps', repositoryDirectories: [first] });
    const identity = { kind: 'workspace' as const, workspaceId: workspace.id }; const id = conversationId(identity);
    const create = await publicGoalCreator();
    expect((await create()).isError).toBeUndefined();
    const manager = await managerClient(identity);
    if (before) {
      expect((await manager.callTool({ name: 'takt_add_workspace_repository', arguments: { repositoryDirectory: repository } })).isError).toBeUndefined();
      await expect(fireDirectorManager(new DaemonRouting(config), id, signal())).rejects.toThrow(goalId);
      expect((await listDirectorManagers(config)).managers.map(conversationId)).toContain(id);
      return;
    }
    const scanned = deferred<void>(); const release = deferred<void>();
    const save = DirectorManagerStateStore.prototype.setFired;
    vi.spyOn(DirectorManagerStateStore.prototype, 'setFired').mockImplementation(async function(this: DirectorManagerStateStore, ...args) {
      scanned.resolve(); await release.promise; return save.apply(this, args);
    });
    const firing = fireDirectorManager(new DaemonRouting(config), id, signal());
    cleanups.push(async () => { release.resolve(); await firing; });
    await scanned.promise;
    const child = childOperation(identity, 'add');
    const boundary = await child.waitFor((value) => attemptedHeldLock(value) || value.kind === 'result');
    const during = (await readWorkspace(config, workspace.id))?.repositoryDirectories;
    release.resolve(); await firing;
    expect(await child.wait('result')).toMatchObject({ failed: false });
    await child.exited;
    console.info(JSON.stringify({ scenario: 'addition-after-scan', boundary, during, messages: child.messages,
      members: (await readWorkspace(config, workspace.id))?.repositoryDirectories }));
    expect(during).toEqual([first]);
    expect((await readWorkspace(config, workspace.id))?.repositoryDirectories).toEqual([first, repository]);
    expect(await new DirectorManagerStateStore(config).isFired(id)).toBe(true);
    expect((await listDirectorManagers(config)).managers.map(conversationId)).not.toContain(id);
    expect(await new GoalStore(repository).get(goalId)).toMatchObject({ executionStatus: 'active' });
    expect(goalBranches()).toHaveLength(1);
  },
);

function goalBranches() {
  return execFileSync('git', ['-C', repository, 'for-each-ref', '--format=%(refname)', `refs/heads/takt/*-goal-${goalId.slice(0, 8)}`],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

it.each([false, true])('waits for public MCP creation before fire scans (workspace: %s)', async (workspace) => {
  const identity = await assignment(workspace); const id = conversationId(identity);
  const create = await publicGoalCreator();
  const entered = deferred<void>(); const release = deferred<void>();
  const register = registration.createGoal;
  vi.spyOn(registration, 'createGoal').mockImplementation(async (...args) => {
    entered.resolve(); await release.promise; return register(...args);
  });
  const creation = create();
  cleanups.push(async () => { release.resolve(); await creation; });
  await entered.promise;
  const child = childOperation(identity, 'fire');
  const attempt = await child.waitFor(attemptedHeldLock);
  expect(JSON.parse(readFileSync(String(attempt.path), 'utf8')).pid).toBe(process.pid);
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  release.resolve();
  expect((await creation).isError).toBeUndefined();
  expect(await child.wait('result')).toMatchObject({ fired: false, error: expect.stringContaining(goalId) });
  await child.exited;
  expect(await new GoalStore(repository).get(goalId)).toMatchObject({ status: 'created', executionStatus: 'active' });
  expect(readManagerEvents(repository).map(({ event }) => event)).toMatchObject([{ kind: 'registered', goalId }]);
  expect((await listDirectorManagers(config)).managers.map(conversationId)).toContain(id);
});

it.each([
  { workspace: false, empty: false }, { workspace: false, empty: true },
  { workspace: true, empty: false }, { workspace: true, empty: true },
])('finishes fire before public MCP can save after scanning (workspace: $workspace, empty directory: $empty)', async ({ workspace, empty }) => {
  if (empty) mkdirSync(join(repository, '.takt', 'goals'), { recursive: true });
  const identity = await assignment(workspace); const id = conversationId(identity);
  const scanned = deferred<void>(); const release = deferred<void>();
  const save = DirectorManagerStateStore.prototype.setFired;
  vi.spyOn(DirectorManagerStateStore.prototype, 'setFired').mockImplementation(async function(this: DirectorManagerStateStore, ...args) {
    scanned.resolve(); await release.promise; return save.apply(this, args);
  });
  const firing = fireDirectorManager(new DaemonRouting(config), id, signal());
  cleanups.push(async () => { release.resolve(); await firing; });
  await scanned.promise;
  const child = childOperation(identity, 'create');
  await child.wait('received');
  const attempt = await child.waitFor(attemptedHeldLock);
  expect(JSON.parse(readFileSync(String(attempt.path), 'utf8')).pid).toBe(process.pid);
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  release.resolve();
  await expect(firing).resolves.toEqual({ managerId: id });
  expect(await child.wait('acquired')).toMatchObject({ fired: true });
  expect(await child.wait('saved')).toMatchObject({ fired: true });
  expect(await child.wait('result')).toMatchObject({ failed: false });
  await child.exited;
  expect((await new GoalStore(repository).list()).goals).toHaveLength(1);
  expect((await listDirectorManagers(config)).managers.map(conversationId)).not.toContain(id);
});

it('releases the public creation lock after a save failure and permits retry with Git compensation intact', async () => {
  const identity = await assignment(false); const id = conversationId(identity);
  const create = await publicGoalCreator();
  vi.spyOn(GoalStore.prototype, 'create').mockRejectedValueOnce(new Error('Save failed'));
  expect((await create()).isError).toBe(true);
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  expect(goalBranches()).toEqual([]);
  expect(readManagerEvents(repository)).toEqual([]);
  expect((await create()).isError).toBeUndefined();
  expect(goalBranches()).toHaveLength(1);
  expect(readManagerEvents(repository)).toHaveLength(1);
  await expect(fireDirectorManager(new DaemonRouting(config), id, signal())).rejects.toThrow(goalId);
});

it('cancels public creation during lock acquisition without goals, branches or events and permits retry', async () => {
  const identity = await assignment(false); const id = conversationId(identity);
  const held = deferred<void>(); const release = deferred<void>();
  const holding = withManagerLifecycleLock(config, id, signal(), async () => { held.resolve(); await release.promise; });
  cleanups.push(async () => { release.resolve(); await holding; });
  await held.promise;
  const attempting = deferred<void>(); const controller = new AbortController();
  const acquire = FileAsyncLock.prototype.acquire;
  vi.spyOn(FileAsyncLock.prototype, 'acquire').mockImplementation(function(this: FileAsyncLock, path, options) {
    attempting.resolve(); return acquire.call(this, path, options);
  });
  const input = { cwd: repository, id: goalId, ...goalInput() };
  const creating = createTaktGoal(input, {}, controller.signal);
  await attempting.promise; controller.abort();
  expect((await creating).isError).toBe(true);
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  expect(goalBranches()).toEqual([]);
  expect(readManagerEvents(repository)).toEqual([]);
  release.resolve(); await holding;
  expect((await createTaktGoal(input, {}, signal())).isError).toBeUndefined();
  await expect(fireDirectorManager(new DaemonRouting(config), id, signal())).rejects.toThrow(goalId);
});

it('creates a public goal when the isolated global config directory does not exist', async () => {
  const identity = await assignment(false);
  config = join(config, 'fresh-config');
  expect(existsSync(config)).toBe(false);
  const child = childOperation(identity, 'create');
  expect(await child.wait('result')).toMatchObject({ failed: false });
  await child.exited;
  expect(existsSync(config)).toBe(true);
  expect(await new GoalStore(repository).get(goalId)).toMatchObject({ status: 'created' });
  expect(goalBranches()).toHaveLength(1);
});

it.each([
  { workspace: false, empty: false }, { workspace: false, empty: true },
  { workspace: true, empty: false }, { workspace: true, empty: true },
])('finishes fire before approval can save after scanning (workspace: $workspace, empty directory: $empty)', async ({ workspace, empty }) => {
  if (empty) mkdirSync(join(repository, '.takt', 'goals'), { recursive: true });
  const identity = await assignment(workspace); const id = conversationId(identity);
  const scanned = deferred<void>(); const release = deferred<void>();
  const save = DirectorManagerStateStore.prototype.setFired;
  vi.spyOn(DirectorManagerStateStore.prototype, 'setFired').mockImplementation(async function(this: DirectorManagerStateStore, ...args) {
    scanned.resolve(); await release.promise; return save.apply(this, args);
  });
  const firing = fireDirectorManager(new DaemonRouting(config), id, signal());
  cleanups.push(async () => { release.resolve(); await firing; });
  await scanned.promise;
  const child = childOperation(identity, 'approve');
  await child.wait('reserved');
  const attempt = await child.waitFor(attemptedHeldLock);
  expect(JSON.parse(readFileSync(String(attempt.path), 'utf8')).pid).toBe(process.pid);
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  release.resolve();
  expect(await firing).toEqual({ managerId: id });
  expect(await child.wait('acquired')).toMatchObject({ fired: true });
  expect(await child.wait('result')).toMatchObject({ outcome: { kind: 'completed', result: { kind: 'goal_registered' } } });
  await child.exited;
  expect((await new GoalStore(repository).list()).goals).toHaveLength(1);
  expect((await listDirectorManagers(config)).managers.map(conversationId)).not.toContain(id);
});

it('releases the lifecycle lock after registration failure and permits retry without reviving a fired manager', async () => {
  const identity = await assignment(false); const id = conversationId(identity);
  vi.spyOn(registration, 'registerReservedGoal').mockRejectedValueOnce(new Error('Registration failed'));
  const approval = managerApproval(config, identity, repository, signal(), () => {});
  expect(await approval.run()).toMatchObject({ kind: 'completed', result: { kind: 'error' } });
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  expect(await fireDirectorManager(new DaemonRouting(config), id, signal())).toEqual({ managerId: id });
  expect(await approval.run()).toMatchObject({ kind: 'completed', result: { kind: 'goal_registered' } });
  expect((await listDirectorManagers(config)).managers.map(conversationId)).not.toContain(id);
});

it('cancels approval while waiting for the lifecycle lock and leaves it available for fire and retry', async () => {
  const identity = await assignment(false); const id = conversationId(identity);
  const held = deferred<void>(); const release = deferred<void>();
  const holding = withManagerLifecycleLock(config, id, signal(), async () => { held.resolve(); await release.promise; });
  cleanups.push(async () => { release.resolve(); await holding; });
  await held.promise;
  const attempting = deferred<void>(); const controller = new AbortController();
  const acquire = FileAsyncLock.prototype.acquire;
  vi.spyOn(FileAsyncLock.prototype, 'acquire').mockImplementation(function(this: FileAsyncLock, path, options) {
    attempting.resolve(); return acquire.call(this, path, options);
  });
  const approval = managerApproval(config, identity, repository, controller.signal, () => {}).run();
  await attempting.promise; controller.abort();
  expect(await approval).toMatchObject({ kind: 'interrupted' });
  expect((await new GoalStore(repository).list()).goals).toEqual([]);
  release.resolve(); await holding;
  expect(await fireDirectorManager(new DaemonRouting(config), id, signal())).toEqual({ managerId: id });
  expect(await managerApproval(config, identity, repository, signal(), () => {}).run()).toMatchObject({ kind: 'completed', result: { kind: 'goal_registered' } });
});
