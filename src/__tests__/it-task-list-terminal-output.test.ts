import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { TaskListItem } from '../infra/task/types.js';
import { setupRawStdin, restoreStdin } from './helpers/stdinSimulator.js';

const { deleteBranch, getCurrentBranch, stageAndCommit, publishTaskBranch, collectSummary } = vi.hoisted(() => ({
  deleteBranch: vi.fn(() => true),
  getCurrentBranch: vi.fn(() => 'takt/branch'),
  stageAndCommit: vi.fn(),
  publishTaskBranch: vi.fn(),
  collectSummary: vi.fn(() => ({ files: [], text: '' })),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentBranch,
  stageAndCommit,
  publishTaskBranch,
  detectDefaultBranch: () => 'main',
  resolveAutoCommitOptions: () => ({ allowGitHooks: false, allowGitFilters: false }),
}));
vi.mock('../features/tasks/list/taskBranchLifecycleActions.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteBranch,
}));
vi.mock('../features/tasks/list/taskDiffActions.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showDiffAndPromptActionForTask: vi.fn(async () => null),
}));
vi.mock('../features/tasks/list/taskWorktreeSummary.js', () => ({ collectTaskWorktreeSummary: collectSummary }));
vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => ({}),
  createPullRequestSafely: () => ({ success: true, url: 'https://example.test/pr/1' }),
}));

import { TaskRunner } from '../infra/task/index.js';
import { listTasks } from '../features/tasks/list/index.js';
import { deleteAllTasks, deleteTaskByKind } from '../features/tasks/list/taskDeleteActions.js';
import { forceFailRunningTask } from '../features/tasks/list/taskForceFailActions.js';
import { createPullRequestForTask } from '../features/tasks/list/taskPullRequestActions.js';
import { syncBranchWithRoot } from '../features/tasks/list/taskSyncAction.js';
import { pullFromRemote } from '../features/tasks/list/taskPullAction.js';

const names = [
  ['alpha', 'alpha'],
  ['\u001b[2Jalpha\r\nforged\u0007\u009b0m', 'alpha\\r\\nforged\\x07\\x9b0m'],
] as const;
const kinds = ['pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed'] as const;
const deletableKinds = ['pending', 'completed', 'failed', 'exceeded', 'pr_failed'] as const;
const date = '2026-02-09T00:00:00.000Z';
let projectDir: string;
let consoleLog: MockInstance<typeof console.log>;
let consoleError: MockInstance<typeof console.error>;
let stdoutDescriptor: PropertyDescriptor | undefined;
let stdinDescriptor: PropertyDescriptor | undefined;
let stdinRawDescriptor: PropertyDescriptor | undefined;
let setRawModeDescriptor: PropertyDescriptor | undefined;
let columnsDescriptor: PropertyDescriptor | undefined;

function writeTasks(kind: TaskListItem['kind'], taskNames: readonly string[], branch?: string): TaskListItem[] {
  mkdirSync(join(projectDir, '.takt'), { recursive: true });
  writeFileSync(join(projectDir, '.takt', 'tasks.yaml'), stringify({
    tasks: taskNames.map((name) => ({
      name, status: kind, content: 'instruction', summary: 'summary', branch,
      created_at: date,
      started_at: kind === 'pending' ? null : date,
      completed_at: kind === 'pending' || kind === 'running' ? null : date,
      ...(kind === 'failed' ? { failure: { error: 'failure' } } : {}),
      ...(kind === 'running' ? { owner_pid: process.pid } : {}),
    })),
  }));
  return new TaskRunner(projectDir).listAllTaskItems();
}

function startInput(inputs: string[]): void {
  setupRawStdin(inputs);
}

function output(): string {
  return [
    ...consoleLog.mock.calls.flat().map(String),
    ...consoleError.mock.calls.flat().map(String),
    ...vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)),
  ].join('\n');
}

function expectSafeName(text: string, displayName: string): void {
  expect(text).toContain(displayName);
  expect(text).not.toContain('\u001b[2J');
  expect(text).not.toContain('\r\nforged');
  expect(text).not.toContain('\u0007');
  expect(text).not.toContain('\u009b');
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteBranch.mockReturnValue(true);
  projectDir = mkdtempSync(join(tmpdir(), 'takt-list-output-'));
  stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  stdinRawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isRaw');
  setRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  vi.stubEnv('TAKT_NO_TTY', '');
  vi.stubEnv('TAKT_TEST_FLG_TOUCH_TTY', '1');
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  startInput([]);
});

