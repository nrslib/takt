import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { getGlobalConfigDir } from '../infra/config/paths.js';
import { isDaemonOwnerRunning, readDaemonOwner, writeDaemonOwner } from '../infra/daemon/owner.js';
import { GoalStore } from '../infra/goals/store.js';
import { readManagerEvents, saveManagerEvent, type ManagerEvent } from '../infra/goals/events.js';
import { readManagerDisplayEvents } from '../features/manager/savedEvents.js';
import { isProcessAlive } from '../infra/task/process.js';
import { getTaskProcessIdentity } from '../infra/task/taskProcessIdentity.js';
import { TaskRecordSchema } from '../infra/task/schema.js';
import { TaskStore } from '../infra/task/store.js';
import type { TaskState } from '../infra/task/types.js';
import { packageVersion } from '../shared/package-info.js';
import { captureOwnedChild, captureOwnedProcess, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';
import { goalRecord } from './helpers/goal-fixtures.js';

const cliPath = join(process.cwd(), 'dist/app/cli/index.js');
const lifecycle = await import(pathToFileURL(join(process.cwd(), 'dist/features/daemon/lifecycle.js')).href) as typeof import('../features/daemon/lifecycle.js');
let root: string;
let cwd: string;
let owned: OwnedProcess[];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'takt-daemon-process-')));
  cwd = join(root, 'project');
  mkdirSync(cwd);
  mkdirSync(join(cwd, '.takt'));
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\n');
  writeFileSync(join(getGlobalConfigDir(), 'config.yaml'), 'provider: mock\nlanguage: ja\n');
  owned = [];
});

