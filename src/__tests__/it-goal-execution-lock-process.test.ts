import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { GoalStore } from '../infra/goals/store.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskStore } from '../infra/task/store.js';
import { TaskLifecycleService } from '../infra/task/taskLifecycleService.js';
import { transitionGoalExecution } from '../infra/goals/state.js';
import { goalRecord } from './helpers/goal-fixtures.js';
import { captureOwnedChild, terminateOwnedProcess, type OwnedProcess } from './helpers/owned-process.js';

it.each(['claim', 'spawn'] as const)('serializes pause publication with %s in both orders across processes', async (operation) => {
  for (let trial = 0; trial < 2; trial++) {
    for (const pauseFirst of [false, true]) {
      const root = join(process.cwd(), '.tmp');
      mkdirSync(root, { recursive: true });
      const cwd = mkdtempSync(join(root, 'goal-execution-race-'));
      const children: Array<{ child: ChildProcess; owned: Promise<OwnedProcess | undefined> }> = [];
      const sourceUrl = (path: string) => pathToFileURL(join(process.cwd(), 'src', path)).href;
      try {
        const goal = await new GoalStore(cwd).create(goalRecord());
        const runner = new TaskRunner(cwd);
        const task = runner.addTask('controlled goal work', { goal_id: goal.id, worktree: false });
        writeFileSync(join(cwd, '.takt', 'config.yaml'), 'provider: mock\nmanager:\n  auto_run: true\n');
        const common = `
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
const cwd = process.cwd();
const mark = name => fs.writeFileSync(join(cwd, name), 'ready');
const record = name => fs.appendFileSync(join(cwd, 'events'), name + '\\n');
function wait(name) {
  const deadline = Date.now() + 15000;
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(join(cwd, name))) {
    if (Date.now() >= deadline) throw new Error('Test did not release ' + name);
    Atomics.wait(buffer, 0, 0, 10);
  }
}
`;
        const start = (source: string): Promise<void> => {
          const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx/esm'), '--input-type=module', '--eval', common + source], {
            cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, NODE_OPTIONS: undefined },
          });
          const owned = captureOwnedChild(child);
          void owned.catch(() => {});
          children.push({ child, owned });
          let stderr = '';
          child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
          const done = new Promise<void>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `Child exit: ${code}`)));
          });
          void done.catch(() => {});
          return done;
        };
        const pauser = `
const lstat = fs.lstatSync;
fs.lstatSync = function(path, ...args) {
  const stat = lstat.call(this, path, ...args);
  if (String(path).endsWith('/goal-execution.lock') && stat !== undefined) mark('pause-contended');
  return stat;
};
syncBuiltinESMExports();
const { setGoalExecutionStatus } = await import(${JSON.stringify(sourceUrl('infra/goals/execution.ts'))});
await setGoalExecutionStatus(cwd, ${JSON.stringify(goal.id)}, 'paused', new AbortController().signal);
record('pause-saved');
mark('pause-saved');
`;
        const executor = `
const { GoalStore } = await import(${JSON.stringify(sourceUrl('infra/goals/store.ts'))});
const { TaskStore } = await import(${JSON.stringify(sourceUrl('infra/task/store.ts'))});
const { TaskRunner } = await import(${JSON.stringify(sourceUrl('infra/task/runner.ts'))});
const get = GoalStore.prototype.getSync;
GoalStore.prototype.getSync = function(id) {
  const goal = get.call(this, id);
  record('read-' + goal.executionStatus);
  ${operation === 'claim' && !pauseFirst ? "mark('execute-held'); wait('release-execute');" : ''}
  return goal;
};
${operation === 'claim' ? `
const update = TaskStore.prototype.update;
TaskStore.prototype.update = function(action) {
  const saved = update.call(this, action);
  record('task-saved');
  return saved;
};
const runner = new TaskRunner(cwd);
const claimed = runner.claimNextTasks(1);
fs.writeFileSync(join(cwd, 'claimed'), JSON.stringify(claimed.map(task => task.name)));
for (const task of claimed) {
  record('worker-called');
  runner.completeTask({ task, success: true, response: 'done', executionLog: [], startedAt: task.createdAt, completedAt: new Date().toISOString() });
}
` : `
childProcess.spawn = () => {
  ${!pauseFirst ? "mark('execute-held'); wait('release-execute');" : ''}
  record('spawn');
  const child = Object.assign(new EventEmitter(), { unref() {} });
  const deadline = Date.now() + 15000;
  const reportSpawn = () => {
    if (fs.existsSync(join(cwd, 'pause-saved'))) {
      record('spawn-event');
      child.emit('spawn');
    } else if (Date.now() >= deadline) child.emit('error', new Error('Pause did not complete before spawn event'));
    else setTimeout(reportSpawn, 10);
  };
  setImmediate(reportSpawn);
  return child;
};
syncBuiltinESMExports();
const { ensureManagerRun } = await import(${JSON.stringify(sourceUrl('features/manager/autoRun.ts'))});
await ensureManagerRun(cwd);
`}
`;
        if (pauseFirst) {
          await start(pauser);
          await start(executor);
        } else {
          const execution = start(executor);
          await vi.waitFor(() => expect(existsSync(join(cwd, 'execute-held'))).toBe(true), { timeout: 10000 });
          const pause = start(pauser);
          await vi.waitFor(() => expect(existsSync(join(cwd, 'pause-contended')) || existsSync(join(cwd, 'pause-saved'))).toBe(true), { timeout: 10000 });
          writeFileSync(join(cwd, 'release-execute'), 'release');
          await Promise.all([execution, pause]);
        }
        const events = readFileSync(join(cwd, 'events'), 'utf8').trim().split('\n');
        console.info(JSON.stringify({ operation, trial, pauseFirst, events }));
        expect((await new GoalStore(cwd).get(goal.id)).executionStatus).toBe('paused');
        if (operation === 'claim') {
          expect(JSON.parse(readFileSync(join(cwd, 'claimed'), 'utf8'))).toEqual(pauseFirst ? [] : [task.name]);
          expect(runner.listTaskStateItems()[0]!.status).toBe(pauseFirst ? 'pending' : 'completed');
          expect(events.filter((event) => event === 'worker-called')).toHaveLength(pauseFirst ? 0 : 1);
          if (!pauseFirst) expect.soft(events.indexOf('task-saved')).toBeLessThan(events.indexOf('pause-saved'));
        } else {
          expect(events.filter((event) => event === 'spawn')).toHaveLength(pauseFirst ? 0 : 1);
          if (!pauseFirst) expect.soft(events.indexOf('spawn')).toBeLessThan(events.indexOf('pause-saved'));
          if (!pauseFirst) expect(events.indexOf('pause-saved')).toBeLessThan(events.indexOf('spawn-event'));
        }
      } finally {
        writeFileSync(join(cwd, 'release-execute'), 'cleanup');
        await Promise.all(children.map(async ({ child, owned }) => {
          const captured = await owned;
          if (captured !== undefined) await terminateOwnedProcess(captured, () => child.exitCode !== null || child.signalCode !== null);
        }));
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  }
});