afterEach(() => {
  restoreStdin();
  for (const [stream, key, descriptor] of [
    [process.stdout, 'isTTY', stdoutDescriptor],
    [process.stdin, 'isTTY', stdinDescriptor],
    [process.stdin, 'isRaw', stdinRawDescriptor],
    [process.stdin, 'setRawMode', setRawModeDescriptor],
    [process.stdout, 'columns', columnsDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(stream, key, descriptor);
    else Reflect.deleteProperty(stream, key);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(projectDir, { recursive: true, force: true });
});

describe.each(names)('saved task name %j', (name, displayName) => {
  it.each(kinds)('prints the %s text list safely and keeps the JSON name', async (kind) => {
    writeTasks(kind, [name], 'takt/branch');
    await listTasks(projectDir, undefined, { enabled: true, format: 'text' });
    expectSafeName(output(), displayName);
    expect(output()).toContain('takt/branch');
    consoleLog.mockClear();
    await listTasks(projectDir, undefined, { enabled: true, format: 'json' });
    const payload = JSON.parse(String(consoleLog.mock.calls[0]?.[0])) as { tasks: Array<{ name: string }> };
    expect(payload.tasks[0]?.name).toBe(name);
  });

  it.each(kinds)('prints %s menu redraws, confirmation, details and action prompts safely', async (kind) => {
    writeTasks(kind, [name, 'other'], 'takt/branch');
    restoreStdin();
    startInput(['\u001b[B\u001b[A\r', ...(kind === 'completed' || kind === 'pr_failed' ? [] : ['\u001b']), '\u001b']);
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    await listTasks(projectDir);
    const frames = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk));
    expect(frames.filter((frame) => frame.includes(displayName)).length).toBeGreaterThanOrEqual(3);
    const lines = consoleLog.mock.calls.flat().map(String);
    expect(lines.some((line) => line.includes('✓') && line.includes(displayName))).toBe(true);
    expect(lines.some((line) => line.includes(`[${kind === 'pr_failed' ? 'pr-failed' : kind}] ${displayName}`))).toBe(true);
    if (kind !== 'completed' && kind !== 'pr_failed') {
      expect(lines.some((line) => line.includes(`Action for ${displayName}:`))).toBe(true);
    }
    expectSafeName(output(), displayName);
  });

  it.each(['completed', 'pr_failed'] as const)('prints missing branch for %s safely', async (kind) => {
    writeTasks(kind, [name]);
    restoreStdin();
    startInput(['\r', '\u001b']);
    await listTasks(projectDir);
    const notification = consoleLog.mock.calls.flat().map(String).find((line) => line.includes('Branch is missing'))!;
    expectSafeName(notification, displayName);
  });

  it.each(deletableKinds)('confirms and deletes the original %s name safely', async (kind) => {
    const task = writeTasks(kind, [name])[0]!;
    restoreStdin();
    startInput(['y\n']);
    expect(await deleteTaskByKind(task)).toBe(true);
    expect(new TaskRunner(projectDir).listAllTaskItems()).toEqual([]);
    expectSafeName(output(), displayName);
    expectSafeName(consoleLog.mock.calls.flat().map(String).find((line) => line.includes(`Deleted ${kind} task:`))!, displayName);
    expect(vi.mocked(process.stdout.write).mock.calls.some(([chunk]) => String(chunk).includes(displayName))).toBe(true);
  });

  it.each(['single', 'all'] as const)('prints a missing-task exception safely during %s deletion', async (mode) => {
    const task = writeTasks('pending', [name])[0]!;
    new TaskRunner(projectDir).deleteTask(name, 'pending');
    restoreStdin();
    startInput(['y\n']);
    expect(await (mode === 'single' ? deleteTaskByKind(task) : deleteAllTasks([task]))).toBe(false);
    const error = consoleLog.mock.calls.flat().map(String).find((line) => line.includes('Failed to delete'))!;
    expectSafeName(error, displayName);
    expect(error.split(displayName)).toHaveLength(3);
  });

  it('prints bulk cleanup failure safely and preserves the saved target', async () => {
    const task = writeTasks('completed', [name], 'takt/branch')[0]!;
    deleteBranch.mockReturnValue(false);
    restoreStdin();
    startInput(['y\n']);
    expect(await deleteAllTasks([task])).toBe(false);
    expect(deleteBranch).toHaveBeenCalledWith(projectDir, task);
    expect(new TaskRunner(projectDir).listAllTaskItems()[0]?.name).toBe(name);
    expectSafeName(consoleLog.mock.calls.flat().map(String).find((line) => line.includes('Failed to cleanup'))!, displayName);
  });

  it.each([undefined, process.pid])('confirms force-fail for owner %s and saves the original name', async (ownerPid) => {
    const task = { ...writeTasks('running', [name])[0]!, ownerPid };
    restoreStdin();
    startInput(['y\n']);
    expect(await forceFailRunningTask(task, projectDir)).toBe(true);
    expect(new TaskRunner(projectDir).listAllTaskItems()[0]).toMatchObject({ name, kind: 'failed' });
    expectSafeName(output(), displayName);
    expectSafeName(consoleLog.mock.calls.flat().map(String).find((line) => line.includes('Marked running task as failed:'))!, displayName);
    expect(vi.mocked(process.stdout.write).mock.calls.some(([chunk]) => String(chunk).includes(displayName))).toBe(true);
    expect(output()).toContain(ownerPid === undefined ? `Mark running task "${displayName}" as failed?`
      : `Process ${ownerPid} may still be running. Mark "${displayName}" as failed anyway?`);
  });

  it('prints a force-fail exception safely', async () => {
    const task = writeTasks('running', [name])[0]!;
    new TaskRunner(projectDir).forceFailRunningTask(name, { error: 'already failed' });
    restoreStdin();
    startInput(['y\n']);
    expect(await forceFailRunningTask(task, projectDir)).toBe(false);
    expectSafeName(consoleLog.mock.calls.flat().map(String).find((line) => line.includes('Failed to mark'))!, displayName);
  });

  it('prints missing PR branch safely without starting Git', async () => {
    expect(await createPullRequestForTask(projectDir, writeTasks('failed', [name])[0]!)).toBe(false);
    expectSafeName(output(), displayName);
    expect(stageAndCommit).not.toHaveBeenCalled();
  });

  it('prints PR confirmation safely and sends the original name to Git', async () => {
    const task = { ...writeTasks('failed', [name], 'takt/branch')[0]!, worktreePath: projectDir };
    restoreStdin();
    startInput(['y\n']);
    expect(await createPullRequestForTask(projectDir, task)).toBe(true);
    const prompt = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).find((chunk) => chunk.includes('PR を作成しますか'))!;
    expectSafeName(prompt, displayName);
    expect(stageAndCommit).toHaveBeenCalledWith(projectDir, `takt: ${name}`, expect.any(Object));
  });

  it.each(['pr', 'sync', 'pull'] as const)('prints missing worktree safely for %s and stops processing', async (action) => {
    const task = writeTasks('failed', [name], 'takt/branch')[0]!;
    for (const worktreePath of [undefined, join(projectDir, 'missing')]) {
      consoleLog.mockClear();
      const target = { ...task, worktreePath };
      const result = action === 'pr' ? await createPullRequestForTask(projectDir, target)
        : action === 'sync' ? await syncBranchWithRoot(projectDir, target)
          : pullFromRemote(projectDir, target);
      expect(result).toBe(false);
      expectSafeName(output(), displayName);
      expect(stageAndCommit).not.toHaveBeenCalled();
      expect(getCurrentBranch).not.toHaveBeenCalled();
      expect(publishTaskBranch).not.toHaveBeenCalled();
    }
  });
});

it.each([0, 1])('deletes only index %s when two original names have the same display', async (index) => {
  const originalNames = ['alpha', '\u001b[2Jalpha'];
  writeTasks('pending', originalNames);
  restoreStdin();
  startInput([`${index === 1 ? '\u001b[B' : ''}\r`, '\r', 'y\n', '\u001b']);
  await listTasks(projectDir);
  expect(new TaskRunner(projectDir).listAllTaskItems().map((task) => task.name)).toEqual([originalNames[1 - index]]);
  expectSafeName(output(), 'alpha');
});

it('keeps the untruncated selected name safe on a narrow terminal', async () => {
  writeTasks('pending', [names[1][0]]);
  restoreStdin();
  startInput(['\r', '\u001b', '\u001b']);
  Object.defineProperty(process.stdout, 'columns', { value: 18, configurable: true });
  await listTasks(projectDir);
  const confirmed = consoleLog.mock.calls.flat().map(String).find((line) => line.includes('✓'))!;
  expectSafeName(confirmed, names[1][1]);
});
