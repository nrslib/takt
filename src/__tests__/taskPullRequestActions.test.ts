import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/index.js';

const {
  mockExistsSync,
  mockConfirm,
  mockStageAndCommit,
  mockCreatePullRequestSafely,
  mockGetGitProvider,
  mockResolveAutoCommitOptions,
  mockCollectTaskWorktreeSummary,
  mockFindRunForTask,
  mockLoadRunSessionContext,
  mockExecFileSync,
  mockInfo,
  mockError,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockConfirm: vi.fn(),
  mockStageAndCommit: vi.fn(),
  mockCreatePullRequestSafely: vi.fn(),
  mockGetGitProvider: vi.fn(),
  mockResolveAutoCommitOptions: vi.fn(),
  mockCollectTaskWorktreeSummary: vi.fn(),
  mockFindRunForTask: vi.fn(),
  mockLoadRunSessionContext: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageAndCommit: (...args: unknown[]) => mockStageAndCommit(...args),
  resolveAutoCommitOptions: (...args: unknown[]) => mockResolveAutoCommitOptions(...args),
}));

vi.mock('../infra/task/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stageAndCommit: (...args: unknown[]) => mockStageAndCommit(...args),
}));

vi.mock('../infra/git/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGitProvider: () => mockGetGitProvider(),
  createPullRequestSafely: (...args: unknown[]) => mockCreatePullRequestSafely(...args),
}));

vi.mock('../features/interactive/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  findRunForTask: (...args: unknown[]) => mockFindRunForTask(...args),
  loadRunSessionContext: (...args: unknown[]) => mockLoadRunSessionContext(...args),
}));

vi.mock('../features/tasks/list/taskWorktreeSummary.js', () => ({
  collectTaskWorktreeSummary: (...args: unknown[]) => mockCollectTaskWorktreeSummary(...args),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  info: (...args: unknown[]) => mockInfo(...args),
  error: (...args: unknown[]) => mockError(...args),
}));

import { createPullRequestForTask } from '../features/tasks/list/taskPullRequestActions.js';

const failedTask: TaskListItem = {
  kind: 'failed',
  name: 'failed-task',
  createdAt: '2026-08-15T00:00:00.000Z',
  filePath: '/project/.takt/tasks/failed-task.md',
  content: '修正する',
  runSlug: 'failed-run',
  branch: 'takt/failed-task',
  worktreePath: '/worktree/failed-task',
  data: { task: '修正する\n追加条件を確認する' },
};

const runSessionContext = {
  task: '修正する',
  workflow: 'default',
  status: 'failed',
  stepLogs: [],
  reports: [{
    filename: 'review-resolution.md',
    content: [
      '## Requirement Decision Grounds',
      '| Subject | Status | Grounds |',
      '|---|---|---|',
      '| failed instruct が worktree で実行できる | Fulfilled | peer-review: APPROVE |',
      '## Finding Dispositions',
      '| Finding ID / Source | Disposition | Basis |',
      '|---|---|---|',
      '| FINDING-1 | Unresolved | peer-review: APPROVE |',
      '## Re-evaluation of Prior Findings',
      '- peer-review: APPROVE',
      '## Reason the Decision Cannot Be Made (when BLOCKED)',
      '- npm run test:e2e:mock',
    ].join('\n'),
  }],
};