afterEach(async () => {
  const owner = readDaemonOwner(getGlobalConfigDir());
  if (owner !== undefined) owned.push({ pid: owner.pid, identity: owner.identity });
  for (const processOwner of owned) await terminateOwnedProcess(processOwner, () => false);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  await lifecycle.ensureDaemon();
  const owner = readDaemonOwner(getGlobalConfigDir());
  expect(owner).toBeDefined();
  owned.push({ pid: owner!.pid, identity: owner!.identity });
  return owner!;
}

async function keepWork() {
  await registerProject({ globalConfigDirectory: getGlobalConfigDir(), projectDirectory: cwd, command: 'manager', managerUsed: true });
  return new GoalStore(cwd).create({ ...goalRecord(), createdAt: new Date().toISOString() });
}

it('starts detached, records its executable/version, reuses it and stops from an unrelated directory', async () => {
  await keepWork();
  const owner = await start();
  expect(owner).toMatchObject({ version: packageVersion, cliPath });
  expect(owner.pid).not.toBe(process.pid);
  expect(isDaemonOwnerRunning(owner)).toBe(true);
  await vi.waitFor(() => {
    expect(readFileSync(join(getGlobalConfigDir(), 'logs', 'daemon.log'), 'utf8')).toContain(cwd);
  }, { timeout: 5_000 });
  await lifecycle.ensureDaemon();
  expect(readDaemonOwner(getGlobalConfigDir())).toEqual(owner);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const stopped = spawn(process.execPath, [cliPath, 'daemon', 'stop'], {
    cwd: outside, env: { ...process.env, TAKT_CONFIG_DIR: getGlobalConfigDir() }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  stopped.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    stopped.once('error', reject);
    stopped.once('exit', resolve);
  });
  const stopOwner = await captureOwnedChild(stopped);
  if (stopOwner !== undefined) owned.push(stopOwner);
  expect(await exited, stderr).toBe(0);
  expect(isProcessAlive(owner.pid)).toBe(false);
  expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
  expect(readFileSync(join(cwd, '.takt', 'goals', goalRecord().id, 'goal.json'), 'utf8')).toContain(goalRecord().objective);
  expect(existsSync(join(outside, '.takt'))).toBe(false);
});

it('lets concurrent ensureDaemon calls both succeed with a single running daemon', async () => {
  await keepWork();
  await expect(Promise.all([lifecycle.ensureDaemon(), lifecycle.ensureDaemon()])).resolves.toEqual([undefined, undefined]);
  const owner = readDaemonOwner(getGlobalConfigDir());
  expect(owner).toBeDefined();
  owned.push({ pid: owner!.pid, identity: owner!.identity });
  expect(isDaemonOwnerRunning(owner!)).toBe(true);
  await lifecycle.stopDaemon();
  expect(isProcessAlive(owner!.pid)).toBe(false);
});

it('keeps only one daemon when two processes start with the same global configuration directory', async () => {
  await keepWork();
  const children = [0, 1].map(() => spawn(process.execPath, [cliPath, 'daemon'], {
    cwd, env: { ...process.env, TAKT_CONFIG_DIR: getGlobalConfigDir() }, stdio: ['ignore', 'ignore', 'pipe'],
  }));
  const stderr = ['', ''];
  children.forEach((child, index) => {
    child.stderr!.on('data', (chunk) => { stderr[index] += String(chunk); });
  });
  for (const child of children) {
    const captured = await captureOwnedChild(child);
    if (captured !== undefined) owned.push(captured);
  }
  await vi.waitFor(() => {
    const owner = readDaemonOwner(getGlobalConfigDir());
    expect(owner).toBeDefined();
    const running = children.filter((child) => child.exitCode === null && child.signalCode === null);
    expect(running).toHaveLength(1);
    expect(running[0]!.pid).toBe(owner!.pid);
    expect(isDaemonOwnerRunning(owner!)).toBe(true);
    const exited = children.find((child) => child.pid !== owner!.pid)!;
    expect(exited.exitCode, stderr.join('\n')).toBe(0);
    expect(existsSync(join(getGlobalConfigDir(), 'daemon.json.lock'))).toBe(false);
  }, { timeout: 10_000 });
  const owner = readDaemonOwner(getGlobalConfigDir())!;
  const logPath = join(getGlobalConfigDir(), 'logs', 'daemon.log');
  await vi.waitFor(() => {
    expect(readFileSync(logPath, 'utf8').split('Daemon projects').length).toBeGreaterThanOrEqual(3);
  }, { timeout: 5_000 });
  expect(readDaemonOwner(getGlobalConfigDir())).toEqual(owner);
  await lifecycle.stopDaemon();
  expect(isProcessAlive(owner.pid)).toBe(false);
  expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
});

it('exits and removes the owner record when no projects have work', async () => {
  const owner = await start();
  await vi.waitFor(() => {
    expect(isProcessAlive(owner.pid)).toBe(false);
    expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
  }, { timeout: 5_000 });
});

it('exits after the last unfinished goal is aborted without processing its records', async () => {
  const goal = await keepWork();
  const owner = await start();
  await new GoalStore(cwd).update(goal.id, (record) => ({ ...record, executionStatus: 'aborted' }));
  await vi.waitFor(() => expect(isProcessAlive(owner.pid)).toBe(false), { timeout: 5_000 });
  expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
  expect((await new GoalStore(cwd).get(goal.id)).executionStatus).toBe('aborted');
});

it.each([{ version: 'previous' }, { cliPath: '/previous/takt.js' }])('restarts a daemon with a differing record: %j', async (difference) => {
  await keepWork();
  const previous = await start();
  writeDaemonOwner(getGlobalConfigDir(), { ...previous, ...difference });
  const current = await start();
  expect(current.pid).not.toBe(previous.pid);
  expect(isProcessAlive(previous.pid)).toBe(false);
  expect(current).toMatchObject({ version: packageVersion, cliPath });
  expect(isDaemonOwnerRunning(current)).toBe(true);
  await lifecycle.stopDaemon();
  expect(isProcessAlive(current.pid)).toBe(false);
});

it('does not signal a reused PID belonging to an unrelated live process', async () => {
  const fixture = captureOwnedProcess(process.pid);
  expect(fixture.identity).toBeDefined();
  const startTime = fixture.identity!.startTime;
  const changed = process.platform === 'win32'
    ? `${new Date(Date.parse(startTime) + 1_000).toISOString().slice(0, -1)}0000Z`
    : startTime.replace(/\d+$/, (ticks) => String(BigInt(ticks) + 1n));
  writeDaemonOwner(getGlobalConfigDir(), {
    pid: process.pid, identity: { startTime: changed }, version: packageVersion, cliPath,
  });
  await lifecycle.stopDaemon();
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(readDaemonOwner(getGlobalConfigDir())).toBeUndefined();
});

it('handles an inbox event without pending tasks or run and exposes its saved result to the TUI', async () => {
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' });
  const goal = await keepWork();
  const scenario = join(root, 'scenario.json');
  const message = 'daemon が完了イベントを取り込みました';
  writeFileSync(scenario, JSON.stringify([{ persona: 'manager', content: '', structured_output: { message, summary: null } }]));
  vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
  saveManagerEvent(cwd, { kind: 'completion', goalId: goal.id, taskName: 'finished', runSlug: 'run-finished', result: { success: true, interrupted: false } });
  const owner = await start();
  await vi.waitFor(async () => {
    expect(readManagerEvents(cwd), JSON.stringify((await new GoalStore(cwd).get(goal.id)).notifications)).toEqual([]);
    expect((await readManagerDisplayEvents(cwd, 'ja')).events.map((event) => event.message))
      .toContain(`${goal.id}: ${message}`);
  }, { timeout: 10_000 });
  expect(isDaemonOwnerRunning(owner)).toBe(true);
  expect(existsSync(join(cwd, '.takt', 'manager-logs'))).toBe(false);
});

it('keeps a failed event and blocked notification across multiple daemon polls without retrying', async () => {
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' });
  const goal = await keepWork();
  const scenario = join(root, 'scenario.json');
  const calls = join(root, 'calls.jsonl');
  writeFileSync(scenario, JSON.stringify([
    { persona: 'manager', content: '', status: 'error', error: 'injected failure' },
    { persona: 'manager', content: '', structured_output: { message: 'unexpected retry', summary: null } },
  ]));
  vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
  vi.stubEnv('TAKT_MOCK_CALL_LOG', calls);
  saveManagerEvent(cwd, { kind: 'registered', goalId: goal.id });
  await start();
  await vi.waitFor(async () => {
    const saved = await new GoalStore(cwd).get(goal.id);
    expect(saved.notifications?.filter((notification) => notification.kind === 'blocked')).toHaveLength(1);
  }, { timeout: 10_000 });
  const logPath = join(getGlobalConfigDir(), 'logs', 'daemon.log');
  const before = readFileSync(logPath, 'utf8').split('Daemon projects').length;
  await vi.waitFor(() => {
    expect(readFileSync(logPath, 'utf8').split('Daemon projects').length).toBeGreaterThanOrEqual(before + 3);
  }, { timeout: 5_000 });
  expect(readManagerEvents(cwd)).toHaveLength(1);
  expect(existsSync(calls), JSON.stringify((await new GoalStore(cwd).get(goal.id)).notifications)).toBe(true);
  const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; personaName: string });
  expect(recorded.filter((call) => call.event === 'start' && call.personaName === 'manager')).toHaveLength(1);
  expect((await new GoalStore(cwd).get(goal.id)).notifications?.filter((notification) => notification.kind === 'blocked')).toHaveLength(1);
  expect(existsSync(join(cwd, '.takt', 'manager-logs'))).toBe(false);
});

