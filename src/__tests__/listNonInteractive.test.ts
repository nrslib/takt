import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { listTasksNonInteractive } from '../features/tasks/list/listNonInteractive.js';
import { TaskRunner } from '../infra/task/runner.js';
import { TaskRecordSchema } from '../infra/task/schema.js';

const mockInfo = vi.fn();
vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
}));

vi.mock('../infra/task/branchList.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  detectDefaultBranch: vi.fn(() => 'main'),
}));

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-list-non-interactive-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const goalId = '550e8400-e29b-41d4-a716-446655440000';

function writeGoalTasksFile(projectDir: string): void {
  const tasks = ['pending', 'running', 'completed', 'failed', 'exceeded', 'pr_failed'].map((status) =>
    TaskRecordSchema.parse({
      name: `${status}-goal-task`, status, content: `${status} content`, goal_id: goalId,
      branch: `feature/${status}`, created_at: '2026-02-09T00:00:00Z',
      started_at: status === 'pending' ? null : '2026-02-09T00:01:00Z',
      completed_at: status === 'pending' || status === 'running' ? null : '2026-02-09T00:02:00Z',
      ...(status === 'failed' ? { failure: { error: 'failed' } } : {}),
    }));
  const file = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringifyYaml({ tasks }));
}

function writeTasksFile(projectDir: string): void {
  const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, stringifyYaml({
    tasks: [
      {
        name: 'pending-task',
        status: 'pending',
        content: 'Pending content',
        workflow: 'workflow-alpha',
        start_step: 'implement',
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
        failure: { step: 'review', error: 'Boom' },
      },
    ],
  }), 'utf-8');
}

describe('listTasksNonInteractive', () => {
  it('propagates saved goal IDs through every task status into list items and JSON', async () => {
    writeGoalTasksFile(tmpDir);
    const items = new TaskRunner(tmpDir).listAllTaskItems();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listTasksNonInteractive(tmpDir, { enabled: true, format: 'json' });

    expect(items).toHaveLength(6);
    for (const item of items) expect(item).toMatchObject({ goalId });
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
      tasks: Array<{ name: string; goal_id?: string }>;
    };
    expect(payload.tasks).toHaveLength(6);
    for (const item of payload.tasks) expect(item.goal_id).toBe(goalId);
  });

  it('previews only matching saved records as JSON without changing tasks.yaml', async () => {
    writeGoalTasksFile(tmpDir);
    const file = path.join(tmpDir, '.takt', 'tasks.yaml');
    const original = fs.readFileSync(file, 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await listTasksNonInteractive(tmpDir, { enabled: true, action: 'delete', format: 'json',
      status: ['failed', 'pr_failed'], goal: goalId });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
      tasks: Array<{ name: string; kind: string; branch: string; goal_id: string }>;
    };
    expect(payload.tasks.map(({ name, kind, branch, goal_id }) => ({ name, kind, branch, goal_id }))).toEqual([
      { name: 'failed-goal-task', kind: 'failed', branch: 'feature/failed', goal_id: goalId },
      { name: 'pr_failed-goal-task', kind: 'pr_failed', branch: 'feature/pr_failed', goal_id: goalId },
    ]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('returns an empty successful JSON preview for a valid filter with no matches', async () => {
    writeGoalTasksFile(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await listTasksNonInteractive(tmpDir, { enabled: true, action: 'delete', format: 'json',
      goal: '550e8400-e29b-41d4-a716-446655440001' });

    expect(logSpy).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ tasks: [] }, null, 2));
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('keeps the ordinary text list unchanged when a task has a goal', async () => {
    writeGoalTasksFile(tmpDir);
    await listTasksNonInteractive(tmpDir, { enabled: true });

    expect(mockInfo.mock.calls.map(([message]) => message)).toEqual([
      '[pending] pending-goal-task (feature/pending) - pending content (02/09 00:00)',
      '[running] running-goal-task (feature/running) - running content (02/09 00:00)',
      '[completed] completed-goal-task (feature/completed) - completed content (02/09 00:00)',
      '[failed] failed-goal-task (feature/failed) - failed content (02/09 00:00)',
      '[exceeded] exceeded-goal-task (feature/exceeded) - exceeded content (02/09 00:00)',
      '[pr-failed] pr_failed-goal-task (feature/pr_failed) - pr_failed content (02/09 00:00)',
    ]);
  });

  it('should output JSON when format=json', async () => {
    writeTasksFile(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listTasksNonInteractive(tmpDir, { enabled: true, format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      tasks: Array<{
        name: string;
        kind: string;
        data?: { workflow?: string; start_step?: string };
        failure?: { step?: string; error: string };
      }>;
    };
    expect(payload.tasks[0]?.name).toBe('pending-task');
    expect(payload.tasks[0]?.kind).toBe('pending');
    expect(payload.tasks[0]?.data?.workflow).toBe('workflow-alpha');
    expect(payload.tasks[0]?.data?.start_step).toBe('implement');
    expect(payload.tasks[1]?.name).toBe('failed-task');
    expect(payload.tasks[1]?.kind).toBe('failed');
    expect(payload.tasks[1]?.failure?.step).toBe('review');

    logSpy.mockRestore();
  });

  it('should output an empty JSON payload when format=json and there are no tasks', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await listTasksNonInteractive(tmpDir, { enabled: true, format: 'json' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual({ tasks: [] });

    logSpy.mockRestore();
  });
});
