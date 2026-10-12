import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskListItem } from '../infra/task/index.js';

const {
  mockExistsSync,
  mockConfirmWithCancel,
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
  mockCompletePublishedTask,
  mockFindExistingPr,
  mockSuccess,
  mockRunGitCommandAbortable,
  mockCreatePrCloneGitOperations,
  mockCheckForkThreats,
  mockAssertReusableWorktreePath,
  mockRecordPrMergePushedHead,
  mockFetchPrDetails,
  mockPushPrMergeHead,
} = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockConfirmWithCancel: vi.fn(),
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
  mockCompletePublishedTask: vi.fn(),
  mockFindExistingPr: vi.fn(),
  mockSuccess: vi.fn(),
  mockRunGitCommandAbortable: vi.fn(),
  mockCreatePrCloneGitOperations: vi.fn(),
  mockCheckForkThreats: vi.fn(),
  mockAssertReusableWorktreePath: vi.fn(),
  mockRecordPrMergePushedHead: vi.fn(),
  mockFetchPrDetails: vi.fn(),
  mockPushPrMergeHead: vi.fn(),
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
  TaskRunner: class {
    completePublishedTask = mockCompletePublishedTask;
    recordPrMergePushedHead = mockRecordPrMergePushedHead;
  },
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

vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({
  assertReusableWorktreePath: mockAssertReusableWorktreePath,
}));

vi.mock('../infra/task/clone-exec.js', () => ({
  runGitCommandAbortable: mockRunGitCommandAbortable,
}));

vi.mock('../infra/task/git-environment.js', () => ({
  buildSafeGitEnvironment: vi.fn(async () => ({})),
}));

vi.mock('../infra/workflow/system/pr-clone-git.js', () => ({
  createPrCloneGitOperations: mockCreatePrCloneGitOperations,
}));

vi.mock('../features/merge/threat-check.js', () => ({
  checkForkThreats: mockCheckForkThreats,
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirm: vi.fn().mockResolvedValue(false),
  confirmWithCancel: (...args: unknown[]) => mockConfirmWithCancel(...args),
}));

