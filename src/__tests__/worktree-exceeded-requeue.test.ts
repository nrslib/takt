/**
 * Integration tests for worktree exceeded → requeue → re-execution flow.
 *
 * Scenarios:
 * 1. Worktree task reaches iteration limit → transitions to 'exceeded' status
 * 2. Exceeded task stores start_movement / exceeded_max_movements / exceeded_current_iteration
 * 3. After requeue, re-execution passes maxMovementsOverride and initialIterationOverride
 * 4. After requeue, re-execution starts from start_movement (re-entry point)
 *
 * Integration boundary:
 *   TaskRunner (real file I/O) →
 *   executeAndCompleteTask →
 *     resolveTaskExecution →
 *     executeTaskWithResult →
 *     executePiece (mocked, args captured)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../infra/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/config/index.js')>();
  return {
    ...actual,
    loadPieceByIdentifier: vi.fn(),
    isPiecePath: vi.fn().mockReturnValue(false),
    resolvePieceConfigValues: vi.fn().mockReturnValue({}),
    resolveConfigValueWithSource: vi.fn().mockReturnValue({ value: undefined, source: 'global' }),
    resolvePieceConfigValue: vi.fn().mockReturnValue(undefined),
  };
});

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

// --- Imports (after mocks) ---

import { executePiece } from '../features/tasks/execute/pieceExecution.js';
import { postExecutionFlow } from '../features/tasks/execute/postExecution.js';
import { loadPieceByIdentifier } from '../infra/config/index.js';
import { detectDefaultBranch } from '../infra/task/index.js';
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
    created_at: '2026-02-09T00:00:00.000Z',
    started_at: '2026-02-09T00:01:00.000Z',
    completed_at: '2026-02-09T00:05:00.000Z',
    owner_pid: null,
    start_movement: 'implement',
    exceeded_max_movements: 60,
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
        instructionTemplate: 'Run plan',
        passPreviousResponse: true,
        rules: [],
      },
    ],
  };
}

function applyDefaultMocks(): void {
  // Re-apply mocks that are not set by the vi.mock factory
  // (vi.clearAllMocks preserves factory implementations, but these are set per-suite)
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
    // clearAllMocks clears call history but preserves factory implementations
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
    // Given: a pending task
    runner.addTask('Do work');
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    // executePiece simulates hitting iteration limit
    vi.mocked(executePiece).mockResolvedValueOnce({
      success: false,
      exceeded: true,
      exceededInfo: {
        currentMovement: 'implement',
        newMaxMovements: 60,
        currentIteration: 30,
      },
    });

    // When: executeAndCompleteTask processes the exceeded result
    const result = await executeAndCompleteTask(task, runner, testDir, 'test-piece');

    // Then: returns false (task did not succeed)
    expect(result).toBe(false);

    // Then: task is now in exceeded status
    const exceededTasks = runner.listExceededTasks();
    expect(exceededTasks).toHaveLength(1);
    expect(exceededTasks[0]?.kind).toBe('exceeded');
    expect(exceededTasks[0]?.name).toBe(task.name);
  });

  it('scenario 2: exceeded metadata is recorded in tasks.yaml for resumption', async () => {
    // Given: a pending task
    runner.addTask('Do work');
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    // executePiece simulates hitting limit at 'implement' movement, producing 30/60 iterations
    vi.mocked(executePiece).mockResolvedValueOnce({
      success: false,
      exceeded: true,
      exceededInfo: {
        currentMovement: 'implement',
        newMaxMovements: 60,
        currentIteration: 30,
      },
    });

    // When: executeAndCompleteTask records the exceeded result
    await executeAndCompleteTask(task, runner, testDir, 'test-piece');

    // Then: YAML contains the three resumption fields
    const file = loadTasksFile(testDir);
    const exceededRecord = file.tasks[0];
    expect(exceededRecord?.status).toBe('exceeded');
    expect(exceededRecord?.start_movement).toBe('implement');
    expect(exceededRecord?.exceeded_max_movements).toBe(60);
    expect(exceededRecord?.exceeded_current_iteration).toBe(30);
  });
});

describe('シナリオ3・4: requeue → re-execution passes exceeded metadata to executePiece', () => {
  let testDir: string;
  let cloneDir: string;
  let runner: TaskRunner;

  beforeEach(() => {
    // clearAllMocks clears call history but preserves factory implementations
    vi.clearAllMocks();
    applyDefaultMocks();
    testDir = createTestDir();
    // cloneDir simulates a pre-existing worktree clone (fs.existsSync check will pass)
    cloneDir = createTestDir();
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
    // Given: an exceeded worktree task with pre-existing clone on disk
    writeExceededRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      exceeded_max_movements: 60,
      exceeded_current_iteration: 30,
    });

    // Requeue → status back to pending, exceeded metadata and worktree_path preserved
    runner.requeueExceededTask('task-a');

    // Claim the requeued task as running
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    // executePiece returns success so we can capture args without side effects
    vi.mocked(executePiece).mockResolvedValueOnce({ success: true });

    // When: executeAndCompleteTask runs the requeued task
    await executeAndCompleteTask(task, runner, testDir, 'test-piece');

    // Then: executePiece received the correct exceeded override options
    expect(vi.mocked(executePiece)).toHaveBeenCalledOnce();
    const capturedOptions = vi.mocked(executePiece).mock.calls[0]![3] as PieceExecutionOptions;
    expect(capturedOptions.maxMovementsOverride).toBe(60);
    expect(capturedOptions.initialIterationOverride).toBe(30);
  });

  it('scenario 4: startMovement is passed so re-execution resumes from the exceeded movement', async () => {
    // Given: an exceeded worktree task with start_movement='implement'
    writeExceededRecord(testDir, {
      worktree: true,
      worktree_path: cloneDir,
      exceeded_max_movements: 60,
      exceeded_current_iteration: 30,
      start_movement: 'implement',
    });

    // Requeue → pending, start_movement preserved
    runner.requeueExceededTask('task-a');

    // Claim the requeued task as running
    const [task] = runner.claimNextTasks(1);
    if (!task) throw new Error('No task claimed');

    // executePiece returns success so we can capture args without side effects
    vi.mocked(executePiece).mockResolvedValueOnce({ success: true });

    // When: executeAndCompleteTask runs the requeued task
    await executeAndCompleteTask(task, runner, testDir, 'test-piece');

    // Then: executePiece received startMovement='implement' to resume from where it stopped
    expect(vi.mocked(executePiece)).toHaveBeenCalledOnce();
    const capturedOptions = vi.mocked(executePiece).mock.calls[0]![3] as PieceExecutionOptions;
    expect(capturedOptions.startMovement).toBe('implement');
  });
});
