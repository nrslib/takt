import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '../infra/task/index.js';
import { buildTraceTaskMetadata } from '../features/tasks/execute/traceTaskMetadata.js';

function createTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    name: 'task-827',
    slug: 'add-trace-task-metadata',
    content: 'Improve trace discoverability with task metadata\n\nFull task body must not be copied.',
    filePath: '/project/.takt/tasks.yaml',
    createdAt: '2026-06-14T00:00:00.000Z',
    status: 'pending',
    worktreePath: '/stale/worktree/path',
    data: {
      task: 'Improve trace discoverability with task metadata',
      workflow: 'default',
      source: 'issue',
      issue: 827,
      branch: 'takt/stale-branch',
      base_branch: 'develop',
    },
    ...overrides,
  };
}

describe('buildTraceTaskMetadata', () => {
  it('uses task record metadata and resolved execution paths for pending task traces', () => {
    const metadata = buildTraceTaskMetadata({
      task: createTask({
        data: {
          task: 'Improve trace discoverability with task metadata',
          workflow: 'default',
          source: 'pr_review',
          pr_number: 826,
          issue: 827,
          branch: 'takt/stale-branch',
          base_branch: 'develop',
        },
      }),
      taskContent: 'Ignored because task summary exists',
      branch: 'takt/827/add-trace-task-metadata',
      baseBranch: 'main',
      worktreePath: '/project/.takt/worktrees/task-827',
    });

    expect(metadata).toEqual({
      taskName: 'task-827',
      taskSlug: 'add-trace-task-metadata',
      taskSummary: 'Improve trace discoverability with task metadata',
      taskSource: 'pr_review',
      issueNumber: 827,
      prNumber: 826,
      gitBranch: 'takt/827/add-trace-task-metadata',
      gitBaseBranch: 'main',
      worktreePath: '/project/.takt/worktrees/task-827',
    });
  });

  it('uses the saved task summary before task_dir wrapper content', () => {
    const metadata = buildTraceTaskMetadata({
      task: createTask({
        summary: 'Saved issue summary',
        content: 'Implement using only the files in `.takt/runs/context/task`.',
        taskDir: '.takt/tasks/saved-issue-summary',
        data: {
          task: 'Implement using only the files in `.takt/runs/context/task`.',
          workflow: 'default',
          source: 'issue',
          issue: 827,
        },
      }),
      taskContent: 'Primary spec: `.takt/runs/context/task/order.md`.',
    });

    expect(metadata).toMatchObject({
      taskSummary: 'Saved issue summary',
      taskSource: 'issue',
      issueNumber: 827,
    });
  });

  it('derives manual task summary from the first line without copying the full body', () => {
    const longFirstLine = 'a'.repeat(90);

    const metadata = buildTraceTaskMetadata({
      taskContent: `${longFirstLine}\nsecret second line`,
      taskSlug: 'manual-trace-task',
      branch: 'takt/manual-trace-task',
    });

    expect(metadata).toEqual({
      taskSlug: 'manual-trace-task',
      taskSummary: 'a'.repeat(80),
      taskSource: 'manual',
      gitBranch: 'takt/manual-trace-task',
    });
  });

  it('derives source from PR or issue numbers when an explicit source is absent', () => {
    expect(buildTraceTaskMetadata({
      taskContent: 'Review PR comments',
      prNumber: 826,
      branch: 'feature/pr-826',
      baseBranch: 'main',
    })).toMatchObject({
      taskSource: 'pr_review',
      prNumber: 826,
      gitBranch: 'feature/pr-826',
      gitBaseBranch: 'main',
    });

    expect(buildTraceTaskMetadata({
      taskContent: 'Fix issue',
      issueNumber: 792,
    })).toMatchObject({
      taskSource: 'issue',
      issueNumber: 792,
    });
  });
});