it('patrols an active goal without run, saves completion time and does not repeat it on ordinary polls', async () => {
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' });
  const goal = await keepWork();
  await new GoalStore(cwd).update(goal.id, (current) => ({ ...current, createdAt: new Date(Date.now() - 3_600_000).toISOString() }));
  const scenario = join(root, 'patrol-scenario.json');
  const calls = join(root, 'patrol-calls.jsonl');
  writeFileSync(scenario, JSON.stringify([{ persona: 'manager', content: '', structured_output: { message: '点検を終えました', summary: null } }]));
  vi.stubEnv('TAKT_MOCK_SCENARIO', scenario); vi.stubEnv('TAKT_MOCK_CALL_LOG', calls);
  const owner = await start();
  await vi.waitFor(async () => {
    const saved = await new GoalStore(cwd).get(goal.id);
    expect(saved.lastPatrolCompletedAt).toBeDefined();
    expect(saved.workLog).toEqual([expect.objectContaining({ kind: 'patrol' })]);
    expect(readManagerEvents(cwd)).toEqual([]);
  }, { timeout: 10_000 });
  const logPath = join(getGlobalConfigDir(), 'logs', 'daemon.log');
  const before = readFileSync(logPath, 'utf8').split('Daemon projects').length;
  await vi.waitFor(() => {
    expect(readFileSync(logPath, 'utf8').split('Daemon projects').length).toBeGreaterThanOrEqual(before + 3);
  }, { timeout: 5_000 });
  const recorded = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; personaName: string });
  expect(recorded.filter((call) => call.event === 'start' && call.personaName === 'manager')).toHaveLength(1);
  expect(isDaemonOwnerRunning(owner)).toBe(true);
});