vi.mock('../shared/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  info: (...args: unknown[]) => mockInfo(...args),
  error: (...args: unknown[]) => mockError(...args),
  success: (...args: unknown[]) => mockSuccess(...args),
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

const oldHeadSha = 'a'.repeat(40);
const newHeadSha = 'b'.repeat(40);
const mergeTask: TaskListItem = {
  ...failedTask,
  name: 'merge-pr-123',
  branch: 'feature/pr-123',
  worktreePath: '/worktree/merge-pr-123',
  data: {
    task: 'Merge PR #123', source: 'pr_review', pr_number: 123,
    branch: 'feature/pr-123', base_branch: 'main', workflow: 'merge-review-fix-simple',
    merge_task: true, merge_method: 'squash', worktree: true,
    merge_head_repository_url: 'https://example.test/fork.git',
    merge_head_repository_push_urls: ['https://example.test/fork.git'],
    merge_initial_head_sha: oldHeadSha, merge_clone_prepared: true,
    merge_threat_check_max_diff_bytes: 1024, merge_caccia_required: false,
  },
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
    mockConfirmWithCancel.mockResolvedValue({ kind: 'value', value: true });
    mockStageAndCommit.mockResolvedValue('commit-123');
    mockCreatePullRequestSafely.mockReturnValue({ success: true, url: 'https://example.test/pr/1' });
    mockFindExistingPr.mockReturnValue(undefined);
    mockCompletePublishedTask.mockReset();
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
        return cwd.includes('completed') ? 'takt/completed-task\n'
          : cwd.includes('merge-pr') ? 'feature/pr-123\n' : 'takt/failed-task\n';
      }
      if (gitArgs[0] === 'branch' && gitArgs[1] === '--show-current') {
        return cwd.includes('completed') ? 'takt/completed-task\n'
          : cwd.includes('merge-pr') ? 'feature/pr-123\n' : 'takt/failed-task\n';
      }
      if (gitArgs[0] === 'remote') {
        return 'origin\n';
      }
      return '';
    });
    mockFetchPrDetails.mockImplementation(async () => ({
      number: 123, headBranch: 'feature/pr-123', baseBranch: 'main',
      headSha: mockPushPrMergeHead.mock.calls.length > 0 ? newHeadSha : oldHeadSha,
      headRepositoryUrl: 'https://example.test/fork.git',
      headRepositoryPushUrls: ['https://example.test/fork.git'], sameRepository: true,
    }));
    mockGetGitProvider.mockReturnValue({ findExistingPr: mockFindExistingPr, fetchPrDetails: mockFetchPrDetails });
    mockRunGitCommandAbortable.mockImplementation(async (cwd, args) => {
      const gitArgs = args as string[];
      if (cwd === '/project' && gitArgs[0] === 'remote' && gitArgs.length === 1) return { stdout: 'origin\n', stderr: '' };
      if (cwd === '/project' && gitArgs[0] === 'remote') return { stdout: 'https://example.test/base.git\n', stderr: '' };
      if (gitArgs[0] === 'remote' && gitArgs[2] === 'origin') return { stdout: 'https://example.test/fork.git\n', stderr: '' };
      if (gitArgs[0] === 'remote' && gitArgs[2] === 'base') return { stdout: 'https://example.test/base.git\n', stderr: '' };
      if (gitArgs[0] === 'rev-parse') return { stdout: `${newHeadSha}\n`, stderr: '' };
      throw new Error(`Unexpected git command: ${gitArgs.join(' ')}`);
    });
    mockCreatePrCloneGitOperations.mockImplementation(async () => ({
      operations: { push: mockPushPrMergeHead },
    }));
    mockPushPrMergeHead.mockResolvedValue(undefined);
    mockCheckForkThreats.mockResolvedValue({ passed: true });
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

  it('failed merge task は確認後に保存済みPRのheadだけを更新し、push履歴を保存する', async () => {
    expect(await createPullRequestForTask('/project', mergeTask)).toBe(true);

    expect(mockAssertReusableWorktreePath).toHaveBeenCalledWith('/project', mergeTask.worktreePath);
    expect(mockConfirmWithCancel).toHaveBeenCalledWith(expect.stringContaining('既存の PR を更新'), false);
    expect(mockStageAndCommit).toHaveBeenCalledOnce();
    expect(mockCreatePrCloneGitOperations).toHaveBeenCalledWith(expect.objectContaining({
      cwd: mergeTask.worktreePath,
      headRepositoryUrl: 'https://example.test/fork.git',
      headRepositoryPushUrls: ['https://example.test/fork.git'],
      baseRepositoryUrl: 'https://example.test/base.git',
    }));
    expect(mockPushPrMergeHead).toHaveBeenCalledWith('HEAD:refs/heads/feature/pr-123');
    expect(mockRecordPrMergePushedHead).toHaveBeenCalledWith(mergeTask.name, newHeadSha, oldHeadSha);
    expect(mockRecordPrMergePushedHead.mock.invocationCallOrder[0])
      .toBeLessThan(mockPushPrMergeHead.mock.invocationCallOrder[0]!);
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
    expect(mockFindExistingPr).not.toHaveBeenCalled();
    expect(mockCompletePublishedTask).not.toHaveBeenCalled();
  });

  it('failed merge task をキャンセルするとcommitとpushを行わない', async () => {
    mockConfirmWithCancel.mockResolvedValue({ kind: 'cancelled' });

    expect(await createPullRequestForTask('/project', mergeTask)).toBe(false);

    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockPushPrMergeHead).not.toHaveBeenCalled();
    expect(mockRecordPrMergePushedHead).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
  });

  it('複数公開先の途中でpushが失敗してもretry用のheadを保存する', async () => {
    const pushedUrls: string[] = [];
    const task = { ...mergeTask, data: {
      ...mergeTask.data!,
      merge_head_repository_push_urls: ['https://example.test/fork.git', 'https://example.test/mirror.git'],
    } };
    mockFetchPrDetails.mockImplementation(async () => ({
      number: 123, headBranch: 'feature/pr-123', baseBranch: 'main', headSha: oldHeadSha,
      headRepositoryUrl: 'https://example.test/fork.git',
      headRepositoryPushUrls: task.data.merge_head_repository_push_urls, sameRepository: true,
    }));
    mockCreatePrCloneGitOperations.mockImplementation(async ({ headRepositoryPushUrls }) => ({
      operations: { push: async () => {
        pushedUrls.push(headRepositoryPushUrls[0]);
        throw new Error('second push target failed');
      } },
    }));

    expect(await createPullRequestForTask('/project', task)).toBe(false);

    expect(pushedUrls).toEqual(['https://example.test/fork.git']);
    expect(mockRecordPrMergePushedHead).toHaveBeenCalledWith(task.name, newHeadSha, oldHeadSha);
    expect(mockFetchPrDetails).toHaveBeenCalledTimes(2);
  });

  it('push後のPR head再取得に失敗してもretry用のheadを保存する', async () => {
    const fetchPrDetails = mockFetchPrDetails.getMockImplementation()!;
    mockFetchPrDetails.mockImplementationOnce(fetchPrDetails)
      .mockImplementationOnce(fetchPrDetails)
      .mockRejectedValueOnce(new Error('PR head lookup failed'));

    expect(await createPullRequestForTask('/project', mergeTask)).toBe(false);

    expect(mockPushPrMergeHead).toHaveBeenCalledOnce();
    expect(mockRecordPrMergePushedHead).toHaveBeenCalledWith(mergeTask.name, newHeadSha, oldHeadSha);
    expect(mockRecordPrMergePushedHead.mock.invocationCallOrder[0])
      .toBeLessThan(mockPushPrMergeHead.mock.invocationCallOrder[0]!);
    expect(mockFetchPrDetails).toHaveBeenCalledTimes(3);
  });

  it('PR headが確認後に変わった場合はfailed merge taskからpushしない', async () => {
    mockFetchPrDetails.mockImplementationOnce(async () => ({
      number: 123, headBranch: 'feature/pr-123', baseBranch: 'main', headSha: oldHeadSha,
      headRepositoryUrl: 'https://example.test/fork.git',
      headRepositoryPushUrls: ['https://example.test/fork.git'], sameRepository: true,
    })).mockImplementationOnce(async () => ({
      number: 123, headBranch: 'feature/pr-123', baseBranch: 'main', headSha: newHeadSha,
      headRepositoryUrl: 'https://example.test/fork.git',
      headRepositoryPushUrls: ['https://example.test/fork.git'], sameRepository: true,
    }));

    expect(await createPullRequestForTask('/project', mergeTask)).toBe(false);
    expect(mockPushPrMergeHead).not.toHaveBeenCalled();
    expect(mockRecordPrMergePushedHead).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
  });

  it('保存済みPRのhead repositoryが変わった場合は確認前に停止する', async () => {
    mockFetchPrDetails.mockResolvedValue({
      number: 123, headBranch: 'feature/pr-123', baseBranch: 'main', headSha: oldHeadSha,
      headRepositoryUrl: 'https://example.test/other.git',
      headRepositoryPushUrls: ['https://example.test/other.git'], sameRepository: true,
    });

    expect(await createPullRequestForTask('/project', mergeTask)).toBe(false);
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockPushPrMergeHead).not.toHaveBeenCalled();
  });

  it('merge cloneのoriginが保存済みPRと違う場合は確認前に停止する', async () => {
    const runGit = mockRunGitCommandAbortable.getMockImplementation()!;
    mockRunGitCommandAbortable.mockImplementation(async (cwd, args, ...rest) => {
      if (cwd === mergeTask.worktreePath && (args as string[]).join(' ') === 'remote get-url origin') {
        return { stdout: 'https://example.test/other.git\n', stderr: '' };
      }
      return runGit(cwd, args, ...rest);
    });

    expect(await createPullRequestForTask('/project', mergeTask)).toBe(false);
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockPushPrMergeHead).not.toHaveBeenCalled();
  });

  it('fork PRの脅威検査が通らない場合はpushせず既存PRを保持する', async () => {
    mockFetchPrDetails.mockImplementation(async () => ({
      number: 123, headBranch: 'feature/pr-123', baseBranch: 'main', headSha: oldHeadSha,
      headRepositoryUrl: 'https://example.test/fork.git',
      headRepositoryPushUrls: ['https://example.test/fork.git'], sameRepository: false,
    }));
    mockCheckForkThreats.mockResolvedValue({ passed: false, comment: 'Threat check failed' });

    expect(await createPullRequestForTask('/project', mergeTask)).toBe(false);
    expect(mockCheckForkThreats).toHaveBeenCalledWith(expect.objectContaining({
      cwd: mergeTask.worktreePath, baseRef: 'refs/takt/pr-base/main', maxDiffBytes: 1024,
    }));
    expect(mockPushPrMergeHead).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
  });

  it('fork PRは保存済みheadの公開先へ脅威検査後にpushする', async () => {
    mockFetchPrDetails.mockImplementation(async () => ({
      number: 123, headBranch: 'feature/pr-123', baseBranch: 'main',
      headSha: mockPushPrMergeHead.mock.calls.length > 0 ? newHeadSha : oldHeadSha,
      headRepositoryUrl: 'https://example.test/fork.git',
      headRepositoryPushUrls: ['https://example.test/fork.git'], sameRepository: false,
    }));

    expect(await createPullRequestForTask('/project', mergeTask)).toBe(true);

    expect(mockCheckForkThreats).toHaveBeenCalledWith(expect.objectContaining({
      cwd: mergeTask.worktreePath, projectCwd: '/project',
      baseRef: 'refs/takt/pr-base/main', maxDiffBytes: 1024,
    }));
    expect(mockCheckForkThreats.mock.invocationCallOrder[0])
      .toBeLessThan(mockPushPrMergeHead.mock.invocationCallOrder[0]!);
    expect(mockCreatePrCloneGitOperations).toHaveBeenCalledWith(expect.objectContaining({
      headRepositoryPushUrls: ['https://example.test/fork.git'],
    }));
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'pr_failed'] as const)('should cancel %s publication before any write on Escape', async (kind) => {
    mockConfirmWithCancel.mockResolvedValue({ kind: 'cancelled' });

    await expect(createPullRequestForTask('/project', { ...failedTask, kind })).resolves.toBe(false);

    expect(mockConfirmWithCancel).toHaveBeenCalledOnce();
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
    expect(mockCompletePublishedTask).not.toHaveBeenCalled();
    expect(mockExecFileSync.mock.calls.some(([, args]) =>
      (args as string[]).some((arg) => arg === 'push' || arg === 'fetch'),
    )).toBe(false);
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
    mockConfirmWithCancel.mockResolvedValue({ kind: 'value', value: false });

    await createPullRequestForTask('/project', failedTask);

    expect(mockConfirmWithCancel).toHaveBeenCalled();
    const preview = mockInfo.mock.calls.flatMap(([message]) => String(message));
    expect(preview.join('\n')).toContain('evidence.md');
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
    const commands = mockExecFileSync.mock.calls.map(([, args]) => args as string[]);
    expect(commands.every((args) => !['fetch', 'push', 'commit'].includes(args[0]!))).toBe(true);
    expect(mockResolveAutoCommitOptions).not.toHaveBeenCalled();
  });

  it('pr_failed publication retry completes the task only after push and PR creation succeed', async () => {
    const task: TaskListItem = { ...failedTask, kind: 'pr_failed' };
    mockStageAndCommit.mockResolvedValue(undefined);

    const result = await createPullRequestForTask('/project', task);

    expect(result).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['push', 'origin', task.branch], expect.objectContaining({
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
    }));
    expect(mockCompletePublishedTask).toHaveBeenCalledWith(task.name, 'https://example.test/pr/1');
    expect(mockCompletePublishedTask.mock.invocationCallOrder[0])
      .toBeGreaterThan(mockCreatePullRequestSafely.mock.invocationCallOrder[0]!);
  });

  it('reports a created PR when state persistence fails and reuses that PR on retry', async () => {
    const task: TaskListItem = { ...failedTask, kind: 'pr_failed' };
    const prUrl = 'https://example.test/pr/1';
    mockStageAndCommit.mockResolvedValue(undefined);
    mockCompletePublishedTask.mockImplementationOnce(() => {
      throw new Error('disk full\x1b]0;injected\x07');
    });
    mockFindExistingPr
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ number: 1, url: prUrl });

    expect(await createPullRequestForTask('/project', task)).toBe(false);

    expect(mockSuccess).toHaveBeenCalledWith(expect.stringContaining(prUrl));
    expect(mockSuccess.mock.invocationCallOrder[0])
      .toBeLessThan(mockCompletePublishedTask.mock.invocationCallOrder[0]!);
    const failureMessage = String(mockError.mock.calls[0]?.[0]);
    expect(failureMessage).toContain(task.name);
    expect(failureMessage).toContain('completed');
    expect(failureMessage).toContain('pr_failed');
    expect(failureMessage).toContain('disk full');
    expect(failureMessage).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);

    expect(await createPullRequestForTask('/project', task)).toBe(true);

    expect(mockFindExistingPr).toHaveBeenNthCalledWith(1, task.branch, '/project');
    expect(mockFindExistingPr).toHaveBeenNthCalledWith(2, task.branch, '/project');
    expect(mockCreatePullRequestSafely).toHaveBeenCalledTimes(1);
    expect(mockCompletePublishedTask).toHaveBeenNthCalledWith(1, task.name, prUrl);
    expect(mockCompletePublishedTask).toHaveBeenNthCalledWith(2, task.name, prUrl);
    expect(mockSuccess).toHaveBeenLastCalledWith(expect.stringContaining(prUrl));
    expect(mockError).toHaveBeenCalledTimes(1);
  });

  it.each(['cancel', 'commit', 'push', 'pr'] as const)('pr_failed retry preserves its status when %s does not succeed', async (stage) => {
    const task: TaskListItem = { ...failedTask, kind: 'pr_failed' };
    if (stage === 'cancel') mockConfirmWithCancel.mockResolvedValue({ kind: 'value', value: false });
    if (stage === 'commit') mockStageAndCommit.mockRejectedValue(new Error('commit failed'));
    if (stage === 'push') {
      const gitImplementation = mockExecFileSync.getMockImplementation()!;
      mockExecFileSync.mockImplementation((command, args, options) => {
        if ((args as string[])[0] === 'push') throw new Error('terminal prompts disabled');
        return gitImplementation(command, args, options);
      });
    }
    if (stage === 'pr') mockCreatePullRequestSafely.mockReturnValue({ success: false, error: 'PR failed' });

    expect(await createPullRequestForTask('/project', task)).toBe(false);

    expect(mockCompletePublishedTask).not.toHaveBeenCalled();
    if (stage !== 'pr') expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed'] as const)('PR creation does not change the workflow status of a %s task', async (kind) => {
    expect(await createPullRequestForTask('/project', { ...failedTask, kind })).toBe(true);
    expect(mockCompletePublishedTask).not.toHaveBeenCalled();
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
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
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
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
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
    expect(mockConfirmWithCancel).not.toHaveBeenCalled();
    expect(mockStageAndCommit).not.toHaveBeenCalled();
    expect(mockResolveAutoCommitOptions).not.toHaveBeenCalled();
    expect(mockCreatePullRequestSafely).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