it('releases the execution lock after failed claim publication and goal transformation', async () => {
  const root = join(process.cwd(), '.tmp');
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, 'goal-execution-failure-'));
  try {
    const goals = new GoalStore(cwd);
    const goal = await goals.create(goalRecord());
    const runner = new TaskRunner(cwd);
    const task = runner.addTask('claim publication failure', { goal_id: goal.id });
    const tasks = new TaskStore(cwd);
    const update = tasks.update;
    vi.spyOn(tasks, 'update').mockImplementationOnce((action) => update.call(tasks, (current) => {
      action(current);
      throw new Error('injected publication failure');
    }));
    const lifecycle = new TaskLifecycleService(cwd, tasks.getTasksFilePath(), tasks);
    expect(() => lifecycle.claimNextTasks(1)).toThrow();
    expect(runner.listTaskStateItems()[0]!.status).toBe('pending');
    await expect(goals.update(goal.id, () => { throw new Error('injected transform failure'); })).rejects.toThrow();
    await goals.update(goal.id, (saved) => transitionGoalExecution(saved, 'paused'));
    expect(lifecycle.claimNextTasks(1)).toEqual([]);
    await goals.update(goal.id, (saved) => transitionGoalExecution(saved, 'active'));
    expect(lifecycle.claimNextTasks(1).map(({ name }) => name)).toEqual([task.name]);
    expect(runner.listTaskStateItems()[0]!.status).toBe('running');
  } finally {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  }
});
