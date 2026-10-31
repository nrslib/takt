import { readManagerEvents, saveManagerEvent } from '../infra/goals/events.js';
import { execFileSync,spawn,spawnSync,type ChildProcess } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect,it,vi } from 'vitest';
import { transitionGoalExecution } from '../infra/goals/state.js';
import { GoalStore } from '../infra/goals/store.js';
import { isProcessAlive } from '../infra/task/process.js';
import { acquireProjectExecutionLock } from '../infra/task/project-execution-lock.js';
import { TaskRunner } from '../infra/task/runner.js';
import { MANAGER_GOAL_TASKS_ENV } from '../shared/constants.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { registerProject } from '../infra/config/global/projectRegistry.js';
import { captureOwnedChild,ownedProcessMarkerScript,readOwnedProcessMarker,terminateOwnedProcess,type OwnedProcess } from './helpers/owned-process.js';
import { registerFixtureGoal } from './helpers/registered-goal.js';

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
  { kind: 'run', automatic: false, exitCode: 1 },
  { kind: 'watch', automatic: false, exitCode: 1 },
  { kind: 'run', automatic: true, exitCode: 0 },
])('preserves CLI lock conflict behavior for $kind with automatic=$automatic', ({ kind, automatic, exitCode }) => {
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
      env: { ...process.env, [MANAGER_GOAL_TASKS_ENV]: automatic ? '1' : undefined },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(exitCode);
    const output = child.stdout + child.stderr;
    if (!automatic) expect(output).toContain(`TAKT watch is already running for this project (PID ${process.pid})`);
    else expect(output).not.toContain('already running');
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

it('executes only goal work in detached automatic runs and lets a direct run execute ordinary work', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'manager-auto-run-'));
  const children: Array<{ child: ChildProcess; owned: Promise<OwnedProcess | undefined> }> = [];
  let worker: OwnedProcess | undefined;
  const errors: unknown[] = [];
  try {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'ignore' });
    const tree = execFileSync('git', ['hash-object', '-w', '-t', 'tree', '--stdin'], { cwd, input: '', encoding: 'utf8' }).trim();
    const commit = execFileSync('git', ['commit-tree', tree, '-m', 'auto-run fixture'], {
      cwd, encoding: 'utf8', env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Auto Run Test', GIT_AUTHOR_EMAIL: 'auto-run@example.com',
        GIT_COMMITTER_NAME: 'Auto Run Test', GIT_COMMITTER_EMAIL: 'auto-run@example.com',
      },
    }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/main', commit], { cwd });
    mkdirSync(join(cwd, '.takt', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nlanguage: en\nauto_requeue_max_attempts: 0\n');
    writeFileSync(join(cwd, '.takt', 'workflows', 'auto-run.yaml'), 'name: auto-run\nmax_steps: 2\ninitial_step: work\nsteps:\n  - name: work\n    persona: coder\n    instruction: "{task}"\n    rules:\n      - condition: when(true)\n        next: COMPLETE\n');
    const configDirectory = process.env.TAKT_CONFIG_DIR!;
    writeFileSync(join(configDirectory, 'config.yaml'), 'provider: mock\n');
    const goal = await registerFixtureGoal(cwd);
    mkdirSync(join(cwd, '.takt', 'goals', 'invalid-entry'));
    const runner = new TaskRunner(cwd);
    const ordinary = runner.addTask('one ordinary task', { workflow: 'auto-run', worktree: false });
    const task = runner.addTask('one goal task', { workflow: 'auto-run', worktree: false, goal_id: goal.id });
    const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), 'dist', path)).href;
    const hook = join(cwd, 'provider-hook.mjs');
    writeFileSync(hook, `
${ownedProcessMarkerScript(moduleUrl('infra/task/process.js'))}
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { MockProvider } from ${JSON.stringify(moduleUrl('infra/providers/mock.js'))};
const root = process.env.TAKT_TEST_AUTO_RUN_ROOT;
if (process.argv.includes('run')) {
  writeProcessMarker(join(root, 'run-started-' + process.pid));
  const deadline = Date.now() + 20000;
  while (!existsSync(join(root, 'release-runs'))) {
    if (Date.now() > deadline) throw new Error('Test did not release run startup');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const spawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (args.includes('run')) writeFileSync(join(root, 'launch-' + process.pid), JSON.stringify(args));
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();
MockProvider.prototype.setup = config => ({ call: async () => {
  const manager = config.name === 'manager';
  writeProcessMarker(join(root, manager ? 'ready-' + process.pid : 'worker-entered-' + process.pid));
  const release = join(root, manager ? 'release-turns' : 'release-worker');
  const deadline = Date.now() + 20000;
  while (!existsSync(release)) {
    if (Date.now() > deadline) throw new Error('Test did not release provider');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (process.argv.includes('watch')) setImmediate(() => process.emit('SIGINT'));
  return { persona: config.name, status: 'done', timestamp: new Date(), content: manager ? JSON.stringify({ message: 'ready work saved', summary: null }) : 'completed exactly once', sessionId: 'fixture-session' };
} });
`);
    const source = `
${ownedProcessMarkerScript(moduleUrl('infra/task/process.js'))}
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureManagerRun } from ${JSON.stringify(moduleUrl('features/manager/autoRun.js'))};
const cwd = process.cwd();
writeProcessMarker(join(cwd, 'ready-' + process.pid));
const deadline = Date.now() + 20000;
while (!existsSync(join(cwd, 'release-turns'))) {
  if (Date.now() > deadline) throw new Error('Test did not release automatic run owners');
  await new Promise(resolve => setTimeout(resolve, 20));
}
await ensureManagerRun(cwd);
`;
    const done = Array.from({ length: 2 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
        cwd, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, TAKT_CONFIG_DIR: configDirectory, TAKT_TEST_AUTO_RUN_ROOT: cwd },
      });
      const owned = captureOwnedChild(child);
      void owned.catch(() => {});
      children.push({ child, owned });
      let errors = '';
      child.stderr!.on('data', (chunk) => { errors += String(chunk); });
      const exit = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errors || `Parent exit: ${code}`)));
      });
      void exit.catch(() => {});
      return exit;
    });
    await Promise.race([
      vi.waitFor(() => expect(readdirSync(cwd).filter((file) => file.startsWith('ready-'))).toHaveLength(2), { timeout: 15000 }),
      Promise.all(done).then(() => { throw new Error('Conversation parents exited before entering their turns'); }),
    ]);
    writeFileSync(join(cwd, 'release-turns'), 'release both turns');
    await Promise.all(done);
    await vi.waitFor(() => expect(readdirSync(cwd).filter((file) => file.startsWith('run-started-'))).toHaveLength(2), { timeout: 15000 });
    const launches = readdirSync(cwd).filter((file) => file.startsWith('launch-'));
    expect(launches).toHaveLength(2);
    for (const file of launches) expect(JSON.parse(readFileSync(join(cwd, file), 'utf8'))).toEqual([expect.stringMatching(/dist\/app\/cli\/index\.js$/), 'run']);
    writeFileSync(join(cwd, 'release-runs'), 'compete for execution lock');
    await vi.waitFor(() => expect(readdirSync(cwd).filter((file) => file.startsWith('worker-entered-'))).toHaveLength(1), { timeout: 15000 });
    const workerMarker = readdirSync(cwd).find((file) => file.startsWith('worker-entered-'))!;
    worker = readOwnedProcessMarker(readFileSync(join(cwd, workerMarker), 'utf8'));
    const runs = readdirSync(cwd).filter((file) => file.startsWith('run-started-')).map((file) => readOwnedProcessMarker(readFileSync(join(cwd, file), 'utf8')));
    const loser = runs.find(({ pid }) => pid !== worker!.pid)!;
    await vi.waitFor(() => expect(isProcessAlive(loser.pid)).toBe(false), { timeout: 15000 });
    expect(children.every(({ child }) => child.exitCode === 0)).toBe(true);
    expect(isProcessAlive(worker.pid)).toBe(true);
    writeFileSync(join(cwd, 'release-worker'), 'continue after both parents exit');
    await vi.waitFor(() => expect(new TaskRunner(cwd).listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: ordinary.name, kind: 'pending' }, { name: task.name, kind: 'completed' },
    ]), { timeout: 15000 });
    await vi.waitFor(() => expect(isProcessAlive(worker!.pid)).toBe(false), { timeout: 15000 });
    expect(readdirSync(cwd).filter((file) => file.startsWith('worker-entered-'))).toHaveLength(1);
    const completedGoalTask = runner.listTaskStateItems().find(({ name }) => name === task.name)!;
    const savedEvents = readManagerEvents(cwd);
    expect(savedEvents.map(({ event }) => event)).toEqual([
      { kind: 'registered', goalId: goal.id, createdAt: expect.any(String) },
      { kind: 'completion', goalId: goal.id, taskName: task.name, runSlug: completedGoalTask.runSlug,
        result: completedGoalTask.completion, createdAt: expect.any(String) },
    ]);
    expect((await new GoalStore(cwd).get(goal.id)).workLog).toEqual([]);
    const direct = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'run'], {
      cwd, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, TAKT_CONFIG_DIR: configDirectory, TAKT_TEST_AUTO_RUN_ROOT: cwd },
    });
    const owned = captureOwnedChild(direct);
    void owned.catch(() => {});
    children.push({ child: direct, owned });
    let directErrors = '';
    direct.stderr!.on('data', (chunk) => { directErrors += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      direct.once('error', reject);
      direct.once('exit', (code) => code === 0 ? resolve() : reject(new Error(directErrors || `Direct run exit: ${code}`)));
    });
    expect(runner.listAllTaskItems().map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: ordinary.name, kind: 'completed' }, { name: task.name, kind: 'completed' },
    ]);
    expect(readdirSync(cwd).filter((file) => file.startsWith('worker-entered-'))).toHaveLength(2);
    const watched = runner.addTask('ordinary task for watch', { workflow: 'auto-run', worktree: false });
    const watch = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'watch'], {
      cwd, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, TAKT_CONFIG_DIR: configDirectory, TAKT_TEST_AUTO_RUN_ROOT: cwd },
    });
    const watchOwned = captureOwnedChild(watch);
    void watchOwned.catch(() => {});
    children.push({ child: watch, owned: watchOwned });
    let watchErrors = '';
    watch.stderr!.on('data', (chunk) => { watchErrors += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      watch.once('error', reject);
      watch.once('exit', (code) => code === 0 ? resolve() : reject(new Error(watchErrors || `Watch exit: ${code}`)));
    });
    expect(runner.listAllTaskItems().find(({ name }) => name === watched.name)?.kind).toBe('completed');
    expect((await new GoalStore(cwd).get(goal.id)).notifications?.filter(({ kind }) => kind === 'blocked') ?? []).toEqual([]);
    expect(readManagerEvents(cwd)).toEqual(savedEvents);
    expect((await new GoalStore(cwd).get(goal.id)).workLog).toEqual([]);
    rmSync(join(cwd, '.takt', 'goals', 'invalid-entry'), { recursive: true });
    await registerProject({ globalConfigDirectory: configDirectory, projectDirectory: cwd, command: 'manager', managerUsed: true });
    const daemon = spawn(process.execPath, [join(process.cwd(), 'dist/app/cli/index.js'), 'daemon'], {
      cwd, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, TAKT_CONFIG_DIR: configDirectory, TAKT_TEST_AUTO_RUN_ROOT: cwd },
    });
    const daemonOwned = captureOwnedChild(daemon);
    void daemonOwned.catch(() => {});
    children.push({ child: daemon, owned: daemonOwned });
    let daemonErrors = '';
    daemon.stderr!.on('data', (chunk) => { daemonErrors += String(chunk); });
    await vi.waitFor(() => expect(readManagerEvents(cwd), daemonErrors).toEqual([]), { timeout: 15000 });
    expect((await new GoalStore(cwd).get(goal.id)).workLog.filter(({ summary }) => summary === 'ready work saved')).toHaveLength(2);
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      writeFileSync(join(cwd, 'release-turns'), 'cleanup');
      writeFileSync(join(cwd, 'release-worker'), 'cleanup');
      writeFileSync(join(cwd, 'release-runs'), 'cleanup');
      const runs = readdirSync(cwd).filter((file) => file.startsWith('run-started-')).map((file) => readOwnedProcessMarker(readFileSync(join(cwd, file), 'utf8')));
      const ended = await Promise.allSettled([
        ...children.map(async ({ child, owned }) => {
          const captured = await owned;
          if (captured !== undefined) await terminateOwnedProcess(captured, () => child.exitCode !== null || child.signalCode !== null);
        }),
        ...runs.map((owned) => terminateOwnedProcess(owned, () => false)),
      ]);
      const cleanupErrors = ended.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      errors.push(...cleanupErrors);
      if (cleanupErrors.length === 0) rmSync(cwd, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `Test or cleanup failed; fixture: ${cwd}`);
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
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, [MANAGER_GOAL_TASKS_ENV]: '1' },
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
        env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, [MANAGER_GOAL_TASKS_ENV]: '1' },
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
