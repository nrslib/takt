import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { makeSessionContext } from './test-helpers.js';

const { mockConfirmWithCancel, mockSelectOption, mockSelectOptionWithDefault, mockCallAIWithRetry } = vi.hoisted(() => ({
  mockConfirmWithCancel: vi.fn(),
  mockSelectOption: vi.fn(),
  mockSelectOptionWithDefault: vi.fn(),
  mockCallAIWithRetry: vi.fn(),
}));

vi.mock('../features/interactive/aiCaller.js', () => ({ callAIWithRetry: mockCallAIWithRetry }));

vi.mock('../infra/task/taskProcessIdentity.js', () => ({
  getSelfTaskProcessIdentity: () => undefined,
  getTaskProcessIdentity: () => undefined,
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  selectOption: (...args: unknown[]) => mockSelectOption(...args),
  confirm: vi.fn().mockResolvedValue(false),
  confirmWithCancel: (...args: unknown[]) => mockConfirmWithCancel(...args),
  selectOptionWithDefault: (...args: unknown[]) => mockSelectOptionWithDefault(...args),
}));

import { runTellCommand } from '../features/interactive/tellCommand.js';
import { listTaktTasks } from '../features/mcp/operations.js';
import { listTasks } from '../features/tasks/list/index.js';
import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';
import { TaskRunner } from '../infra/task/index.js';
import { saveGlobalConfig } from '../infra/config/index.js';
import type { TaskRecord } from '../infra/task/schema.js';
import {
  issueTellableRunningTask,
  listTellableRunningTasks,
} from '../features/tasks/liveIntervention.js';

function writeRunMeta(cloneCwd: string, runSlug: string, task: string): void {
  const runDir = join(cloneCwd, '.takt', 'runs', runSlug);
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  mkdirSync(join(runDir, 'reports'), { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    task,
    workflow: 'default',
    runSlug,
    runRoot: `.takt/runs/${runSlug}`,
    reportDirectory: `.takt/runs/${runSlug}/reports`,
    contextDirectory: `.takt/runs/${runSlug}/context`,
    logsDirectory: `.takt/runs/${runSlug}/logs`,
    status: 'running',
    startTime: '2026-09-09T00:00:00.000Z',
    currentStep: 'implement',
  }), 'utf8');
}

function writeRunningTask(
  name: string,
  runSlug: string,
  worktreePath: string,
  summary: string,
): Record<string, unknown> {
  return {
    name,
    status: 'running',
    content: summary,
    summary,
    workflow: 'default',
    worktree: true,
    auto_pr: false,
    created_at: '2026-09-09T00:00:00.000Z',
    started_at: '2026-09-09T00:00:00.000Z',
    completed_at: null,
    run_slug: runSlug,
    worktree_path: worktreePath,
  };
}

