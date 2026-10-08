import { beforeEach, describe, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ text: vi.fn(), run: vi.fn(), sha: vi.fn(), included: vi.fn(), create: vi.fn(), remove: vi.fn(), warn: vi.fn() }));
vi.mock('../infra/goals/git-command.js', () => ({
  goalGitText: doubles.text, runGoalGit: doubles.run, resolveGoalBranchSha: doubles.sha, isGoalCommitIncluded: doubles.included,
}));
vi.mock('node:fs/promises', () => ({ mkdtemp: doubles.create, rm: doubles.remove }));
vi.mock('../shared/utils/debug.js', () => ({ createLogger: () => ({ warn: doubles.warn }) }));
import { checkedOutGoalWorktrees, mergeGoalBranch } from '../infra/goals/merge-git.js';
const oldSha = 'a'.repeat(40);
const source = 'b'.repeat(40);
const merged = 'c'.repeat(40);
beforeEach(() => {
  vi.resetAllMocks();
  doubles.create.mockResolvedValue('/temporary');
  doubles.sha.mockResolvedValue(oldSha);
  doubles.included.mockResolvedValue(false);
  doubles.text.mockImplementation(async (_cwd: string, args: string[]) => args[0] === 'rev-parse' ? merged : '');
  doubles.run.mockImplementation(async (_cwd: string, args: string[]) => ({
    output: Buffer.from(args[0] === 'worktree' ? 'worktree /human\0HEAD aaaa\0branch refs/heads/feature\0\0' : ''),
    truncated: false, code: args[0] === 'config' ? 1 : 0,
  }));
});
describe('isolated goal Git merge', () => {
  it('matches only the full branch field and preserves NUL-delimited worktree paths', () => {
    const records = 'worktree /repo/branch refs/heads/takt/goal\nlocked\0HEAD aaaa\0detached\0\0'
      + 'worktree /copy\0HEAD aaaa\0branch refs/heads/takt/goal-copy\0locked takt/goal\0\0'
      + 'worktree /bare\0bare\0\0worktree /gone\0HEAD aaaa\0detached\0prunable takt/goal\0\0'
      + 'worktree /real\npath\0HEAD aaaa\0branch refs/heads/takt/goal\0\0';
    expect(checkedOutGoalWorktrees(records, 'takt/goal')).toEqual(['/real\npath']);
  });
  it('rejects an initially checked-out target without creating a clone', async () => {
    doubles.run.mockResolvedValue({ output: Buffer.from('worktree /human\0branch refs/heads/main\0\0'), truncated: false, code: 0 });
    expect(await mergeGoalBranch('/project', source, 'main', undefined)).toEqual({ status: 'checked_out', worktrees: ['/human'] });
    expect(doubles.create).not.toHaveBeenCalled();
    expect(doubles.text).not.toHaveBeenCalled();
  });
  it('skips an already included commit so retry does not create another merge', async () => {
    doubles.included.mockResolvedValue(true);
    expect(await mergeGoalBranch('/project', source, 'main', undefined)).toEqual({ status: 'merged', sha: oldSha });
    expect(doubles.create).not.toHaveBeenCalled();
  });
  it('publishes objects, rechecks worktrees and conditionally updates the original reference', async () => {
    expect(await mergeGoalBranch('/project', source, 'main', undefined)).toEqual({ status: 'merged', sha: merged });
    expect(doubles.run).toHaveBeenCalledWith('/temporary/repository', ['merge', '--no-ff', '--no-edit', source], 4096, undefined, [0, 1]);
    expect(doubles.text).toHaveBeenCalledWith('/project', ['update-ref', 'refs/heads/main', merged, oldSha], undefined);
    expect(doubles.run.mock.calls.filter(([, args]) => args[0] === 'worktree')).toHaveLength(2);
    expect(doubles.remove).toHaveBeenCalledOnce();
  });
  it('does not publish if a target becomes checked out after the isolated merge', async () => {
    let checks = 0;
    doubles.run.mockImplementation(async (_cwd: string, args: string[]) => ({
      output: Buffer.from(args[0] === 'worktree' && ++checks === 2 ? 'worktree /later\0branch refs/heads/main\0\0' : ''),
      truncated: false, code: args[0] === 'config' ? 1 : 0,
    }));
    expect(await mergeGoalBranch('/project', source, 'main', undefined)).toEqual({ status: 'checked_out', worktrees: ['/later'] });
    expect(doubles.text.mock.calls.some(([, args]) => args[0] === 'update-ref')).toBe(false);
    expect(doubles.remove).toHaveBeenCalledWith('/temporary', { recursive: true, force: true });
  });
  it('aborts conflicts, returns literal file names and removes the clone', async () => {
    doubles.run.mockImplementation(async (_cwd: string, args: string[]) => ({
      output: Buffer.from(args[0] === 'diff' ? 'file\tname\n.txt\0' : ''),
      truncated: false, code: args[0] === 'merge' || args[0] === 'config' ? 1 : 0,
    }));
    expect(await mergeGoalBranch('/project', source, 'main', undefined)).toEqual({ status: 'conflict', conflicts: ['file\tname\n.txt'] });
    expect(doubles.text).toHaveBeenCalledWith('/temporary/repository', ['merge', '--abort'], undefined);
    expect(doubles.text.mock.calls.some(([, args]) => args[0] === 'update-ref')).toBe(false);
    expect(doubles.remove).toHaveBeenCalledOnce();
  });
  it('propagates conditional update failure and removes the clone', async () => {
    doubles.text.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === 'update-ref') throw new Error('target changed');
      return args[0] === 'rev-parse' ? merged : '';
    });
    await expect(mergeGoalBranch('/project', source, 'main', undefined)).rejects.toThrow();
    expect(doubles.text).toHaveBeenCalledWith('/project', ['update-ref', 'refs/heads/main', merged, oldSha], undefined);
    expect(doubles.remove).toHaveBeenCalledOnce();
  });
  it('removes a partial clone after clone creation fails', async () => {
    doubles.text.mockRejectedValue(new Error('clone failure'));
    await expect(mergeGoalBranch('/project', source, 'main', undefined)).rejects.toThrow();
    expect(doubles.remove).toHaveBeenCalledOnce();
  });
  it('preserves the merge result when cleanup fails', async () => {
    const cleanupError = new Error('cleanup failed');
    doubles.remove.mockRejectedValue(cleanupError);

    expect(await mergeGoalBranch('/project', source, 'main', undefined)).toEqual({ status: 'merged', sha: merged });
    expect(doubles.warn).toHaveBeenCalledWith(expect.any(String), { path: '/temporary', error: String(cleanupError) });
    expect(doubles.remove).toHaveBeenCalledOnce();
  });
  it('preserves the original Git error when cleanup fails', async () => {
    const gitError = new Error('target changed');
    const cleanupError = new Error('cleanup failed');
    doubles.text.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args[0] === 'update-ref') throw gitError;
      return args[0] === 'rev-parse' ? merged : '';
    });
    doubles.remove.mockRejectedValue(cleanupError);

    await expect(mergeGoalBranch('/project', source, 'main', undefined)).rejects.toBe(gitError);
    expect(doubles.warn).toHaveBeenCalledWith(expect.any(String), { path: '/temporary', error: String(cleanupError) });
    expect(doubles.remove).toHaveBeenCalledOnce();
  });
  it('preserves conflict files and aborts the merge when cleanup fails', async () => {
    const cleanupError = new Error('cleanup failed');
    doubles.remove.mockRejectedValue(cleanupError);
    doubles.run.mockImplementation(async (_cwd: string, args: string[]) => ({
      output: Buffer.from(args[0] === 'diff' ? 'conflict.txt\0' : ''),
      truncated: false, code: args[0] === 'merge' || args[0] === 'config' ? 1 : 0,
    }));

    expect(await mergeGoalBranch('/project', source, 'main', undefined))
      .toEqual({ status: 'conflict', conflicts: ['conflict.txt'] });
    expect(doubles.text).toHaveBeenCalledWith('/temporary/repository', ['merge', '--abort'], undefined);
    expect(doubles.text.mock.calls.some(([, args]) => args[0] === 'update-ref')).toBe(false);
    expect(doubles.warn).toHaveBeenCalledWith(expect.any(String), { path: '/temporary', error: String(cleanupError) });
  });
  it('preserves checked-out worktree paths without updating the reference when cleanup fails', async () => {
    const cleanupError = new Error('cleanup failed');
    doubles.remove.mockRejectedValue(cleanupError);
    let checks = 0;
    doubles.run.mockImplementation(async (_cwd: string, args: string[]) => ({
      output: Buffer.from(args[0] === 'worktree' && ++checks === 2 ? 'worktree /later\0branch refs/heads/main\0\0' : ''),
      truncated: false, code: args[0] === 'config' ? 1 : 0,
    }));

    expect(await mergeGoalBranch('/project', source, 'main', undefined))
      .toEqual({ status: 'checked_out', worktrees: ['/later'] });
    expect(doubles.text.mock.calls.some(([, args]) => args[0] === 'update-ref')).toBe(false);
    expect(doubles.warn).toHaveBeenCalledWith(expect.any(String), { path: '/temporary', error: String(cleanupError) });
  });
  it('refuses to publish when the complete worktree list cannot be captured', async () => {
    doubles.run.mockResolvedValue({ output: Buffer.alloc(0), truncated: true, code: 0 });
    await expect(mergeGoalBranch('/project', source, 'main', undefined)).rejects.toThrow();
    expect(doubles.create).not.toHaveBeenCalled();
  });
});
