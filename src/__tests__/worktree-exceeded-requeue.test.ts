import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// --- Mock setup ---

vi.mock('../infra/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/index.js')>();
  return {
    ...actual,
    loadPieceByIdentifier: vi.fn(),
    isPiecePath: vi.fn().mockReturnValue(false),
    resolvePieceConfigValues: vi.fn().mockReturnValue({}),
    resolvePieceConfigValue: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProviderOptionsWithTrace: vi.fn().mockReturnValue({
    value: undefined,
    source: 'global',
    originResolver: () => 'default',
  }),
}));

vi.mock('../features/tasks/execute/pieceExecution.js', () => ({
  executePiece: vi.fn(),
}));

vi.mock('../features/tasks/execute/postExecution.js', () => ({
  postExecutionFlow: vi.fn(),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/task/index.js')>();
  return {
    ...actual,
    createSharedClone: vi.fn(),
    detectDefaultBranch: vi.fn(),
    summarizeTaskName: vi.fn(),
  };
});

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  header: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  status: vi.fn(),
  blankLine: vi.fn(),
  withProgress: vi.fn().mockImplementation(
    async (_startMsg: string, _successFn: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

// --- Imports ---

import { executePiece } from '../features/tasks/execute/pieceExecution.js';
import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';
import { loadPieceByIdentifier } from '../infra/config/index.js';
import { createSharedClone, detectDefaultBranch, summarizeTaskName } from '../infra/task/index.js';
import { withProgress } from '../shared/ui/index.js';
import { executeAndCompleteTask } from '../features/tasks/execute/taskExecution.js';
import { TaskRunner } from '../infra/task/runner.js';
import type { PieceConfig } from '../core/models/index.js';
import type { PieceExecutionOptions } from '../features/tasks/execute/types.js';

// --- Helpers ---

function createTestDir(): string {
  const dir = join(tmpdir(), `takt-worktree-requeue-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadTasksFile(testDir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = readFileSync(join(testDir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

function writeExceededRecord(testDir: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(testDir, '.takt'), { recursive: true });
  const record = {
    name: 'task-a',
    status: 'exceeded',
    content: 'Do work',
    workflow: 'test-piece',
    created_at: '2026-02-09T00:00:00.000Z',
    started_at: '2026-02-09T00:01:00.000Z',
    completed_at: '2026-02-09T00:05:00.000Z',
    owner_pid: null,
    start_step: 'implement',
    exceeded_max_steps: 60,
    exceeded_current_iteration: 30,
    ...overrides,
  };
  writeFileSync(
    join(testDir, '.takt', 'tasks.yaml'),
    stringifyYaml({ tasks: [record] }),
    'utf-8',
  );
}

function buildTestPieceConfig(): PieceConfig {
  return {
    name: 'test-piece',
    maxMovements: 30,
    initialMovement: 'plan',
    movements: [
      {
        name: 'plan',
        persona: '../personas/plan.md',
        personaDisplayName: 'plan',
        instruction: 'Run plan',
        passPreviousResponse: true,
        rules: [],
      },
    ],
  };
}

function applyDefaultMocks(): void {
  vi.mocked(loadPieceByIdentifier).mockReturnValue(buildTestPieceConfig());
  vi.mocked(detectDefaultBranch).mockReturnValue('main');
  vi.mocked(postExecutionFlow).mockResolvedValue({ prUrl: undefined, prFailed: false });
  vi.mocked(withProgress).mockImplementation(
    async (_startMsg: string, _successFn: unknown, fn: () => Promise<unknown>) => fn(),
  );
}

// --- Tests ---

describe('シナリオ1・2: exceeded status transition via executeAndCompleteTask', () => {
  let testDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultMocks();
    testDir = createTestDir();
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('scenario 1: task transitions to exceeded status when executePiece returns exceeded result', async () => {
    runner.addTask('Do work', { piece: 'test-piece' });
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executePiece).mockResolvedValueOnce({
      success: false,
      exceeded: true,
      exceededInfo: {
        currentMovement: 'implement',
        newMaxMovements: 60,
        currentIteration: 30,
      },
    });

    const result = await executeAndCompleteTask(task, runner, testDir);

    expect(result).toBe(false);

    const exceededTasks = runner.listExceededTasks();
    expect(exceededTasks).toHaveLength(1);
    expect(exceededTasks[0]?.kind).toBe('exceeded');
    expect(exceededTasks[0]?.name).toBe(task.name);
  });

  it('scenario 2: exceeded metadata is recorded in tasks.yaml for resumption', async () => {
    runner.addTask('Do work', { piece: 'test-piece' });
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executePiece).mockResolvedValueOnce({
      success: false,
      exceeded: true,
      exceededInfo: {
        currentMovement: 'implement',
        newMaxMovements: 60,
        currentIteration: 30,
      },
    });

    await executeAndCompleteTask(task, runner, testDir);

    const file = loadTasksFile(testDir);
    const exceededRecord = file.tasks[0];
    expect(exceededRecord?.status).toBe('exceeded');
    expect(exceededRecord?.start_step).toBe('implement');
    expect(exceededRecord?.exceeded_max_steps).toBe(60);
    expect(exceededRecord?.exceeded_current_iteration).toBe(30);
  });

  it('scenario 5: first exceed on worktree task persists worktree_path and branch in tasks.yaml', async () => {
    const cloneDir = join(testDir, '.takt', 'worktrees', `first-exceed-${randomUUID()}`);
    mkdirSync(cloneDir, { recursive: true });
    vi.mocked(summarizeTaskName).mockResolvedValueOnce('slug-562');
    vi.mocked(createSharedClone).mockResolvedValueOnce({
      path: cloneDir,
      branch: 'takt/slug-562',
    });

    runner.addTask('Do work', { piece: 'test-piece', worktree: true });
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executePiece).mockResolvedValueOnce({
      success: false,
      exceeded: true,
      exceededInfo: {
        currentMovement: 'implement',
        newMaxMovements: 60,
        currentIteration: 30,
      },
    });

    await executeAndCompleteTask(task, runner, testDir);

    const file = loadTasksFile(testDir);
    const rec = file.tasks[0];
    expect(rec?.status).toBe('exceeded');
    expect(rec?.worktree_path).toBe(cloneDir);
    expect(rec?.branch).toBe('takt/slug-562');
  });
});

describe('シナリオ3・4: requeue → re-execution passes exceeded metadata to executePiece', () => {
  let testDir: string;
  let cloneDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    applyDefaultMocks();
    testDir = createTestDir();
    cloneDir = join(testDir, '.takt', 'worktrees', `existing-${randomUUID()}`);
    mkdirSync(cloneDir, { recursive: true });
    runner = new TaskRunner(testDir);
  });

  afterEach(() => {
    for (const dir of [testDir, cloneDir]) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('scenario 3: maxMovementsOverride and initialIterationOverride are passed to executePiece after requeue', async () => {
    writeExceededRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      exceeded_max_movements: 60,
      exceeded_current_iteration: 30,
    });

    runner.requeueExceededTask('task-a');

    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executePiece).mockResolvedValueOnce({ success: true });

    await executeAndCompleteTask(task, runner, testDir);

    expect(vi.mocked(executePiece)).toHaveBeenCalledOnce();
    const capturedOptions = vi.mocked(executePiece).mock.calls[0]![3] as PieceExecutionOptions;
    expect(capturedOptions.maxMovementsOverride).toBe(60);
    expect(capturedOptions.initialIterationOverride).toBe(30);
  });

  it('scenario 4: startMovement is passed so re-execution resumes from the exceeded movement', async () => {
    writeExceededRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      exceeded_max_movements: 60,
      exceeded_current_iteration: 30,
      start_movement: 'implement',
    });

    runner.requeueExceededTask('task-a');

    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    vi.mocked(executePiece).mockResolvedValueOnce({ success: true });

    await executeAndCompleteTask(task, runner, testDir);

    expect(vi.mocked(executePiece)).toHaveBeenCalledOnce();
    const capturedOptions = vi.mocked(executePiece).mock.calls[0]![3] as PieceExecutionOptions;
    expect(capturedOptions.startMovement).toBe('implement');
  });
});