describe('tell command and live intervention file store', () => {
  let projectCwd: string;
  let savedStdinIsTTY: boolean | undefined;
  let savedStdoutIsTTY: boolean | undefined;
  let savedNoTty: string | undefined;
  let savedTouchTty: string | undefined;
  const externalDirectories: string[] = [];

  function createMergeRun(cloneCwd: string, runSlug: string) {
    mkdirSync(cloneCwd, { recursive: true });
    const runner = new TaskRunner(projectCwd);
    const task = runner.startPrMergeTask({
      prNumber: 1805,
      headBranch: 'feature/tell-merge',
      baseBranch: 'main',
      headSha: 'a'.repeat(40),
      headRepositoryUrl: 'https://example.com/owner/takt.git',
      headRepositoryPushUrls: ['https://example.com/owner/takt.git'],
      workflow: 'default',
      method: 'squash',
      worktreePath: cloneCwd,
      threatCheckMaxDiffBytes: 100_000,
    });
    runner.recordPrMergeClonePrepared(task.name);
    runner.updateRunningTaskExecution(task.name, { runSlug });
    writeRunMeta(projectCwd, runSlug, task.name);
    return { runner, task, metaPath: join(projectCwd, '.takt', 'runs', runSlug, 'meta.json') };
  }

  function updateTask(updates: Partial<TaskRecord>): void {
    const tasksPath = join(projectCwd, '.takt', 'tasks.yaml');
    const saved = parseYaml(readFileSync(tasksPath, 'utf8')) as { tasks: TaskRecord[] };
    writeFileSync(tasksPath, stringifyYaml({
      tasks: saved.tasks.map((task) => ({ ...task, ...updates })),
    }), 'utf8');
  }

  function updateMeta(metaPath: string, updates: Record<string, unknown>): void {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(metaPath, JSON.stringify({ ...meta, ...updates }), 'utf8');
  }

  beforeEach(() => {
    savedStdinIsTTY = process.stdin.isTTY;
    savedStdoutIsTTY = process.stdout.isTTY;
    savedNoTty = process.env.TAKT_NO_TTY;
    savedTouchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.TAKT_NO_TTY = '0';
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    projectCwd = mkdtempSync(join(tmpdir(), 'takt-tell-file-store-'));
    saveGlobalConfig({ language: 'en', autoFetch: false });
    mockSelectOption.mockReset().mockImplementation(() => {
      throw new Error('Unexpected selectOption call');
    });
    mockConfirmWithCancel.mockReset();
    mockSelectOptionWithDefault.mockReset();
    mockConfirmWithCancel.mockResolvedValue({ kind: 'value', value: true });
    mockSelectOptionWithDefault.mockResolvedValue('run-b');
    mockCallAIWithRetry.mockReset().mockResolvedValue({
      result: { success: true, content: 'Add an audit log for Task B.' },
    });
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
    for (const directory of externalDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
    Object.defineProperty(process.stdin, 'isTTY', { value: savedStdinIsTTY, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: savedStdoutIsTTY, configurable: true });
    if (savedNoTty === undefined) {
      delete process.env.TAKT_NO_TTY;
    } else {
      process.env.TAKT_NO_TTY = savedNoTty;
    }
    if (savedTouchTty === undefined) {
      delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    } else {
      process.env.TAKT_TEST_FLG_TOUCH_TTY = savedTouchTty;
    }
  });

  it.each([
    { source: 'content', summary: undefined },
    { source: 'content_file', summary: undefined },
    { source: 'content', summary: '運用用要約' },
    { source: 'content_file', summary: '運用用要約' },
  ] as const)('preserves list, MCP and tell descriptions across $source migration with summary=$summary', async ({ source, summary }) => {
    const content = '元の作業\n詳細';
    const expectedSummary = summary ?? '元の作業';
    const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'description');
    const runSlug = 'description-run';
    const taskName = 'description-task';
    mkdirSync(cloneCwd, { recursive: true });
    writeRunMeta(cloneCwd, runSlug, taskName);
    writeFileSync(join(projectCwd, 'task.txt'), content, 'utf8');
    writeFileSync(join(projectCwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [{
        ...writeRunningTask(taskName, runSlug, cloneCwd, content),
        content: source === 'content' ? content : undefined,
        content_file: source === 'content_file' ? 'task.txt' : undefined,
        summary,
      }],
    }), 'utf8');

    for (const migrated of [false, true]) {
      if (migrated) {
        new TaskRunner(projectCwd).updateRunningTaskExecution(taskName, { runSlug, worktreePath: cloneCwd });
      }

      mockSelectOption.mockClear().mockResolvedValueOnce(null);
      await listTasks(projectCwd);
      expect(mockSelectOption).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringContaining(taskName),
          description: expect.stringMatching(new RegExp(`^${expectedSummary} \\| `)),
        }),
      ]));

      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await listTasksNonInteractive(projectCwd, { enabled: true });
        const taskLines = output.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(taskName));
        expect(taskLines).toHaveLength(1);
        expect(taskLines[0]).toContain(` - ${expectedSummary} (`);
      } finally {
        output.mockRestore();
      }

      if (source === 'content') {
        const response = listTaktTasks({ cwd: projectCwd });
        expect(response.isError).not.toBe(true);
        const text = response.content.find((block) => block.type === 'text');
        expect(text?.type).toBe('text');
        if (text?.type !== 'text') throw new Error('Expected MCP task list text');
        expect(JSON.parse(text.text)).toMatchObject({
          tasks: [expect.objectContaining({ name: taskName, summary: expectedSummary })],
        });

        mockSelectOptionWithDefault.mockClear().mockResolvedValueOnce(null);
        await runTellCommand({
          cwd: projectCwd, lang: 'en', inlineText: 'Keep the scope.', history: [],
          sessionContext: makeSessionContext(), preferredRunSlug: runSlug,
        });
        expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(expect.any(String), [
          expect.objectContaining({ value: runSlug, label: taskName, description: expectedSummary }),
        ], runSlug);
      }
    }
  });

  it('stores the generated instruction only for the confirmed B target when the conversation references A', async () => {
    const cloneA = join(projectCwd, '.takt', 'worktrees', 'task-a');
    const cloneB = join(projectCwd, '.takt', 'worktrees', 'task-b');
    mkdirSync(cloneA, { recursive: true });
    mkdirSync(cloneB, { recursive: true });
    writeRunMeta(cloneA, 'run-a', 'Task A');
    writeRunMeta(cloneB, 'run-b', 'Task B');
    mkdirSync(join(projectCwd, '.takt', 'runs', 'run-a'), { recursive: true });
    mkdirSync(join(projectCwd, '.takt', 'runs', 'run-b'), { recursive: true });
    writeFileSync(join(projectCwd, '.takt', 'tasks.yaml'), stringifyYaml({
      tasks: [
        writeRunningTask('task-a', 'run-a', cloneA, 'Task A summary'),
        writeRunningTask('task-b', 'run-b', cloneB, 'Task B summary'),
      ],
    }), 'utf8');

    const notice = await runTellCommand({
      cwd: projectCwd,
      lang: 'en',
      inlineText: 'それでお願いします',
      history: [{ role: 'assistant', content: 'For Task B, add an audit log.' }],
      sessionContext: makeSessionContext(),
      preferredRunSlug: 'run-a',
    });

    expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ value: 'run-a', label: 'task-a' }),
        expect.objectContaining({ value: 'run-b', label: 'task-b' }),
      ]),
      'run-a',
    );
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('task-b'));
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Add an audit log for Task B.'));
    expect(mockCallAIWithRetry).toHaveBeenCalledOnce();
    expect(notice).toContain('instruction #1');

    const storeA = new LiveInterventionFileStore(projectCwd, 'run-a');
    const storeB = new LiveInterventionFileStore(projectCwd, 'run-b');
    expect(existsSync(storeA.getFilePath())).toBe(false);
    expect(JSON.parse(readFileSync(storeB.getFilePath(), 'utf8'))).toEqual(expect.objectContaining({
      type: 'issued',
      instructionId: 1,
      content: 'Add an audit log for Task B.',
    }));
    expect(storeB.read().instructions).toEqual([
      expect.objectContaining({ instructionId: 1, content: 'Add an audit log for Task B.', state: 'pending' }),
    ]);
  });

  it.each(['external', 'project-local'] as const)(
    'selects and confirms a merge run with project metadata in a %s clone',
    async (location) => {
      let cloneCwd: string;
      if (location === 'external') {
        const cloneBase = mkdtempSync(join(tmpdir(), 'takt-tell-merge-clones-'));
        externalDirectories.push(cloneBase);
        saveGlobalConfig({ language: 'en', autoFetch: false, worktreeDir: cloneBase });
        cloneCwd = join(cloneBase, 'merge');
      } else {
        cloneCwd = join(projectCwd, '.takt', 'worktrees', 'merge');
      }
      const runSlug = 'merge-run';
      const { task } = createMergeRun(cloneCwd, runSlug);
      mockSelectOptionWithDefault.mockResolvedValueOnce(runSlug);
      mockCallAIWithRetry.mockResolvedValueOnce({ result: { success: true, content: 'Keep the agreed merge scope.' } });

      const notice = await runTellCommand({
        cwd: projectCwd, lang: 'en', inlineText: 'Keep this scope.', history: [],
        sessionContext: makeSessionContext(), preferredRunSlug: runSlug,
      });

      expect(mockSelectOptionWithDefault).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([expect.objectContaining({ value: runSlug, label: task.name })]),
        runSlug,
      );
      expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining(runSlug));
      expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('Keep the agreed merge scope.'));
      expect(notice).toContain('instruction #1');
      const store = new LiveInterventionFileStore(projectCwd, runSlug);
      expect(JSON.parse(readFileSync(store.getFilePath(), 'utf8'))).toMatchObject({
        type: 'issued', instructionId: 1, content: 'Keep the agreed merge scope.',
      });
      expect(existsSync(join(cloneCwd, '.takt', 'runs', runSlug, 'interventions.jsonl'))).toBe(false);
    },
  );

  it.each(['requeue', 'retry'] as const)(
    'resolves the new merge run after %s and a queue claim',
    async (mode) => {
      const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'merge');
      const { runner, task, metaPath } = createMergeRun(cloneCwd, 'old-merge-run');
      runner.forceFailRunningTask(task.name, { error: 'Review failed', step: 'review' });
      updateMeta(metaPath, { status: 'failed' });
      runner.requeueTask(task.name, ['failed'], mode === 'retry' ? { retryNote: 'Keep the agreed scope.' } : {});
      const [claimed] = runner.claimNextTasks(1);
      expect(claimed?.name).toBe(task.name);
      const runSlug = `${mode}-merge-run`;
      runner.updateRunningTaskExecution(task.name, { runSlug });
      writeRunMeta(projectCwd, runSlug, task.name);

      expect(listTellableRunningTasks(projectCwd).map((target) => target.runSlug)).toEqual([runSlug]);
      await issueTellableRunningTask(projectCwd, runSlug, 'Continue with this scope.');
      expect(new LiveInterventionFileStore(projectCwd, runSlug).read().instructions).toEqual([
        expect.objectContaining({ content: 'Continue with this scope.', state: 'pending' }),
      ]);
      expect(existsSync(new LiveInterventionFileStore(projectCwd, 'old-merge-run').getFilePath())).toBe(false);
    },
  );

  it.each([
    'completed task', 'completed run', 'deleted task', 'missing metadata', 'mismatched slug',
    'missing clone', 'no clone path', 'outside clone boundary', 'symlink clone', 'clone-only metadata',
  ] as const)('excludes a merge run with %s and writes no intervention', async (invalid) => {
    const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'merge');
    const runSlug = 'invalid-merge-run';
    const { metaPath } = createMergeRun(cloneCwd, runSlug);
    switch (invalid) {
      case 'completed task':
        updateTask({ status: 'completed', completed_at: '2026-10-14T00:00:00.000Z', owner_pid: null, owner_start_time: null });
        break;
      case 'completed run':
        updateMeta(metaPath, { status: 'completed' });
        writeRunMeta(cloneCwd, runSlug, 'Stale clone metadata');
        break;
      case 'deleted task': writeFileSync(join(projectCwd, '.takt', 'tasks.yaml'), stringifyYaml({ tasks: [] }), 'utf8'); break;
      case 'missing metadata': unlinkSync(metaPath); break;
      case 'mismatched slug': updateMeta(metaPath, { runSlug: 'different-merge-run' }); break;
      case 'missing clone': rmSync(cloneCwd, { recursive: true, force: true }); break;
      case 'no clone path': updateTask({ worktree_path: undefined }); break;
      case 'outside clone boundary': {
        const outside = join(projectCwd, 'untrusted-clone');
        mkdirSync(outside);
        updateTask({ worktree_path: outside });
        break;
      }
      case 'symlink clone': {
        const realClone = join(projectCwd, '.takt', 'worktrees', 'real-merge');
        mkdirSync(realClone);
        rmSync(cloneCwd, { recursive: true, force: true });
        symlinkSync(realClone, cloneCwd, 'dir');
        break;
      }
      case 'clone-only metadata':
        unlinkSync(metaPath);
        writeRunMeta(cloneCwd, runSlug, 'Merge task');
        break;
    }

    expect(listTellableRunningTasks(projectCwd)).toEqual([]);
    await expect(issueTellableRunningTask(projectCwd, runSlug, 'Must not send.')).rejects.toThrow();
    expect(existsSync(new LiveInterventionFileStore(projectCwd, runSlug).getFilePath())).toBe(false);
    expect(existsSync(join(cloneCwd, '.takt', 'runs', runSlug, 'interventions.jsonl'))).toBe(false);
  });

  it.each(['completed', 'deleted'] as const)(
    'does not write when the selected merge task is %s during confirmation',
    async (change) => {
      const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'merge');
      const runSlug = 'selected-merge-run';
      createMergeRun(cloneCwd, runSlug);
      mockSelectOptionWithDefault.mockResolvedValueOnce(runSlug);
      mockConfirmWithCancel.mockImplementationOnce(async () => {
        if (change === 'completed') {
          updateTask({ status: 'completed', completed_at: '2026-10-14T00:00:00.000Z', owner_pid: null, owner_start_time: null });
        }
        else writeFileSync(join(projectCwd, '.takt', 'tasks.yaml'), stringifyYaml({ tasks: [] }), 'utf8');
        return { kind: 'value', value: true };
      });

      const notice = await runTellCommand({
        cwd: projectCwd, lang: 'en', inlineText: 'Keep scope.', history: [],
        sessionContext: makeSessionContext(), preferredRunSlug: runSlug,
      });

      expect(mockConfirmWithCancel).toHaveBeenCalledOnce();
      expect(notice).toContain('was not sent');
      expect(existsSync(new LiveInterventionFileStore(projectCwd, runSlug).getFilePath())).toBe(false);
    },
  );

  it('rechecks project-side merge metadata after waiting for the intervention lock', async () => {
    const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'merge');
    const runSlug = 'locked-merge-run';
    const { metaPath } = createMergeRun(cloneCwd, runSlug);
    expect(listTellableRunningTasks(projectCwd).map((target) => target.runSlug)).toEqual([runSlug]);
    const store = new LiveInterventionFileStore(projectCwd, runSlug);
    const lockPath = `${store.getFilePath()}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'test-holder' }), { mode: 0o600 });

    const issuing = issueTellableRunningTask(projectCwd, runSlug, 'Must not append after completion.');
    updateMeta(metaPath, { status: 'completed' });
    unlinkSync(lockPath);

    await expect(issuing).rejects.toThrow();
    expect(existsSync(store.getFilePath())).toBe(false);
  });

  it('does not use project metadata for a normal PR review task', async () => {
    const cloneCwd = join(projectCwd, '.takt', 'worktrees', 'review');
    const runSlug = 'normal-review-run';
    createMergeRun(cloneCwd, runSlug);
    updateTask({ merge_task: undefined });

    expect(listTellableRunningTasks(projectCwd)).toEqual([]);
    await expect(issueTellableRunningTask(projectCwd, runSlug, 'Must not send.')).rejects.toThrow();
    expect(existsSync(new LiveInterventionFileStore(projectCwd, runSlug).getFilePath())).toBe(false);
  });

  it('retains ownership validation for an external normal PR review clone', async () => {
    const cloneBase = mkdtempSync(join(tmpdir(), 'takt-tell-normal-clones-'));
    externalDirectories.push(cloneBase);
    saveGlobalConfig({ language: 'en', autoFetch: false, worktreeDir: cloneBase });
    const cloneCwd = join(cloneBase, 'review');
    const runSlug = 'unowned-normal-review-run';
    createMergeRun(cloneCwd, runSlug);
    updateTask({ merge_task: undefined });
    writeRunMeta(cloneCwd, runSlug, 'Normal PR review');

    expect(listTellableRunningTasks(projectCwd)).toEqual([]);
    await expect(issueTellableRunningTask(projectCwd, runSlug, 'Must not send.')).rejects.toThrow();
    expect(existsSync(new LiveInterventionFileStore(projectCwd, runSlug).getFilePath())).toBe(false);
  });
});
