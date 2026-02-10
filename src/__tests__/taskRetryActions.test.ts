import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  header: vi.fn(),
  blankLine: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/config/index.js', () => ({
  loadGlobalConfig: vi.fn(),
  loadPieceByIdentifier: vi.fn(),
}));

import { selectOption, promptInput } from '../shared/prompt/index.js';
import { success, error as logError } from '../shared/ui/index.js';
import { loadGlobalConfig, loadPieceByIdentifier } from '../infra/config/index.js';
import { retryFailedTask } from '../features/tasks/list/taskRetryActions.js';
import type { TaskListItem } from '../infra/task/types.js';
import type { PieceConfig } from '../core/models/index.js';

const mockSelectOption = vi.mocked(selectOption);
const mockPromptInput = vi.mocked(promptInput);
const mockSuccess = vi.mocked(success);
const mockLogError = vi.mocked(logError);
const mockLoadGlobalConfig = vi.mocked(loadGlobalConfig);
const mockLoadPieceByIdentifier = vi.mocked(loadPieceByIdentifier);

let tmpDir: string;

const defaultPieceConfig: PieceConfig = {
  name: 'default',
  description: 'Default piece',
  initialMovement: 'plan',
  maxMovements: 30,
  movements: [
    { name: 'plan', persona: 'planner', instruction: '' },
    { name: 'implement', persona: 'coder', instruction: '' },
    { name: 'review', persona: 'reviewer', instruction: '' },
  ],
};

function writeFailedTask(projectDir: string, name: string): TaskListItem {
  const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, stringifyYaml({
    tasks: [
      {
        name,
        status: 'failed',
        content: 'Do something',
        created_at: '2025-01-15T12:00:00.000Z',
        started_at: '2025-01-15T12:01:00.000Z',
        completed_at: '2025-01-15T12:02:00.000Z',
        piece: 'default',
        failure: {
          movement: 'review',
          error: 'Boom',
        },
      },
    ],
  }), 'utf-8');

  return {
    kind: 'failed',
    name,
    createdAt: '2025-01-15T12:02:00.000Z',
    filePath: tasksFile,
    content: 'Do something',
    data: { task: 'Do something', piece: 'default' },
    failure: { movement: 'review', error: 'Boom' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-retry-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('retryFailedTask', () => {
  it('should requeue task with selected movement', async () => {
    const task = writeFailedTask(tmpDir, 'my-task');

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
    mockSelectOption.mockResolvedValue('implement');
    mockPromptInput.mockResolvedValue('');

    const result = await retryFailedTask(task, tmpDir);

    expect(result).toBe(true);
    expect(mockSuccess).toHaveBeenCalledWith('Task requeued: my-task');

    const tasksYaml = fs.readFileSync(path.join(tmpDir, '.takt', 'tasks.yaml'), 'utf-8');
    expect(tasksYaml).toContain('status: pending');
    expect(tasksYaml).toContain('start_movement: implement');
  });

  it('should not add start_movement when initial movement is selected', async () => {
    const task = writeFailedTask(tmpDir, 'my-task');

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
    mockSelectOption.mockResolvedValue('plan');
    mockPromptInput.mockResolvedValue('');

    const result = await retryFailedTask(task, tmpDir);

    expect(result).toBe(true);
    const tasksYaml = fs.readFileSync(path.join(tmpDir, '.takt', 'tasks.yaml'), 'utf-8');
    expect(tasksYaml).not.toContain('start_movement');
  });

  it('should return false and show error when piece not found', async () => {
    const task = writeFailedTask(tmpDir, 'my-task');

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockReturnValue(null);

    const result = await retryFailedTask(task, tmpDir);

    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      'Piece "default" not found. Cannot determine available movements.',
    );
  });
});
