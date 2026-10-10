vi.mock('../features/tasks/execute/providerPreflight.js', () => ({ checkTaskNameProvider: vi.fn(async () => undefined), checkTaskProviders: vi.fn().mockResolvedValue(undefined), terminalProviderConfirmation: () => undefined }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedTaskOrderRevision } from '../features/tasks/orderRevision.js';
import type { FailedTaskRetryPersistenceOptions } from '../features/tasks/taskRetryPersistence.js';
import type { TaskListItem } from '../infra/task/index.js';

const {
  persistenceOrder,
  mockAssertReusableWorktreePath,
  mockRequeueTask,
  mockPersistRevision,
  mockCleanupRevision,
} = vi.hoisted(() => ({
  persistenceOrder: [] as string[],
  mockAssertReusableWorktreePath: vi.fn(),
  mockRequeueTask: vi.fn(),
  mockPersistRevision: vi.fn(),
  mockCleanupRevision: vi.fn(),
}));

vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({
  assertReusableWorktreePath: (...args: unknown[]) => mockAssertReusableWorktreePath(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    requeueTask(...args: unknown[]) {
      return mockRequeueTask(...args);
    }
  },
}));

vi.mock('../features/tasks/orderRevision.js', () => ({
  persistTaskOrderRevision: (...args: unknown[]) => mockPersistRevision(...args),
  cleanupPersistedTaskOrderRevision: (...args: unknown[]) => mockCleanupRevision(...args),
}));

import { appendRetryNote, persistFailedTaskRetry } from '../features/tasks/taskRetryPersistence.js';

const failedTask: TaskListItem = {
  kind: 'failed',
  name: 'task-a',
  createdAt: '2026-09-28T00:00:00.000Z',
  filePath: '/project/.takt/tasks.yaml',
  content: 'old order',
  taskDir: '.takt/tasks/task-a',
  worktreePath: '/project/.worktrees/task-a',
};

const retryOptions: FailedTaskRetryPersistenceOptions = {
  task: failedTask,
  projectDir: '/project',
  worktreePath: '/project/.worktrees/task-a',
  startStep: 'implement',
  retryNote: 'Retry with the updated requirements',
  resumePoint: undefined,
  workflow: undefined,
  taskDir: undefined,
  sourceRunSlug: 'run-a',
  restartPoint: {
    stack: [{ workflow: 'default', workflow_ref: 'default', step: 'implement', kind: 'agent' }],
  },
};

function createRevision(): PersistedTaskOrderRevision {
  return {
    taskDirRelative: '.takt/tasks/task-a',
    created: false,
    rollback: vi.fn(),
  };
}

describe('appendRetryNote', () => {
  it('trims and appends an instruction to the existing retry note', () => {
    expect(appendRetryNote('Existing note', '  New instruction  ')).toBe(
      'Existing note\n\nNew instruction',
    );
  });

  it('rejects an empty additional instruction', () => {
    expect(() => appendRetryNote('Existing note', '  ')).toThrow('Additional instruction is empty.');
  });
});

describe('persistFailedTaskRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistenceOrder.length = 0;
    mockPersistRevision.mockReturnValue(createRevision());
  });

  it('requeues failed task with the selected start and ownership values without changing the order', async () => {
    await persistFailedTaskRetry(retryOptions);

    expect(mockAssertReusableWorktreePath).toHaveBeenCalledTimes(2);
    expect(mockRequeueTask).toHaveBeenCalledWith('task-a', ['failed'], {
      startStep: 'implement',
      retryNote: 'Retry with the updated requirements',
      resumePoint: undefined,
      workflow: undefined,
      taskDir: undefined,
      sourceRunSlug: 'run-a',
      restartPoint: {
        stack: [{ workflow: 'default', workflow_ref: 'default', step: 'implement', kind: 'agent' }],
      },
    });
    expect(mockPersistRevision).not.toHaveBeenCalled();
  });

  it('persists a revised order before requeueing and rolls it back if task state fails', async () => {
    const revision = createRevision();
    mockPersistRevision.mockImplementation(() => {
      persistenceOrder.push('persist');
      return revision;
    });
    mockRequeueTask.mockImplementation(() => {
      persistenceOrder.push('requeue');
      throw new Error('state write failed');
    });
    mockCleanupRevision.mockImplementation(() => persistenceOrder.push('rollback'));

    await expect(persistFailedTaskRetry({
      ...retryOptions,
      taskDir: '.takt/tasks/task-a',
      revisedOrder: {
        content: 'updated order',
        lang: 'ja',
        attachments: [],
      },
    })).rejects.toThrow('state write failed');

    expect(mockPersistRevision).toHaveBeenCalledWith(
      '/project',
      '.takt/tasks/task-a',
      'updated order',
      'ja',
      [],
    );
    expect(mockCleanupRevision).toHaveBeenCalledWith(revision);
    expect(persistenceOrder).toEqual(['persist', 'requeue', 'rollback']);
  });

  it('rejects non-failed tasks before checking or changing state', async () => {
    const nonFailedTask: TaskListItem = { ...failedTask, kind: 'exceeded' };

    await expect(persistFailedTaskRetry({ ...retryOptions, task: nonFailedTask }))
      .rejects.toThrow('Failed task retry persistence requires failed task. received: exceeded');
    expect(mockAssertReusableWorktreePath).not.toHaveBeenCalled();
    expect(mockRequeueTask).not.toHaveBeenCalled();
  });
});
