import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ git: vi.fn(), commit: vi.fn(), resolver: vi.fn(), network: vi.fn(), environment: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.git }));
vi.mock('../infra/task/git.js', () => ({ stageAndCommit: mocks.commit }));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: mocks.environment }));
vi.mock('../infra/task/clone-exec.js', () => ({ runGitCommandAbortable: mocks.network }));
vi.mock('../infra/service/runSyncConflictResolver.js', () => ({ runSyncConflictResolver: mocks.resolver }));
import { commitAndPushEffect, syncPrCloneEffect } from '../infra/workflow/system/system-pr-code-effects.js';
import type { SystemStepServicesOptions } from '../core/workflow/system/system-step-services.js';
import { createPrCloneGitOperations } from '../infra/workflow/system/pr-clone-git.js';
import { createCacciaCloneGitOperations } from '../infra/workflow/system/caccia-clone-git.js';
const options: SystemStepServicesOptions = {
  cwd: '/clone', projectCwd: '/project', task: 'Review PR',
  prExecutionContext: { prNumber: 123, headBranch: 'feature/pr', baseBranch: 'main',
    headSha: 'a'.repeat(40), headRepositoryUrl: '/fork', headRepositoryPushUrls: ['/fork'] },
};
describe('PR clone code effects', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.git.mockImplementation((_command, args: string[]) => {
      if (args[0] === 'config') throw Object.assign(new Error('No matching config'), { status: 1 });
      return args[0] === 'symbolic-ref' ? 'feature/pr' : args[0] === 'rev-parse' ? 'b'.repeat(40) : '';
    });
    mocks.commit.mockResolvedValue(undefined);
    mocks.resolver.mockResolvedValue({ status: 'done' });
    mocks.environment.mockResolvedValue({ SAFE_GIT: '1' });
    mocks.network.mockResolvedValue({ stdout: '', stderr: '' });
  });

  it('PRの取得・pushをclone内の通常Gitと設定で行う', async () => {
    const result = await createPrCloneGitOperations({ cwd: '/clone', headRepositoryUrl: '/fork',
      headRepositoryPushUrls: ['/fork', '/mirror'], baseRepositoryUrl: '/project' });
    expect(result).toMatchObject({ headRepositoryUrl: '/fork', headRepositoryPushUrls: ['/fork', '/mirror'], baseRepositoryUrl: '/project' });
    await result.operations.fetch('base', 'refs/heads/main:refs/remotes/base/main');
    await result.operations.push('HEAD:refs/heads/feature/pr');
    expect(mocks.network.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['/clone', ['fetch', '--force', 'base', 'refs/heads/main:refs/remotes/base/main']],
      ['/clone', ['push', '/fork', 'HEAD:refs/heads/feature/pr']],
      ['/clone', ['push', '/mirror', 'HEAD:refs/heads/feature/pr']],
    ]);
    expect(mocks.network.mock.calls.every((call) => call[3].SAFE_GIT === '1')).toBe(true);
  });

  it('PRのpush失敗を伝播し後続送信先へ進まない', async () => {
    const result = await createPrCloneGitOperations({ cwd: '/clone', headRepositoryUrl: '/fork',
      headRepositoryPushUrls: ['/fork', '/mirror'], baseRepositoryUrl: '/project' });
    mocks.network.mockRejectedValueOnce(new Error('push denied'));
    await expect(result.operations.push('HEAD:refs/heads/feature/pr')).rejects.toThrow('push denied');
    expect(mocks.network).toHaveBeenCalledOnce();
  });

  it('Cacciaは通常のpush拒否後も残りを試行し最初のエラーを伝播する', async () => {
    const result = await createCacciaCloneGitOperations({ cwd: '/clone', headRepositoryUrl: '/fork',
      headRepositoryPushUrls: ['/fork', '/mirror', '/third'] });
    await result.operations.fetch('refs/heads/feature/pr');
    expect(mocks.network).toHaveBeenCalledWith('/clone', ['fetch', '--no-tags', 'origin', 'refs/heads/feature/pr'], undefined, { SAFE_GIT: '1' });
    mocks.network.mockClear();
    const first = new Error('first denied');
    mocks.network.mockRejectedValueOnce(first).mockRejectedValueOnce(new Error('second denied')).mockResolvedValueOnce({ stdout: '' });
    await expect(result.operations.push('HEAD:refs/heads/feature/pr')).rejects.toBe(first);
    expect(mocks.network.mock.calls.map((call) => call[1][1])).toEqual(['/fork', '/mirror', '/third']);
  });

  it('Cacciaのabort時は後続pushを試行しない', async () => {
    const controller = new AbortController();
    const result = await createCacciaCloneGitOperations({ cwd: '/clone', headRepositoryUrl: '/fork',
      headRepositoryPushUrls: ['/fork', '/mirror'], abortSignal: controller.signal });
    mocks.network.mockImplementationOnce(() => { controller.abort(); throw new Error('aborted'); });
    await expect(result.operations.push('HEAD:refs/heads/feature/pr')).rejects.toThrow('aborted');
    expect(mocks.network).toHaveBeenCalledOnce();
  });
  it('異なるPRやrootでの修正を拒否しcommitとpushを行わない', async () => {
    expect(await commitAndPushEffect(options, { pr: 999 })).toMatchObject({ success: false });
    expect(await commitAndPushEffect({ ...options, cwd: '/project' }, { pr: 123 })).toMatchObject({ success: false });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.git).not.toHaveBeenCalled();
  });
  it('別branchへのpushを拒否する', async () => {
    mocks.git.mockReturnValue('other');
    expect(await commitAndPushEffect(options, { pr: 123 })).toMatchObject({ failed: true });
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('同期はbaseを同じcloneに取り込みpushを後続effectへ委ねる', async () => {
    expect(await syncPrCloneEffect(options, { pr: 123 }, false)).toMatchObject({ success: true });
    expect(mocks.network).toHaveBeenCalledWith('/clone', ['fetch', '--force', 'base', 'refs/heads/main:refs/takt/pr-base/main'], undefined,
      expect.objectContaining({ SAFE_GIT: '1' }));
    expect(mocks.git.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false);
    expect(mocks.resolver).not.toHaveBeenCalled();
  });
  it('競合時はmergeをabortし未解決として後続判断へ返す', async () => {
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('CONFLICT: Automatic merge failed');
      if (args[0] === 'ls-files') return 'unmerged index';
      return '';
    });
    expect(await syncPrCloneEffect(options, { pr: 123 }, false)).toMatchObject({
      conflicted: true, success: false, failed: false, error: expect.stringContaining('CONFLICT: Automatic merge failed'),
    });
    expect(mocks.git).toHaveBeenCalledWith('git', ['merge', '--abort'], expect.objectContaining({ cwd: '/clone' }));
    expect(mocks.resolver).not.toHaveBeenCalled();
  });
  it('AI解決後も競合indexが残ればcommitせず失敗する', async () => {
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('CONFLICT');
      if (args[0] === 'ls-files') return 'unmerged index';
      return '';
    });
    expect(await syncPrCloneEffect(options, { pr: 123 }, true)).toMatchObject({ success: false, conflicted: true });
    expect(mocks.resolver).toHaveBeenCalledWith({ projectCwd: '/project', cwd: '/clone', originalInstruction: 'Review PR' });
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('AI解決した同じcloneの変更を安全設定でcommitする', async () => {
    let indexReads = 0;
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('CONFLICT');
      if (args[0] === 'ls-files') return indexReads++ === 0 ? 'unmerged index' : '';
      return '';
    });
    const allowed = { ...options, allowGitFilters: true };
    expect(await syncPrCloneEffect(allowed, { pr: 123 }, true)).toMatchObject({ success: true });
    expect(mocks.environment).toHaveBeenCalledWith('/clone', { ...allowed, allowGitFilters: false });
    expect(mocks.commit).toHaveBeenCalledWith('/clone', 'fix: resolve PR merge conflicts', allowed);
  });

  it.each([false, true])('commit_and_pushはfilter許可=%sをcommit用設定へ保持する', async (allowGitFilters) => {
    const configured = { ...options, allowGitFilters };
    expect(await commitAndPushEffect(configured, { pr: 123 })).toMatchObject({ success: true });
    expect(mocks.commit).toHaveBeenCalledWith('/clone', 'fix: apply TAKT PR review changes', configured);
    expect(mocks.environment).toHaveBeenCalledWith('/clone', configured);
  });

  it.each([false, true])('同期用環境生成の失敗時は競合解決=%sでもmergeしない', async (resolveConflicts) => {
    mocks.environment.mockRejectedValue(new Error('filter configuration read failed'));
    expect(await syncPrCloneEffect({ ...options, allowGitFilters: true }, { pr: 123 }, resolveConflicts))
      .toMatchObject({ success: false, failed: true, conflicted: false });
    expect(mocks.git.mock.calls.some(([, args]) => args[0] === 'merge')).toBe(false);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.resolver).not.toHaveBeenCalled();
  });

  it('driver抑止をhook/filter抑止へ追加し利用者の設定を書き換えない', async () => {
    const safe = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'filter.test.required', GIT_CONFIG_VALUE_1: 'false' };
    mocks.environment.mockResolvedValue(safe);
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'config') return 'merge.audit.driver\0merge.nested.driver\0';
      return '';
    });
    expect(await syncPrCloneEffect(options, { pr: 123 }, false)).toMatchObject({ success: true });
    expect(mocks.git).toHaveBeenCalledWith('git', ['merge', '--no-edit', 'refs/takt/pr-base/main'], expect.objectContaining({
      env: { ...safe, GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_2: 'merge.audit.driver', GIT_CONFIG_VALUE_2: 'false',
        GIT_CONFIG_KEY_3: 'merge.nested.driver', GIT_CONFIG_VALUE_3: 'false' },
    }));
    expect(safe.GIT_CONFIG_COUNT).toBe('2');
  });

  it.each([1, 128])('設定列挙のstatus=%sを該当なしと実エラーに分ける', async (status) => {
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'config') throw Object.assign(new Error('config read failed'), { status });
      return '';
    });
    const result = await syncPrCloneEffect(options, { pr: 123 }, false);
    expect(result).toMatchObject({ success: status === 1, failed: status !== 1, conflicted: false });
    expect(mocks.git.mock.calls.some(([, args]) => args[0] === 'merge')).toBe(status === 1);
  });

  it('未解決indexの読取失敗を競合なしへ変換しない', async () => {
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('merge failed');
      if (args[0] === 'ls-files') throw new Error('index read failed');
      return '';
    });
    expect(await syncPrCloneEffect(options, { pr: 123 }, true))
      .toMatchObject({ success: false, failed: true, error: expect.stringContaining('index read failed') });
    expect(mocks.resolver).not.toHaveBeenCalled();
    expect(mocks.git).toHaveBeenCalledWith('git', ['merge', '--abort'], expect.anything());
  });

  it('resolver例外とabort失敗の両方を保存する', async () => {
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('merge failed');
      if (args[0] === 'merge') throw new Error('abort failed');
      if (args[0] === 'ls-files') return 'unmerged index';
      return '';
    });
    mocks.resolver.mockRejectedValue(new Error('resolver failed'));
    const result = await syncPrCloneEffect(options, { pr: 123 }, true);
    expect(result).toMatchObject({ failed: true, conflicted: true, error: expect.stringContaining('resolver failed') });
    expect(result.error).toContain('abort failed');
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('AI解決しない競合でもabort失敗が元のmerge理由を失わせない', async () => {
    const mergeError = 'custom driver merge failed';
    const abortError = 'abort cleanup rejected';
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error(mergeError);
      if (args[0] === 'merge') throw new Error(abortError);
      if (args[0] === 'ls-files') return 'unmerged index';
      return '';
    });

    const result = await syncPrCloneEffect(options, { pr: 123 }, false);

    expect(result).toMatchObject({ success: false, failed: true, conflicted: true });
    expect(result.error).toContain(mergeError);
    expect(result.error).toContain(abortError);
    expect(mocks.git.mock.calls.filter(([, args]) => args[0] === 'merge' && args[1] === '--abort')).toHaveLength(1);
    expect(mocks.resolver).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'done'])('AIのstatus=%sで未解決の場合もabort失敗がresolver理由を失わせない', async (status) => {
    const resolverError = 'resolver left conflicts unresolved';
    const abortError = 'abort cleanup rejected';
    mocks.git.mockImplementation((_cmd, args: string[]) => {
      if (args[0] === 'symbolic-ref') return 'feature/pr';
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('custom driver merge failed');
      if (args[0] === 'merge') throw new Error(abortError);
      if (args[0] === 'ls-files') return 'unmerged index';
      return '';
    });
    mocks.resolver.mockResolvedValue({ status, error: resolverError });

    const result = await syncPrCloneEffect(options, { pr: 123 }, true);

    expect(result).toMatchObject({ success: false, failed: true, conflicted: true });
    expect(result.error).toContain(resolverError);
    expect(result.error).toContain(abortError);
    expect(mocks.git.mock.calls.filter(([, args]) => args[0] === 'merge' && args[1] === '--abort')).toHaveLength(1);
    expect(mocks.resolver).toHaveBeenCalledTimes(1);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('注入したGit操作でbaseを取得し修正をpushする', async () => {
    const prGitOperations = { fetch: vi.fn().mockResolvedValue(undefined), push: vi.fn().mockResolvedValue(undefined) };
    const configured = { ...options, prGitOperations };
    expect(await syncPrCloneEffect(configured, { pr: 123 }, false)).toMatchObject({ success: true });
    expect(prGitOperations.fetch).toHaveBeenCalledWith('base', 'refs/heads/main:refs/takt/pr-base/main');
    expect(await commitAndPushEffect(configured, { pr: 123 })).toMatchObject({ success: true, headSha: 'b'.repeat(40) });
    expect(prGitOperations.push).toHaveBeenCalledWith('HEAD:refs/heads/feature/pr');
    expect(mocks.git.mock.calls.some(([, args]) => ['fetch', 'push'].includes(args[0]))).toBe(false);
  });

  it.each([false, true])('注入済みoperationsは送信先配列が空でも従来の成功・拒否=%sを返す', async (rejected) => {
    const push = rejected ? vi.fn().mockRejectedValue(new Error('push rejected')) : vi.fn().mockResolvedValue(undefined);
    const configured = { ...options, prExecutionContext: { ...options.prExecutionContext!, headRepositoryPushUrls: [] },
      prGitOperations: { fetch: vi.fn(), push } };
    expect(await commitAndPushEffect(configured, { pr: 123 })).toMatchObject({ success: !rejected, failed: rejected });
    expect(push).toHaveBeenCalledExactlyOnceWith('HEAD:refs/heads/feature/pr');
    expect(mocks.network).not.toHaveBeenCalled();
  });

  it.each([false, true])('base認証失敗を競合解決=%sでも成功や競合に変換しない', async (resolveConflicts) => {
    const prGitOperations = { fetch: vi.fn().mockRejectedValue(new Error('Authentication rejected')), push: vi.fn() };
    expect(await syncPrCloneEffect({ ...options, prGitOperations }, { pr: 123 }, resolveConflicts))
      .toMatchObject({ success: false, failed: true, conflicted: false });
    expect(mocks.resolver).not.toHaveBeenCalled();
    expect(mocks.git.mock.calls.some(([, args]) => args[0] === 'merge')).toBe(false);
  });

});