describe('createPullRequestForTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockConfirm.mockResolvedValue(true);
    mockStageAndCommit.mockResolvedValue('commit-123');
    mockCreatePullRequestSafely.mockReturnValue({ success: true, url: 'https://example.test/pr/1' });
    mockGetGitProvider.mockReturnValue({});
    mockResolveAutoCommitOptions.mockReturnValue({
      allowGitHooks: false,
      allowGitFilters: false,
    });
    mockCollectTaskWorktreeSummary.mockReturnValue({
      files: ['src/app.ts', 'evidence.md'],
      text: ' M src/app.ts\n?? evidence.md',
    });
    mockFindRunForTask.mockReturnValue(null);
    mockLoadRunSessionContext.mockReturnValue(runSessionContext);
    mockExecFileSync.mockImplementation((_command, args, options) => {
      const gitArgs = args as string[];
      const cwd = (options as { cwd?: string } | undefined)?.cwd ?? '';
      if (gitArgs[0] === 'rev-parse' && gitArgs.includes('--abbrev-ref')) {
        return cwd.includes('completed') ? 'takt/completed-task\n' : 'takt/failed-task\n';
      }
      if (gitArgs[0] === 'branch' && gitArgs[1] === '--show-current') {
        return cwd.includes('completed') ? 'takt/completed-task\n' : 'takt/failed-task\n';
      }
      if (gitArgs[0] === 'remote') {
        return 'origin\n';
      }
      return '';
    });
  });

  it('承認後に failed task の commit、公開、PR作成を順に実行する', async () => {
    const events: string[] = [];
    mockStageAndCommit.mockImplementation(async () => {
      events.push('commit');
      return 'commit-123';
    });
    mockExecFileSync.mockImplementation((_command, args, _options) => {
      events.push('git');
      const gitArgs = args as string[];
      if (gitArgs[0] === 'remote') {
        return 'origin\n';
      }
      if (gitArgs[0] === 'rev-parse' && gitArgs.includes('--abbrev-ref')) {
        return 'takt/failed-task\n';
      }
      if (gitArgs[0] === 'branch' && gitArgs[1] === '--show-current') {
        return 'takt/failed-task\n';
      }
      if (gitArgs[0] === 'push') {
        return '';
      }
      return '';
    });
    mockCreatePullRequestSafely.mockImplementation(() => {
      events.push('pr');
      return { success: true, url: 'https://example.test/pr/1' };
    });

    await createPullRequestForTask('/project', failedTask);

    expect(mockStageAndCommit).toHaveBeenCalledWith(
      '/worktree/failed-task',
      'takt: failed-task',
      { allowGitHooks: false, allowGitFilters: false },
    );
    expect(events.indexOf('commit')).toBeGreaterThanOrEqual(0);
    const commitIndex = events.indexOf('commit');
    const lastGitIndex = events.lastIndexOf('git');
    const prIndex = events.indexOf('pr');
    expect(lastGitIndex).toBeGreaterThan(commitIndex);
    expect(prIndex).toBeGreaterThan(lastGitIndex);

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['remote'],
      expect.objectContaining({ cwd: '/worktree/failed-task' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'takt/failed-task'],
      expect.objectContaining({ cwd: '/worktree/failed-task' }),
    );

    const [, prOptions, prCwd] = mockCreatePullRequestSafely.mock.calls[0] as [
      unknown,
      { branch: string; body: string },
      string,
    ];
    expect(prOptions.branch).toBe('takt/failed-task');
    expect(prOptions.body).toContain('failed instruct が worktree で実行できる');
    expect(prOptions.body).toContain('npm run test:e2e:mock');
    expect(prOptions.body).toContain('後続ゲートは PR CI');
    expect(prCwd).toBe('/project');
    expect(mockInfo.mock.calls.map(([message]) => String(message)).join('\n')).toContain(prOptions.body);
  });

  it('previewだけをterminal-safeにし、PR APIには元の本文を渡す', async () => {
    const hostileBranch = 'takt/failed-task\x1b]0;title\x07';
    const hostileFile = 'src/unsafe\x1b]0;title\x07.ts';
    const hostileBody = 'fulfilled requirement\x1b[2Jbody';
    const taskWithHostileValues: TaskListItem = {
      ...failedTask,
      branch: hostileBranch,
    };
    mockCollectTaskWorktreeSummary.mockReturnValue({
      files: [hostileFile],
      text: ' M src/app.ts',
    });
    mockLoadRunSessionContext.mockReturnValue({
      ...runSessionContext,
      reports: [{
        filename: 'review-resolution.md',
        content: [
          '## Requirement Decision Grounds',
          '| Subject | Status | Grounds |',
          '|---|---|---|',
          `| ${hostileBody} | Fulfilled | verified |`,
        ].join('\n'),
      }],
    });
    mockExecFileSync.mockImplementation((_command, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === 'rev-parse' || gitArgs[0] === 'branch') {
        return `${hostileBranch}\n`;
      }
      if (gitArgs[0] === 'remote') {
        return 'origin\n';
      }
      return '';
    });

    await createPullRequestForTask('/project', taskWithHostileValues);

    const preview = mockInfo.mock.calls.map(([message]) => String(message)).join('\n');
    expect(preview).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    expect(preview).toContain('unsafe.ts');
    expect(preview).toContain('fulfilled requirementbody');

    const [, prOptions] = mockCreatePullRequestSafely.mock.calls[0] as [
      unknown,
      { body: string },
    ];
    expect(prOptions.body).toContain(hostileBody);
  });

  it('cleanな completed task は新規commitなしで既存branchを公開してPRを作成する', async () => {
    const completedTask: TaskListItem = {
      ...failedTask,
      kind: 'completed',
      name: 'completed-task',
      runSlug: 'completed-run',
      branch: 'takt/completed-task',
      worktreePath: '/worktree/completed-task',
    };
    mockStageAndCommit.mockResolvedValue(undefined);

    await createPullRequestForTask('/project', completedTask);

    expect(mockStageAndCommit).toHaveBeenCalledWith(
      '/worktree/completed-task',
      'takt: completed-task',
      { allowGitHooks: false, allowGitFilters: false },
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'takt/completed-task'],
      expect.objectContaining({ cwd: '/worktree/completed-task' }),
    );
    expect(mockCreatePullRequestSafely).toHaveBeenCalled();
    const [, prOptions] = mockCreatePullRequestSafely.mock.calls[0] as [
      unknown,
      { branch: string; body: string },
    ];
    expect(prOptions.branch).toBe('takt/completed-task');
    expect(prOptions.body).not.toContain('後続ゲートは PR CI');
  });

  it('previewを拒否した場合は commit、fetch、push、PR作成を実行しない', async () => {
    mockConfirm.mockResolvedValue(false);

    await createPullRequestForTask('/project', failedTask);

    expect(mockConfirm).toHaveBeenCalled();
    const preview = mockInfo.mock.calls.flatMap(([message]) => String(message));
    expect(preview.join('\n')).toContain('evidence.md');
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
    const commands = mockExecFileSync.mock.calls.map(([, args]) => args as string[]);
    expect(commands.every((args) => !['fetch', 'push', 'commit'].includes(args[0]!))).toBe(true);
    expect(mockResolveAutoCommitOptions).not.toHaveBeenCalled();
  });

  it('projectのcommit policyを具体値のままstageAndCommitへ渡す', async () => {
    mockResolveAutoCommitOptions.mockReturnValue({
      allowGitHooks: true,
      allowGitFilters: true,
    });

    await createPullRequestForTask('/project', failedTask);

    expect(mockResolveAutoCommitOptions).toHaveBeenCalledWith('/project');
    expect(mockStageAndCommit).toHaveBeenCalledWith(
      '/worktree/failed-task',
      'takt: failed-task',
      { allowGitHooks: true, allowGitFilters: true },
    );
  });

  it.each([
    ['LF', 'first line  \nsecond line'],
    ['CRLF', 'first line  \r\nsecond line'],
  ])('summaryがない場合は task.content の%s先頭行をPRタイトルにする', async (_label, content) => {
    await createPullRequestForTask('/project', {
      ...failedTask,
      summary: undefined,
      content,
    });

    const [, prOptions] = mockCreatePullRequestSafely.mock.calls[0] as [
      unknown,
      { title: string },
    ];
    expect(prOptions.title).toBe('first line');
  });

  it('summaryがない場合もPRタイトルの100文字制限を維持する', async () => {
    const firstLine = 'x'.repeat(120);

    await createPullRequestForTask('/project', {
      ...failedTask,
      summary: undefined,
      content: `${firstLine}\nsecond line`,
    });

    const [, prOptions] = mockCreatePullRequestSafely.mock.calls[0] as [
      unknown,
      { title: string },
    ];
    expect(prOptions.title).toBe(`${'x'.repeat(97)}...`);
    expect(prOptions.title).toHaveLength(100);
  });

  it('stageAndCommit の失敗をPR作成境界で報告し、PR APIを呼ばない', async () => {
    mockStageAndCommit.mockRejectedValue(new Error('commit failed'));

    const result = await createPullRequestForTask('/project', failedTask);

    expect(result).toBe(false);
    expect(String(mockError.mock.calls[0]?.[0])).toContain('commit failed');
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
  });

  it('publishTaskBranch の失敗をPR作成境界で報告し、PR APIを呼ばない', async () => {
    mockExecFileSync.mockImplementation((_command, args, _options) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === 'rev-parse' && gitArgs.includes('--abbrev-ref')) {
        return 'takt/failed-task\n';
      }
      if (gitArgs[0] === 'remote') {
        return 'origin\n';
      }
      if (gitArgs[0] === 'push') {
        throw new Error('push failed');
      }
      return '';
    });

    const result = await createPullRequestForTask('/project', failedTask);

    expect(result).toBe(false);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['push', 'origin', 'takt/failed-task'],
      expect.objectContaining({ cwd: '/worktree/failed-task' }),
    );
    expect(String(mockError.mock.calls[0]?.[0])).toContain('push failed');
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
  });

  it('PR作成準備の失敗を報告し、確認や副作用を開始しない', async () => {
    mockCollectTaskWorktreeSummary.mockImplementation(() => {
      throw new Error('summary failed\x1b]0;injected\x07');
    });

    const result = await createPullRequestForTask('/project', failedTask);

    expect(result).toBe(false);
    expect(String(mockError.mock.calls[0]?.[0])).toContain('summary failed');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
    const commands = mockExecFileSync.mock.calls.map(([, args]) => args as string[]);
    expect(commands.every((args) => !['fetch', 'push', 'commit'].includes(args[0]!))).toBe(true);
  });

  it('commit失敗の表示から端末制御文字を除去し、PR APIを呼ばない', async () => {
    mockStageAndCommit.mockRejectedValue(new Error('commit failed\x1b]0;injected\x07'));

    const result = await createPullRequestForTask('/project', failedTask);

    expect(result).toBe(false);
    const errorMessage = String(mockError.mock.calls[0]?.[0]);
    expect(errorMessage).toContain('commit failed');
    expect(errorMessage).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
  });

  it('run_slugがない場合も全文task一致runを検索して本文のreportを解決する', async () => {
    const taskWithoutRunSlug: TaskListItem = {
      ...failedTask,
      runSlug: undefined,
    };
    mockFindRunForTask.mockReturnValue('fallback-run');

    await createPullRequestForTask('/project', taskWithoutRunSlug);

    expect(mockFindRunForTask).toHaveBeenCalledWith(
      '/worktree/failed-task',
      '修正する\n追加条件を確認する',
    );
    expect(mockLoadRunSessionContext).toHaveBeenCalledWith('/worktree/failed-task', 'fallback-run');
    const [, prOptions] = mockCreatePullRequestSafely.mock.calls[0] as [
      unknown,
      { body: string },
    ];
    expect(prOptions.body).toContain('failed instruct が worktree で実行できる');
  });

  it('表示prefixだけが一致する別runのreportを本文へ含めない', async () => {
    const fullTask = 'x'.repeat(81);
    const taskWithoutRunSlug: TaskListItem = {
      ...failedTask,
      runSlug: undefined,
      content: 'x'.repeat(80),
      data: { task: fullTask },
    };
    mockFindRunForTask.mockReturnValue(null);

    await createPullRequestForTask('/project', taskWithoutRunSlug);

    expect(mockFindRunForTask).toHaveBeenCalledWith(
      '/worktree/failed-task',
      fullTask,
    );
    expect(mockLoadRunSessionContext).not.toHaveBeenCalled();
    const [, prOptions] = mockCreatePullRequestSafely.mock.calls[0] as [
      unknown,
      { body: string },
    ];
    expect(prOptions.body).not.toContain('failed instruct が worktree で実行できる');
    expect(prOptions.body).not.toContain('後続ゲートは PR CI');
  });

  it.each([
    ['別のbranch', 'takt/other'],
    ['detached HEAD', 'HEAD'],
  ])('branch identityが%sなら副作用を開始しない', async (_label, currentBranch) => {
    mockExecFileSync.mockImplementation((_, args) => {
      const gitArgs = args as string[];
      if (gitArgs[0] === 'rev-parse' && gitArgs.includes('--abbrev-ref')) {
        return `${currentBranch}\n`;
      }
      return '';
    });

    const result = await createPullRequestForTask('/project', failedTask);

    expect(result).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockResolveAutoCommitOptions).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
    const commands = mockExecFileSync.mock.calls.map(([, args]) => args as string[]);
    expect(commands.every((args) => !['fetch', 'push', 'commit'].includes(args[0]!))).toBe(true);
  });

  it('branch未設定なら例外や副作用を発生させずに拒否する', async () => {
    const result = await createPullRequestForTask('/project', {
      ...failedTask,
      branch: undefined,
    });

    expect(result).toBe(false);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockResolveAutoCommitOptions).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
