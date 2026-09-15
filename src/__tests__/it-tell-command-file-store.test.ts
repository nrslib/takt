import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

const { mockConfirm, mockSelectOption, mockSelectOptionWithDefault } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockSelectOption: vi.fn(),
  mockSelectOptionWithDefault: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/prompt/index.js')>()),
  selectOption: (...args: unknown[]) => mockSelectOption(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  selectOptionWithDefault: (...args: unknown[]) => mockSelectOptionWithDefault(...args),
}));

import { runTellCommand } from '../features/interactive/tellCommand.js';
import { LiveInterventionFileStore } from '../infra/workflow/live-intervention-store.js';

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
    mockSelectOption.mockReset().mockImplementation(() => {
      throw new Error('Unexpected selectOption call');
    });
    mockConfirm.mockReset();
    mockSelectOptionWithDefault.mockReset();
    mockConfirm.mockResolvedValue(true);
    mockSelectOptionWithDefault.mockResolvedValue('run-b');
  });

  afterEach(() => {
    rmSync(projectCwd, { recursive: true, force: true });
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

  it('writes only the confirmed B target when the conversation references A', async () => {
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
      inlineText: 'Only send this to B.',
      history: [],
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
    expect(mockConfirm).toHaveBeenCalledWith(expect.stringContaining('task-b'));
    expect(notice).toContain('instruction #1');

    const storeA = new LiveInterventionFileStore(projectCwd, 'run-a');
    const storeB = new LiveInterventionFileStore(projectCwd, 'run-b');
    expect(existsSync(storeA.getFilePath())).toBe(false);
    expect(JSON.parse(readFileSync(storeB.getFilePath(), 'utf8'))).toEqual(expect.objectContaining({
      type: 'issued',
      instructionId: 1,
      content: 'Only send this to B.',
    }));
    expect(storeB.read().instructions).toEqual([
      expect.objectContaining({ instructionId: 1, content: 'Only send this to B.', state: 'pending' }),
    ]);
  });
});
