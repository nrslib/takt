import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  header: vi.fn(),
  blankLine: vi.fn(),
  divider: vi.fn(),
}));

vi.mock('../infra/task/branchList.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectDefaultBranch: vi.fn(() => 'main'),
}));

import { TaskRunner } from '../infra/task/runner.js';
import { showTaskList } from '../infra/task/display.js';
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
        piece: 'default-workflow',
        start_movement: 'implement',
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
        failure: { movement: 'review', error: 'boom' },
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

  it('should display workflow from canonical piece field only', () => {
    const runner = new TaskRunner(tmpDir);
    runner.addTask('Pending task', { piece: 'default' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    showTaskList(runner);

    const output = logSpy.mock.calls.flatMap((args) => args.map(String)).join('\n');
    expect(output).toContain('workflow: default');
    expect(output).not.toContain('undefined');

    logSpy.mockRestore();
  });
});

describe('listTasks non-interactive JSON output', () => {
  it('should output JSON object with tasks', async () => {
    writeTasksFile(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listTasksNonInteractive(tmpDir, { enabled: true, format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      tasks: Array<{
        name: string;
        kind: string;
        data?: { workflow?: string; start_step?: string; piece?: string; start_movement?: string };
        failure?: { step?: string; movement?: string; error: string };
      }>;
    };
    expect(Array.isArray(payload.tasks)).toBe(true);
    expect(payload.tasks[0]?.name).toBe('pending-one');
    expect(payload.tasks[0]?.kind).toBe('pending');
    expect(payload.tasks[0]?.data?.workflow).toBe('default-workflow');
    expect(payload.tasks[0]?.data?.start_step).toBe('implement');
    expect(payload.tasks[0]?.data).not.toHaveProperty('piece');
    expect(payload.tasks[0]?.data).not.toHaveProperty('start_movement');
    expect(payload.tasks[1]?.name).toBe('failed-one');
    expect(payload.tasks[1]?.kind).toBe('failed');
    expect(payload.tasks[1]?.failure?.step).toBe('review');
    expect(payload.tasks[1]?.failure?.error).toBe('boom');
    expect(payload.tasks[1]?.failure).not.toHaveProperty('movement');

    logSpy.mockRestore();
  });

  it('should output an empty JSON object when no tasks exist', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listTasksNonInteractive(tmpDir, { enabled: true, format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual({ tasks: [] });

    logSpy.mockRestore();
  });
});
