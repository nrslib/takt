import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ details: vi.fn(), git: vi.fn(), clone: vi.fn(),
  detect: vi.fn(), supportsDetails: true, fetch: vi.fn(), threat: vi.fn(), comment: vi.fn() }));
vi.mock('../infra/git/index.js', () => ({ getGitProvider: () => ({ fetchPrDetails: mocks.supportsDetails ? mocks.details : undefined,
  commentOnPr: mocks.comment }) }));
vi.mock('../infra/git/detect.js', () => ({ detectVcsProvider: mocks.detect }));
vi.mock('../infra/task/clone-exec.js', () => ({ runGitCommandAbortable: mocks.git }));
vi.mock('../infra/config/index.js', () => ({ resolveConfigValue: vi.fn(), resolveConfigValues: () => ({ allowGitHooks: false, allowGitFilters: false }) }));
vi.mock('../infra/workflow/system/pr-clone-git.js', () => ({ createPrCloneGitOperations: mocks.clone }));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: vi.fn(async () => ({})) }));
vi.mock('../features/merge/threat-check.js', async (original) => ({
  ...await original<typeof import('../features/merge/threat-check.js')>(), checkForkThreats: mocks.threat,
}));
import { getGitProvider } from '../infra/git/index.js';
import { resolveTaskPrExecutionContext } from '../features/tasks/execute/prExecutionContext.js';
import type { PullRequestContext } from '../core/workflow/pr-context.js';

const context: PullRequestContext = { source: 'pr_review', prNumber: 123, headBranch: 'feature',
  baseBranch: 'main', baseBranchSource: 'pull_request' };
