import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hasDaemonProjectWork, listDaemonProjects } from '../features/daemon/projects.js';
import { registerProject, readProjectRegistry } from '../infra/config/global/projectRegistry.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { isDaemonOwnerRunning, readDaemonOwner, removeDaemonOwner, writeDaemonOwner } from '../infra/daemon/owner.js';
import { deleteManagerEvent, readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { GoalStore } from '../infra/goals/store.js';
import { TaskStore } from '../infra/task/store.js';
import type { TaskStatus } from '../infra/task/taskRecordSchemas.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const processes = vi.hoisted(() => ({ alive: vi.fn(), identity: vi.fn() }));
vi.mock('../infra/task/process.js', async (original) => ({
  ...await original<typeof import('../infra/task/process.js')>(),
  isProcessAlive: processes.alive, getProcessIdentity: processes.identity,
}));

let root: string;
let cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-daemon-projects-')));
  cwd = join(root, 'project');
  mkdirSync(cwd);
  processes.alive.mockReset().mockReturnValue(true);
  processes.identity.mockReset().mockReturnValue({ startTime: 'darwin-start-v2:12345' });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it('preserves the manager mark across other commands and keeps legacy registrations valid', async () => {
  const options = { globalConfigDirectory: getGlobalConfigDir(), projectDirectory: cwd };
  const legacy = await registerProject({ ...options, command: 'ui' });
  expect(legacy.managerUsed).toBeUndefined();
  expect(await listDaemonProjects(getGlobalConfigDir())).toEqual([]);
  const marked = await registerProject({ ...options, command: 'manager', managerUsed: true });
  const later = await registerProject({ ...options, command: 'run' });
  expect(later.managerUsed).toBe(true);
  expect(later.stateId).toBe(marked.stateId);
  expect((await readProjectRegistry(getGlobalConfigDir())).warnings).toEqual([]);
  expect(await listDaemonProjects(getGlobalConfigDir())).toEqual([cwd]);
});

it('combines marked projects and workspace assignments once, skipping unavailable directories', async () => {
  const globalConfigDirectory = getGlobalConfigDir();
  const assigned = join(root, 'assigned');
  mkdirSync(assigned);
  await registerProject({ globalConfigDirectory, projectDirectory: cwd, command: 'manager', managerUsed: true });
  const id = randomUUID();
  const workspaceDirectory = join(globalConfigDirectory, 'workspaces', id);
  mkdirSync(workspaceDirectory, { recursive: true });
  writeFileSync(join(workspaceDirectory, 'workspace.json'), JSON.stringify({
    id, name: 'test', repositoryDirectories: [assigned, cwd, join(root, 'missing')],
  }));
  expect(await listDaemonProjects(globalConfigDirectory)).toEqual([assigned, cwd].sort());
  rmSync(cwd, { recursive: true });
  mkdirSync(cwd);
  expect(await listDaemonProjects(globalConfigDirectory)).toEqual([assigned]);
});

it.each(['active', 'paused', 'aborted'] as const)('checks unfinished goals with execution status %s', async (executionStatus) => {
  expect(await hasDaemonProjectWork(cwd)).toBe(false);
  await new GoalStore(cwd).create({ ...goalRecord(), executionStatus });
  expect(await hasDaemonProjectWork(cwd)).toBe(executionStatus !== 'aborted');
});

it('does not treat a completed goal as unfinished', async () => {
  const sha = 'a'.repeat(40);
  await new GoalStore(cwd).create({ ...goalRecord(), status: 'completed', completion: {
    goalBranch: goalRecord().branch, goalSha: sha, targetSha: sha, targetBranch: 'main', summary: 'done',
    changeSummary: { filesChanged: 0, additions: 0, deletions: 0, files: [], truncated: false, totalsTruncated: false },
    instructions: [],
  } });
  expect(await hasDaemonProjectWork(cwd)).toBe(false);
});

it('keeps pending events intact during project inspection', async () => {
  const goal = await new GoalStore(cwd).create(goalRecord());
  saveManagerEvent(cwd, { kind: 'registered', goalId: goal.id });
  await new GoalStore(cwd).update(goal.id, (record) => ({ ...record, executionStatus: 'aborted' }));
  const saved = readManagerEvents(cwd);
  expect(await hasDaemonProjectWork(cwd)).toBe(true);
  expect(readManagerEvents(cwd)).toEqual(saved);
  deleteManagerEvent(saved[0]!);
  expect(await hasDaemonProjectWork(cwd)).toBe(false);
});

it.each(['pending', 'running', 'completed', 'failed'] as const)('checks %s tasks without executing them', async (status: TaskStatus) => {
  new TaskStore(cwd).update(() => ({ tasks: [{
    name: 'test', content: 'test work', status,
    created_at: '2026-10-14T00:00:00Z',
    started_at: status === 'pending' ? null : '2026-10-14T00:00:00Z',
    completed_at: status === 'completed' || status === 'failed' ? '2026-10-14T00:01:00Z' : null,
    ...(status === 'failed' ? { failure: { error: 'test failure' } } : {}),
  }] }));
  const before = readFileSync(join(cwd, '.takt', 'tasks.yaml'));
  expect(await hasDaemonProjectWork(cwd)).toBe(status === 'pending' || status === 'running');
  expect(readFileSync(join(cwd, '.takt', 'tasks.yaml'))).toEqual(before);
});

it('keeps the daemon alive when a goal cannot be read', async () => {
  await new GoalStore(cwd).create(goalRecord());
  writeFileSync(join(cwd, '.takt', 'goals', goalRecord().id, 'goal.json'), '{}');
  expect(await hasDaemonProjectWork(cwd)).toBe(true);
});

it('stores one private owner file and verifies PID reuse and unknown identity', () => {
  const owner = { pid: 1234, identity: { startTime: 'darwin-start-v2:12345' }, version: 'test', cliPath: '/test/cli.js' };
  const directory = getGlobalConfigDir();
  expect(readDaemonOwner(directory)).toBeUndefined();
  writeDaemonOwner(directory, owner);
  expect(readDaemonOwner(directory)).toEqual(owner);
  expect(isDaemonOwnerRunning(owner)).toBe(true);
  processes.identity.mockReturnValue({ startTime: 'darwin-start-v2:12346' });
  expect(isDaemonOwnerRunning(owner)).toBe(false);
  processes.identity.mockReturnValue(undefined);
  expect(() => isDaemonOwnerRunning(owner)).toThrow();
  processes.alive.mockReturnValue(false);
  expect(isDaemonOwnerRunning(owner)).toBe(false);
  removeDaemonOwner(directory);
  expect(readDaemonOwner(directory)).toBeUndefined();
});

it('rejects a malformed owner record instead of using its PID', () => {
  writeFileSync(join(getGlobalConfigDir(), 'daemon.json'), JSON.stringify({ pid: -1 }));
  expect(() => readDaemonOwner(getGlobalConfigDir())).toThrow();
});
