import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';

const mockInfo = vi.fn();
vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
}));

vi.mock('../infra/task/branchList.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectDefaultBranch: vi.fn(() => 'main'),
  listTaktBranches: vi.fn(() => []),
  buildListItems: vi.fn(() => []),
}));

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-list-non-interactive-'));
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
        name: 'pending-task',
        status: 'pending',
        content: 'Pending content',
        created_at: '2026-02-09T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      },
      {
        name: 'failed-task',
        status: 'failed',
        content: 'Failed content',
        created_at: '2026-02-09T00:00:00.000Z',
        started_at: '2026-02-09T00:01:00.000Z',
        completed_at: '2026-02-09T00:02:00.000Z',
        failure: { error: 'Boom' },
      },
    ],
  }), 'utf-8');
}

describe('listTasksNonInteractive', () => {
  it('should output pending and failed tasks in text format', async () => {
    writeTasksFile(tmpDir);

    await listTasksNonInteractive(tmpDir, { enabled: true, format: 'text' });

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('[running] pending-task'));
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('[failed] failed-task'));
  });

  it('should output JSON when format=json', async () => {
    writeTasksFile(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listTasksNonInteractive(tmpDir, { enabled: true, format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string) as { pendingTasks: Array<{ name: string }>; failedTasks: Array<{ name: string }> };
    expect(payload.pendingTasks[0]?.name).toBe('pending-task');
    expect(payload.failedTasks[0]?.name).toBe('failed-task');

    logSpy.mockRestore();
  });
});
