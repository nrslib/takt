import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { spawnSync } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect,it,vi } from 'vitest';
import { transitionGoalExecution } from '../infra/goals/state.js';
import { GoalStore } from '../infra/goals/store.js';
import { acquireProjectExecutionLock } from '../infra/task/project-execution-lock.js';
import { TaskRunner } from '../infra/task/runner.js';
import { goalRecord } from './helpers/goal-fixtures.js';

it.each([false, true])('rejects claim after abort in the same TaskRunner even before pending invalidation (goalTasksOnly=%s)', async (goalTasksOnly) => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'goal-claim-abort-'));
  try {
    const store = new GoalStore(cwd);
    const goal = await store.create(goalRecord());
    const other = await store.create({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' });
    const runner = new TaskRunner(cwd, { goalTasksOnly });
    const running = runner.addTask('already running', { goal_id: goal.id });
    expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([running.name]);
    const pending = runner.addTask('aborted candidate', { goal_id: goal.id });
    const ordinary = runner.addTask('ordinary candidate');
    const active = runner.addTask('active candidate', { goal_id: other.id });
    await store.update(goal.id, (saved) => transitionGoalExecution(saved, 'aborted'));
    expect(runner.claimNextTasks(2).map(({ name }) => name)).toEqual(goalTasksOnly ? [active.name] : [ordinary.name, active.name]);
    expect(runner.claimNextTasks(1)).toEqual([]);
    expect(runner.listTaskStateItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: running.name, status: 'running' }),
      expect.objectContaining({ name: pending.name, status: 'pending' }),
    ]));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it.each([
  { kind: 'run', exitCode: 1 },
  { kind: 'watch', exitCode: 1 },
])('preserves CLI lock conflict behavior for $kind', ({ kind, exitCode }) => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'cli-lock-conflict-'));
  const runner = new TaskRunner(cwd);
  runner.addTask('ordinary pending work');
  writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
  const tasksFile = join(cwd, '.takt', 'tasks.yaml');
  const saved = readFileSync(tasksFile);
  const lock = acquireProjectExecutionLock(cwd, 'watch');
  try {
    const child = spawnSync(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), kind], {
      cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(exitCode);
    const output = child.stdout + child.stderr;
    expect(output).toContain(`TAKT watch is already running for this project (PID ${process.pid})`);
    expect(readFileSync(tasksFile)).toEqual(saved);
  } finally {
    lock.release();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each([false, true])('rechecks pause and resume in the same TaskRunner and preserves claim order and capacity (goalTasksOnly=%s)', async (goalTasksOnly) => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'goal-claim-pause-'));
  try {
    const store = new GoalStore(cwd);
    const goal = await store.create(goalRecord());
    const other = await store.create({ ...goalRecord(), id: '550e8400-e29b-41d4-a716-446655440001' });
    const runner = new TaskRunner(cwd, { goalTasksOnly });
    const started = runner.addTask('already running', { goal_id: goal.id });
    expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([started.name]);
    const paused = runner.addTask('paused candidate', { goal_id: goal.id });
    const ordinary = runner.addTask('ordinary candidate');
    const active = runner.addTask('active candidate', { goal_id: other.id });
    await store.update(goal.id, (saved) => transitionGoalExecution(saved, 'paused'));
    expect(runner.claimNextTasks(0)).toEqual([]);
    expect(runner.claimNextTasks(2).map(({ name }) => name)).toEqual(goalTasksOnly ? [active.name] : [ordinary.name, active.name]);
    expect(runner.listTaskStateItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: started.name, status: 'running' }),
      expect.objectContaining({ name: paused.name, status: 'pending' }),
    ]));
    expect(runner.claimNextTasks(1)).toEqual([]);
    await store.update(goal.id, (saved) => transitionGoalExecution(saved, 'active'));
    expect(runner.claimNextTasks(1).map(({ name }) => name)).toEqual([paused.name]);
    if (goalTasksOnly) expect(runner.listTaskStateItems()).toContainEqual(expect.objectContaining({ name: ordinary.name, status: 'pending' }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('does not spawn another automatic run when initial task processing fails with goal work still pending', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-startup-failure-'));
  try {
    await new GoalStore(cwd).create({ ...goalRecord(), id: '00000000-0000-4000-8000-000000000001' });
    const runner = new TaskRunner(cwd);
    const task = runner.addTask('saved goal task', {
      goal_id: '00000000-0000-4000-8000-000000000001', worktree: false,
    });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
    const hook = join(cwd, 'startup-failure-hook.mjs');
    const launchMarker = join(cwd, 'unexpected-relaunch');
    writeFileSync(hook, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { TaskRunner } from ${JSON.stringify(moduleUrl('infra/task/runner.js'))};
TaskRunner.prototype.failInterruptedRunningTasks = () => { throw new Error('injected initial processing failure'); };
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args.includes('run')) {
    writeFileSync(${JSON.stringify(launchMarker)}, 'attempted relaunch');
    throw new Error('Test prevents an unbounded relaunch');
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`);
    const child = spawnSync(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'run'], {
      cwd, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}` },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).toContain('injected initial processing failure');
    expect(existsSync(launchMarker)).toBe(false);
    expect(runner.listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: task.name, kind: 'pending' },
    ]);
    const lock = acquireProjectExecutionLock(cwd, 'run');
    lock.release();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('leaves events and goals unchanged in event-only runs without calling the manager or restarting', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-event-failure-'));
  try {
    const goal = await new GoalStore(cwd).create(goalRecord());
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\n');
    saveManagerEvent(cwd, { kind: 'registered', goalId: goal.id });
    const saved = readManagerEvents(cwd);
    const savedGoal = await new GoalStore(cwd).get(goal.id);
    const launchMarker = join(cwd, 'unexpected-relaunch');
    const managerMarker = join(cwd, 'unexpected-manager');
    const hook = join(cwd, 'event-failure-hook.mjs');
    const mockUrl = pathToFileURL(join(process.cwd(), 'dist/infra/providers/mock.js')).href;
    writeFileSync(hook, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { MockProvider } from ${JSON.stringify(mockUrl)};
MockProvider.prototype.setup = () => {
  writeFileSync(${JSON.stringify(managerMarker)}, 'unexpected manager call');
  throw new Error('Run must not process manager events');
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args.includes('run')) {
    writeFileSync(${JSON.stringify(launchMarker)}, 'unexpected restart');
    throw new Error('Test prevents an unbounded restart');
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawnSync(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'run'], {
        cwd, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}` },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(existsSync(managerMarker)).toBe(false);
      expect(existsSync(launchMarker)).toBe(false);
      expect(readManagerEvents(cwd)).toEqual(saved);
      expect(await new GoalStore(cwd).get(goal.id)).toEqual(savedGoal);
      const lock = acquireProjectExecutionLock(cwd, 'run');
      lock.release();
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