it('recovers an existing task after its owner exits while the same daemon keeps patrolling without pending work', async () => {
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' });
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: ja\nmanager:\n  patrol_interval: 1\n');
  const goal = await keepWork();
  await new GoalStore(cwd).update(goal.id, (current) => ({
    ...current, createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  }));
  const taskOwner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false });
  const captured = await captureOwnedChild(taskOwner);
  expect(captured).toBeDefined();
  owned.push(captured!);
  const identity = getTaskProcessIdentity(captured!.pid);
  expect(identity).toBeDefined();
  const taskStore = new TaskStore(cwd);
  const task = TaskRecordSchema.parse({
    name: 'interrupted-goal-task', content: 'Recover this task', status: 'running',
    goal_id: goal.id, run_slug: 'run-interrupted', created_at: '2026-10-06T00:00:00Z',
    started_at: '2026-10-06T00:00:00Z', completed_at: null,
    owner_pid: captured!.pid, owner_start_time: identity!.startTime,
  });
  taskStore.update(() => ({ tasks: [task, { ...task, name: 'interrupted-ordinary-task', goal_id: undefined }] }));
  const scenario = join(root, 'recovery-scenario.json');
  const prompts = join(root, 'recovery-prompts.jsonl');
  writeFileSync(scenario, JSON.stringify(Array.from({ length: 20 }, () => ({
    persona: 'manager', content: '', structured_output: { message: 'タスク状態を確認しました', summary: null },
  }))));
  vi.stubEnv('TAKT_MOCK_SCENARIO', scenario);
  vi.stubEnv('TAKT_MOCK_PROMPT_LOG', prompts);
  type Turn = { event: ManagerEvent; tasks: TaskState[]; goal: { taskStates: Record<string, number> } };
  const readTurns = (): Turn[] => {
    if (!existsSync(prompts)) return [];
    return readFileSync(prompts, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { personaName: string; prompt: string })
      .filter(({ personaName }) => personaName === 'manager')
      .map(({ prompt }) => JSON.parse(prompt.split('\n\nGoal memory')[0]!) as Turn);
  };
  const owner = await start();
  await vi.waitFor(() => {
    const patrol = readTurns().find(({ event }) => event.kind === 'patrol');
    expect(patrol?.tasks).toEqual([expect.objectContaining({ name: task.name, status: 'running', ownerPid: captured!.pid })]);
    expect(patrol?.goal.taskStates).toEqual({ running: 1 });
    expect(taskStore.read().tasks.map(({ status }) => status)).toEqual(['running', 'running']);
  }, { timeout: 10_000 });

  await terminateOwnedProcess(captured!, () => taskOwner.exitCode !== null || taskOwner.signalCode !== null);

  await vi.waitFor(() => {
    const saved = taskStore.read().tasks;
    expect(saved.map(({ status }) => status)).toEqual(['failed', 'failed']);
    expect(saved[0]).toMatchObject({ name: task.name, owner_pid: null, owner_start_time: null,
      completion: { success: false, interrupted: true }, run_slug: 'run-interrupted' });
    const patrol = readTurns().find(({ event, tasks }) => event.kind === 'patrol' && tasks[0]?.status === 'failed');
    expect(patrol?.tasks).toEqual([expect.objectContaining({ name: task.name, status: 'failed',
      completion: expect.objectContaining({ success: false, interrupted: true }) })]);
    expect(patrol?.goal.taskStates).toEqual({ failed: 1 });
  }, { timeout: 10_000 });

  const patrolsBefore = readTurns().filter(({ event }) => event.kind === 'patrol').length;
  await vi.waitFor(() => {
    expect(readTurns().filter(({ event }) => event.kind === 'patrol').length).toBeGreaterThanOrEqual(patrolsBefore + 2);
  }, { timeout: 10_000 });
  const completions = readTurns().filter(({ event }) => event.kind === 'completion').map(({ event }) => event);
  expect(completions).toEqual([expect.objectContaining({ kind: 'completion', goalId: goal.id,
    taskName: task.name, runSlug: 'run-interrupted', result: expect.objectContaining({ success: false, interrupted: true }) })]);
  expect(taskStore.read().tasks.some(({ status }) => status === 'pending')).toBe(false);
  expect(readDaemonOwner(getGlobalConfigDir())).toEqual(owner);
  expect(isDaemonOwnerRunning(owner)).toBe(true);
});
