import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../infra/task/runner.js';
import { loadTaskHistory } from '../app/cli/taskHistory.js';
import { getTaskProcessIdentity } from '../infra/task/taskProcessIdentity.js';
import { TaskRecordSchema, type TaskRecord } from '../infra/task/schema.js';
import { toTaskListItem, toTaskState } from '../infra/task/mapper.js';
import { serializeTaskListItemForJson } from '../infra/task/listSerializer.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'takt-task-owner-identity-'));
  directories.push(directory);
  const runner = new TaskRunner(directory);
  runner.addTask('interrupted owner', { worktree: false });
  runner.claimNextTasks(1);
  const file = runner.getTasksFilePath();
  return { directory, runner, file };
}
function readTask(file: string): TaskRecord {
  const data = parse(readFileSync(file, 'utf8')) as { tasks: unknown[] };
  return TaskRecordSchema.parse(data.tasks[0]);
}
async function withLiveChild(run: (pid: number, stop: () => Promise<void>) => Promise<void>) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', shell: false });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  try { await run(child.pid!, stop); } finally { await stop(); }
}

describe('ordinary task owner identity persistence and recovery', () => {
  it('persists the claimed owner and exposes it in task state/list JSON', () => {
    const { directory, file } = setup();
    const task = readTask(file);
    const expected = getTaskProcessIdentity(process.pid)?.startTime ?? null;
    expect(task.owner_start_time).toBe(expected);
    expect(toTaskState(file, task).ownerStartTime).toBe(expected ?? undefined);
    expect(serializeTaskListItemForJson(toTaskListItem(directory, file, task)).ownerStartTime).toBe(expected ?? undefined);
  });

  it('recovers a known birth mismatch while preserving an unknown live owner', async () => {
    await withLiveChild(async (pid) => {
      const { directory, runner, file } = setup();
      const identity = getTaskProcessIdentity(pid);
      if (process.platform === 'linux' || process.platform === 'darwin') {
        expect(identity).toBeDefined();
      }
      const task = { ...readTask(file), owner_pid: pid, owner_start_time: 'Thu Jan  1 00:00:00 1970' };
      writeFileSync(file, stringify({ tasks: [task] }));
      if (identity === undefined) {
        expect(loadTaskHistory(directory, 'en')).toEqual([]);
        expect(runner.failInterruptedRunningTasks()).toBe(0);
        expect(readTask(file).status).toBe('running');
      } else {
        expect(identity.startTime).not.toBe(task.owner_start_time);
        expect(loadTaskHistory(directory, 'en')).toMatchObject([{ status: 'interrupted' }]);
        expect(runner.failInterruptedRunningTasks()).toBe(1);
        expect(readTask(file)).toMatchObject({ status: 'failed', owner_pid: null, owner_start_time: null });
      }
    });
  });

  it('preserves a live legacy owner and recovers it once its process exits', async () => {
    await withLiveChild(async (pid, stop) => {
      const { directory, runner, file } = setup();
      const task = { ...readTask(file), owner_pid: pid };
      delete task.owner_start_time;
      writeFileSync(file, stringify({ tasks: [task] }));
      expect(loadTaskHistory(directory, 'en')).toEqual([]);
      expect(runner.failInterruptedRunningTasks()).toBe(0);
      await stop();
      expect(runner.failInterruptedRunningTasks()).toBe(1);
      expect(readTask(file)).toMatchObject({ status: 'failed', owner_pid: null, owner_start_time: null });
    });
  });

  it('preserves a matching live owner after inspector locale and timezone changes', async () => {
    await withLiveChild(async (pid) => {
      const { directory, runner, file } = setup();
      const identity = getTaskProcessIdentity(pid);
      if (process.platform === 'linux' || process.platform === 'darwin') {
        expect(identity).toBeDefined();
      }
      const task = { ...readTask(file), owner_pid: pid, owner_start_time: identity?.startTime ?? null };
      writeFileSync(file, stringify({ tasks: [task] }));
      vi.stubEnv('LC_ALL', 'ja_JP.UTF-8');
      vi.stubEnv('LANG', 'ja_JP.UTF-8');
      vi.stubEnv('TZ', 'Pacific/Auckland');
      expect(getTaskProcessIdentity(pid)).toEqual(identity);
      expect(loadTaskHistory(directory, 'en')).toEqual([]);
      expect(runner.failInterruptedRunningTasks()).toBe(0);
      expect(readTask(file).status).toBe('running');
    });
  });
});