const input = { cwd: '/clone', projectCwd: '/project', prContext: context };
const details = { number: 123, headBranch: 'feature', baseBranch: 'main', headSha: 'a'.repeat(40),
  headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'], sameRepository: true };
describe('Task PR execution context', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.supportsDetails = true;
    mocks.detect.mockReturnValue('github');
    mocks.details.mockResolvedValue(details);
    mocks.git.mockImplementation(async (_cwd, args) => ({ stdout:
      args[0] === 'symbolic-ref' ? 'feature' : args.length === 1 ? 'origin' : '/remote', stderr: '' }));
    mocks.clone.mockResolvedValue({ headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'],
      operations: { fetch: mocks.fetch, push: vi.fn() } });
  });
  it('does not resolve a PR for ordinary tasks', async () => {
    expect(await resolveTaskPrExecutionContext({ cwd: '/project', projectCwd: '/project' }))
      .toEqual({ prExecutionContext: undefined, prGitOperations: undefined });
    expect(mocks.details).not.toHaveBeenCalled();
  });
  it('preserves an already resolved merge context and Git operations', async () => {
    const prExecutionContext = { ...details, prNumber: 123 };
    const prGitOperations = { fetch: vi.fn(), push: vi.fn() };
    expect(await resolveTaskPrExecutionContext({ ...input, prExecutionContext, prGitOperations }))
      .toEqual({ prExecutionContext, prGitOperations });
    expect(mocks.details).not.toHaveBeenCalled();
  });
  it('resolves from_pr metadata and uses explicit PR URLs without changing local origin', async () => {
    expect(await resolveTaskPrExecutionContext(input)).toMatchObject({
      prExecutionContext: { prNumber: 123, headBranch: 'feature', baseBranch: 'main',
        headSha: details.headSha, headRepositoryUrl: '/remote', headRepositoryPushUrls: ['/remote'] },
    });
    expect(mocks.clone).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/clone', headRepositoryUrl: '/remote', baseRepositoryUrl: '/remote',
    }));
    expect(mocks.git.mock.calls.some(([, args]) => args.includes('set-url'))).toBe(false);
  });
  it.each(['number', 'headBranch'] as const)('rejects changed PR %s', async (field) => {
    mocks.details.mockResolvedValue({ ...details, [field]: field === 'number' ? 456 : 'other' });
    await expect(resolveTaskPrExecutionContext(input)).rejects.toThrow();
    expect(mocks.clone).not.toHaveBeenCalled();
  });
  it('uses the runtime provider for PR metadata instead of the global provider', async () => {
    const injectedDetails = vi.fn().mockResolvedValue({ ...details, headSha: 'b'.repeat(40) });
    expect(await resolveTaskPrExecutionContext({ ...input,
      gitProvider: { ...getGitProvider(), fetchPrDetails: injectedDetails } })).toMatchObject({
      prExecutionContext: { headSha: 'b'.repeat(40) },
    });
    expect(injectedDetails).toHaveBeenCalledWith(123, '/project', undefined);
    expect(mocks.details).not.toHaveBeenCalled();
  });
  it('keeps the selected diff base while resolving the actual PR base for effects', async () => {
    const prContext = { ...context, baseBranch: 'review-base' };
    expect(await resolveTaskPrExecutionContext({ ...input, prContext })).toMatchObject({
      prExecutionContext: { baseBranch: 'main' },
    });
    expect(prContext.baseBranch).toBe('review-base');
  });
  const saved = { headSha: 'b'.repeat(40), baseBranch: 'main', headRepositoryUrl: '/remote',
    headRepositoryPushUrls: ['/remote'] };
  function retryInput() {
    mocks.details.mockResolvedValue({ ...details, headSha: saved.headSha });
    mocks.git.mockImplementation(async (_cwd, args) => ({
      stdout: args[0] === 'symbolic-ref' ? 'feature' : args[0] === 'rev-parse' ? saved.headSha : '/remote', stderr: '',
    }));
    return { ...input, prContext: { ...context, baseBranch: 'review-base' }, cacciaPushedHead: saved };
  }
  it('restores the recorded PR head while preserving the selected diff base', async () => {
    const request = retryInput();
    expect(await resolveTaskPrExecutionContext(request)).toMatchObject({
      prExecutionContext: { headSha: saved.headSha, baseBranch: 'main' },
    });
    expect(request.prContext.baseBranch).toBe('review-base');
    expect(mocks.fetch).toHaveBeenCalledWith('origin', 'refs/heads/feature');
    expect(mocks.git.mock.calls.some(([, args]) => args.join(' ') === 'merge --ff-only FETCH_HEAD')).toBe(true);
  });
  it.each(['number', 'headBranch', 'baseBranch', 'headRepositoryUrl', 'headRepositoryPushUrls', 'headSha'] as const)(
    'rejects changed retry %s before synchronization', async (field) => {
      const request = retryInput();
      const changed = field === 'number' ? 456 : field === 'headRepositoryPushUrls' ? ['/other']
        : field === 'baseBranch' ? 'review-base' : 'other';
      mocks.details.mockResolvedValue({ ...details, headSha: saved.headSha, [field]: changed });
      await expect(resolveTaskPrExecutionContext(request)).rejects.toThrow();
      expect(mocks.clone).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.threat).not.toHaveBeenCalled();
    });
  it.each(['passed', 'rejected', 'aborted', 'comment_failed'] as const)(
    'checks the actual fork base before retry continues: %s', async (condition) => {
      const request = retryInput();
      const controller = new AbortController();
      mocks.details.mockResolvedValue({ ...details, headSha: saved.headSha, sameRepository: false });
      mocks.threat.mockImplementation(async () => {
        if (condition === 'aborted') controller.abort(new Error('Cancelled after check'));
        return condition === 'passed' ? { passed: true }
          : { passed: false, comment: '危険な定義: .github/workflows/@org/team' };
      });
      mocks.comment.mockReturnValue(condition === 'comment_failed'
        ? { success: false, error: 'Cannot post comment' } : { success: true });
      const result = resolveTaskPrExecutionContext({ ...request, abortSignal: controller.signal });
      if (condition === 'passed') await expect(result).resolves.toMatchObject({ prExecutionContext: { headSha: saved.headSha } });
      else await expect(result).rejects.toThrow();
      expect(mocks.fetch).toHaveBeenCalledWith('base', 'refs/heads/main:refs/takt/pr-base/main');
      expect(mocks.threat).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'refs/takt/pr-base/main' }));
      if (condition === 'rejected' || condition === 'comment_failed') {
        expect(mocks.comment).toHaveBeenCalledExactlyOnceWith(123,
          '危険な定義: .github/workflows/＠org/team', '/project');
      } else expect(mocks.comment).not.toHaveBeenCalled();
    });
  it('rejects a clone on another branch', async () => {
    mocks.git.mockResolvedValue({ stdout: 'other', stderr: '' });
    await expect(resolveTaskPrExecutionContext(input)).rejects.toThrow();
    expect(mocks.clone).not.toHaveBeenCalled();
  });
  it('keeps existing root PR workflows without adding an execution clone context', async () => {
    expect(await resolveTaskPrExecutionContext({ ...input, cwd: '/project' }))
      .toEqual({ prExecutionContext: undefined, prGitOperations: undefined });
    expect(mocks.details).not.toHaveBeenCalled();
  });
  it('preserves non-GitHub PR tasks when their provider has no merge metadata API', async () => {
    mocks.supportsDetails = false;
    mocks.detect.mockReturnValue('gitlab');
    expect(await resolveTaskPrExecutionContext(input))
      .toEqual({ prExecutionContext: undefined, prGitOperations: undefined });
    expect(mocks.git).not.toHaveBeenCalled();
    expect(mocks.clone).not.toHaveBeenCalled();
  });
  it('does not hide a missing GitHub metadata API', async () => {
    mocks.supportsDetails = false;
    await expect(resolveTaskPrExecutionContext(input)).rejects.toThrow();
    expect(mocks.clone).not.toHaveBeenCalled();
  });
});
