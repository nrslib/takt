import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergePr } from '../infra/github/pr.js';
import { mergePrEffect } from '../infra/workflow/system/system-pr-effects.js';
import { GitHubProvider } from '../infra/github/GitHubProvider.js';
import { GitLabProvider } from '../infra/gitlab/GitLabProvider.js';
import type { SystemStepGitProvider } from '../core/workflow/system/system-step-services.js';

const { execFileSync, checkGhCli } = vi.hoisted(() => ({ execFileSync: vi.fn(), checkGhCli: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync, execFile: vi.fn() }));
vi.mock('../infra/github/issue.js', () => ({ checkGhCli }));

function provider(): SystemStepGitProvider {
  return {
    checkCliStatus: vi.fn(), fetchIssue: vi.fn(), createIssue: vi.fn(), closeIssue: vi.fn(),
    fetchPrReviewComments: vi.fn(), listOpenIssues: vi.fn(), listOpenPrs: vi.fn(),
    findExistingPr: vi.fn(), commentOnPr: vi.fn(), closePr: vi.fn(), mergePr: vi.fn(() => ({ success: true })),
  };
}

describe('Merge method propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkGhCli.mockReturnValue({ available: true });
    execFileSync.mockReturnValue('');
  });

  it('方式未指定のGitHubマージは従来のmergeを使う', () => {
    expect(mergePr(123, '/project').success).toBe(true);
    expect(execFileSync.mock.calls[0]?.[1]).toEqual(['pr', 'merge', '123', '--merge', '--delete-branch']);
  });

  it.each([true, false])('既存workflowのGitHub方式省略でmergeを実行し成功=%sをeffectへ返す', (success) => {
    if (!success) execFileSync.mockImplementationOnce(() => { throw new Error('merge rejected'); });
    expect(mergePrEffect({ cwd: '/project', projectCwd: '/project', task: 'Merge PR', gitProvider: new GitHubProvider() }, { pr: 123 }))
      .toMatchObject({ success, failed: !success });
    expect(execFileSync.mock.calls[0]).toMatchObject(['gh',
      ['pr', 'merge', '123', '--merge', '--delete-branch'], { cwd: '/project' }]);
  });

  it.each(['squash', 'merge', 'rebase'])('GitHubマージに設定方式%sだけを渡す', (method) => {
    expect(Reflect.apply(mergePr, undefined, [123, '/project', method])).toMatchObject({ success: true });
    const args = execFileSync.mock.calls[0]?.[1] as string[];
    expect(args.filter((arg) => ['--squash', '--merge', '--rebase'].includes(arg))).toEqual([`--${method}`]);
    expect(execFileSync.mock.calls[0]?.[2]).toMatchObject({ cwd: '/project' });
  });

  it.each(['squash', 'merge', 'rebase'] as const)('effectからproviderへ方式%sと元リポジトリを渡す', (mergeMethod) => {
    const gitProvider = provider();
    const options = { cwd: '/clone', projectCwd: '/project', task: 'Merge PR', gitProvider, mergeMethod };
    expect(mergePrEffect(options, { pr: 123 })).toMatchObject({ success: true, failed: false });
    expect(gitProvider.mergePr).toHaveBeenCalledWith(123, '/project', mergeMethod);
  });

  it.each(['squash', 'merge', 'rebase'])('GitHubProviderを経由して方式%sをghへ伝える', (method) => {
    const github = new GitHubProvider();
    expect(Reflect.apply(github.mergePr, github, [123, '/project', method])).toMatchObject({ success: true });
    const args = execFileSync.mock.calls[0]?.[1] as string[];
    expect(args.filter((arg) => ['--squash', '--merge', '--rebase'].includes(arg))).toEqual([`--${method}`]);
  });

  it('GitHubマージの失敗を成功に変換しない', () => {
    execFileSync.mockImplementationOnce(() => { throw new Error('merge rejected'); });
    expect(Reflect.apply(mergePr, undefined, [123, '/project', 'rebase'])).toMatchObject({ success: false });
  });

  it('修正後のcloneのheadをproviderとghの一致条件まで渡す', () => {
    const headSha = 'b'.repeat(40);
    execFileSync.mockReturnValue(headSha);
    const github = new GitHubProvider();
    expect(mergePrEffect({
      cwd: '/clone', projectCwd: '/project', task: 'Merge PR', gitProvider: github, mergeMethod: 'rebase',
      prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main',
        headSha: 'a'.repeat(40), headRepositoryUrl: '/fork', headRepositoryPushUrls: ['/fork'] },
    }, { pr: 123 })).toMatchObject({ success: true });
    expect(execFileSync.mock.calls[0]).toMatchObject(['git', ['rev-parse', 'HEAD'], { cwd: '/clone' }]);
    expect(execFileSync.mock.calls[1]).toMatchObject(['gh',
      ['pr', 'merge', '123', '--rebase', '--delete-branch', '--match-head-commit', headSha],
      { cwd: '/project' }]);
  });

  it('既存workflowの方式省略を保持しGitLabのMRマージまで到達する', () => {
    execFileSync.mockReturnValue('glab available');
    const gitProvider = new GitLabProvider();
    expect(mergePrEffect({ cwd: '/project', projectCwd: '/project', task: 'Merge MR', gitProvider }, { pr: 42 }))
      .toMatchObject({ success: true, failed: false });
    expect(execFileSync).toHaveBeenCalledWith('glab', expect.arrayContaining(['mr', 'merge', '42']),
      expect.objectContaining({ cwd: '/project' }));
  });

  it('明示方式をGitLabへ渡すと拒否されMRマージを実行しない', () => {
    const gitProvider = new GitLabProvider();
    expect(mergePrEffect({ cwd: '/project', projectCwd: '/project', task: 'Merge MR', gitProvider, mergeMethod: 'squash' }, { pr: 42 }))
      .toMatchObject({ success: false, failed: true });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('方式省略でGitLabのMR操作が失敗した場合も失敗を保持する', () => {
    execFileSync.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === 'mr') throw new Error('MR merge rejected');
      return 'glab available';
    });
    expect(mergePrEffect({ cwd: '/project', projectCwd: '/project', task: 'Merge MR', gitProvider: new GitLabProvider() }, { pr: 42 }))
      .toMatchObject({ success: false, failed: true });
  });

  it('PR番号がcloneと一致しない場合はproviderのマージを拒否する', () => {
    const gitProvider = provider();
    expect(mergePrEffect({ cwd: '/clone', projectCwd: '/project', task: 'Merge PR', gitProvider,
      prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main', headSha: 'a'.repeat(40),
        headRepositoryUrl: '/fork', headRepositoryPushUrls: ['/fork'] },
    }, { pr: 999 })).toMatchObject({ success: false, failed: true });
    expect(gitProvider.mergePr).not.toHaveBeenCalled();
  });
});
