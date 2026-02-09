import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  header: vi.fn(),
  blankLine: vi.fn(),
}));

vi.mock('../infra/task/branchList.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listTaktBranches: vi.fn(() => []),
  buildListItems: vi.fn(() => []),
  detectDefaultBranch: vi.fn(() => 'main'),
}));

import { TaskRunner } from '../infra/task/runner.js';
import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-list-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTasksFile(projectDir: string): void {
  const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, stringifyYaml({
    tasks: [
      {
        name: 'pending-one',
        status: 'pending',
        content: 'Pending task',
        created_at: '2026-02-09T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      },
      {
        name: 'failed-one',
        status: 'failed',
        content: 'Failed task',
        created_at: '2026-02-09T00:00:00.000Z',
        started_at: '2026-02-09T00:01:00.000Z',
        completed_at: '2026-02-09T00:02:00.000Z',
        failure: { error: 'boom' },
      },
    ],
  }), 'utf-8');
}

describe('TaskRunner list APIs', () => {
  it('should read pending and failed tasks from tasks.yaml', () => {
    writeTasksFile(tmpDir);
    const runner = new TaskRunner(tmpDir);

    const pending = runner.listPendingTaskItems();
    const failed = runner.listFailedTasks();

    expect(pending).toHaveLength(1);
    expect(pending[0]?.name).toBe('pending-one');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.name).toBe('failed-one');
    expect(failed[0]?.failure?.error).toBe('boom');
  });
});

describe('listTasks non-interactive JSON output', () => {
  it('should output JSON object with branches, pendingTasks, and failedTasks', async () => {
    writeTasksFile(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listTasksNonInteractive(tmpDir, { enabled: true, format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      branches: unknown[];
      pendingTasks: Array<{ name: string }>;
      failedTasks: Array<{ name: string }>;
    };
    expect(Array.isArray(payload.branches)).toBe(true);
    expect(payload.pendingTasks[0]?.name).toBe('pending-one');
    expect(payload.failedTasks[0]?.name).toBe('failed-one');

    logSpy.mockRestore();
  });
});
