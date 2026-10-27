import { beforeEach, describe, expect, it, vi } from 'vitest';
import { synchronizeRetryPrHead } from '../features/merge/retry-sync.js';

const doubles = vi.hoisted(() => ({ git: vi.fn(), exists: vi.fn(), suppress: vi.fn(),
  capture: vi.fn(), validate: vi.fn(), resolver: vi.fn() }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: doubles.exists }));
vi.mock('../infra/task/clone-exec.js', () => ({ runGitCommandAbortable: doubles.git }));
vi.mock('../infra/task/git-merge-environment.js', () => ({ suppressMergeDrivers: doubles.suppress }));
vi.mock('../infra/service/syncConflictFiles.js', () => ({ captureSyncConflictFiles: doubles.capture }));
vi.mock('../infra/service/runSyncConflictResolver.js', () => ({ runSyncConflictResolver: doubles.resolver }));

describe('synchronizeRetryPrHead', () => {
  const environment = { GIT_CONFIG_COUNT: '1' };
  let head: string, target: string, mergeBase: string, merging: boolean, conflict: boolean;
  let mergeFailure: Error | undefined;
  let controller: AbortController;
  const operations = { fetch: vi.fn(), push: vi.fn() };

  const run = () => synchronizeRetryPrHead({ projectCwd: '/project', cwd: '/clone',
    headSha: target, headRef: 'refs/heads/feature', environment: {}, operations, abortSignal: controller.signal });

  beforeEach(() => {
    vi.resetAllMocks();
    head = 'local'; target = 'remote'; mergeBase = 'common'; merging = false; conflict = false;
    mergeFailure = undefined; controller = new AbortController();
    doubles.exists.mockImplementation(() => merging);
    doubles.suppress.mockReturnValue(environment);
    doubles.capture.mockReturnValue({ validateAndStage: doubles.validate });
    doubles.resolver.mockResolvedValue({ status: 'done' });
    doubles.git.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: args.includes('--git-path') ? '.git/MERGE_HEAD'
        : args[1] === 'HEAD' ? head : target };
      if (args[0] === 'merge-base') return { stdout: args[1] === args[2] || head === 'merged' ? args[1] : mergeBase };
      if (args[0] === 'ls-files') return { stdout: conflict ? 'unmerged' : '' };
      if (args[0] === 'merge' && args[1] === '--abort') { merging = false; conflict = false; }
      else if (args[0] === 'merge') {
        if (mergeFailure) throw mergeFailure;
        head = args[1] === '--ff-only' ? target : 'merged';
      }
      if (args[0] === 'commit') { merging = false; conflict = false; head = 'merged'; }
      return { stdout: '' };
    });
  });

  it('keeps an ahead clone without merging or pushing', async () => {
    mergeBase = target;
    expect(await run()).toBe('local');
    expect(doubles.git.mock.calls.some(([, args]) => args[0] === 'merge')).toBe(false);
    expect(operations.push).not.toHaveBeenCalled();
  });

  it('propagates merge-base errors without treating them as divergence', async () => {
    const normal = doubles.git.getMockImplementation()!;
    const error = new Error('object missing');
    doubles.git.mockImplementation(async (cwd, args) => {
      if (args[0] === 'merge-base') throw error;
      return normal(cwd, args);
    });
    await expect(run()).rejects.toThrow(error);
    expect(doubles.resolver).not.toHaveBeenCalled();
    expect(doubles.git.mock.calls.some(([, args]) => args[0] === 'merge')).toBe(false);
  });

  it('does not resolve or abort a preexisting unfinished merge', async () => {
    merging = true;
    await expect(run()).rejects.toThrow();
    expect(operations.fetch).not.toHaveBeenCalled();
    expect(doubles.resolver).not.toHaveBeenCalled();
    expect(doubles.git.mock.calls.some(([, args]) => args[0] === 'merge')).toBe(false);
  });

  it('propagates a merge failure without conflict state instead of invoking AI', async () => {
    mergeFailure = new Error('Git configuration failure');
    await expect(run()).rejects.toThrow(mergeFailure);
    expect(doubles.resolver).not.toHaveBeenCalled();
    expect(doubles.git.mock.calls.some(([, args]) => args[1] === '--abort')).toBe(false);
  });

  function startConflict(): void {
    mergeFailure = new Error('merge failed');
    const normal = doubles.git.getMockImplementation()!;
    doubles.git.mockImplementation(async (cwd, args, ...rest) => {
      if (args[0] === 'merge' && args[1] !== '--abort') { merging = true; conflict = true; }
      return normal(cwd, args, ...rest);
    });
  }

  it('validates AI edits before committing with the same safe environment', async () => {
    startConflict();
    expect(await run()).toBe('merged');
    expect(doubles.capture).toHaveBeenCalledWith('/clone', environment);
    expect(doubles.validate).toHaveBeenCalledOnce();
    expect(doubles.git).toHaveBeenCalledWith('/clone', ['commit', '--no-edit'], controller.signal, environment);
    expect(doubles.validate.mock.invocationCallOrder[0]).toBeLessThan(
      doubles.git.mock.invocationCallOrder[doubles.git.mock.calls.findIndex(([, args]) => args[0] === 'commit')]!);
  });

  it('aborts the owned merge even when the task was cancelled during AI resolution', async () => {
    startConflict();
    doubles.resolver.mockImplementation(async () => { controller.abort(new Error('cancelled')); return { status: 'done' }; });
    await expect(run()).rejects.toThrow('cancelled');
    expect(doubles.git).toHaveBeenCalledWith('/clone', ['merge', '--abort'], undefined, environment);
    expect(doubles.validate).not.toHaveBeenCalled();
    expect(merging).toBe(false);
  });

  it('retains both resolution and abort failures for the caller', async () => {
    startConflict();
    doubles.resolver.mockRejectedValue(new Error('resolver unavailable'));
    const normal = doubles.git.getMockImplementation()!;
    doubles.git.mockImplementation(async (cwd, args, ...rest) => {
      if (args[1] === '--abort') throw new Error('cannot abort');
      return normal(cwd, args, ...rest);
    });
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('resolver unavailable');
    expect((error as Error).message).toContain('cannot abort');
    expect(doubles.git.mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
  });
});
