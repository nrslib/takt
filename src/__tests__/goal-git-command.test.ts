import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
const doubles = vi.hoisted(() => ({ spawn: vi.fn(), environment: vi.fn() }));
vi.mock('../shared/utils/spawn.js', () => ({ spawnManagedProcess: doubles.spawn }));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: doubles.environment }));
import { goalGitText, isGoalCommitIncluded, resolveGoalBranchSha, runGoalGit } from '../infra/goals/git-command.js';
beforeEach(() => { vi.resetAllMocks(); doubles.environment.mockResolvedValue({ GIT_LITERAL_PATHSPECS: '1' }); });
function processOutput(chunks: Buffer[], code = 0, error = '') {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const terminate = vi.fn();
  doubles.spawn.mockReturnValue({
    child: { stdout, stderr },
    wait: async () => {
      for (const chunk of chunks) stdout.emit('data', chunk);
      stderr.emit('data', Buffer.from(error));
      return { code, signal: null };
    }, terminate,
  });
  return terminate;
}
it('retains only bounded bytes while draining arbitrary stdout chunks', async () => {
  processOutput([Buffer.from('abc'), Buffer.alloc(100000, 'd'), Buffer.alloc(100000, 'e')]);
  expect(await runGoalGit('/project', ['diff'], 5, undefined)).toEqual({ output: Buffer.from('abcdd'), truncated: true, code: 0 });
  expect(doubles.spawn.mock.calls[0]![2]).toMatchObject({ env: { GIT_LITERAL_PATHSPECS: '1' } });
});
it('distinguishes a non-ancestor from a Git failure', async () => {
  processOutput([], 1);
  expect(await isGoalCommitIncluded('/project', 'a', 'b', undefined)).toBe(false);
  processOutput([], 128, 'missing object');
  await expect(isGoalCommitIncluded('/project', 'a', 'b', undefined)).rejects.toThrow();
});
it('rejects incomplete output when a complete Git result is required', async () => {
  processOutput([Buffer.alloc(8 * 1024 * 1024 + 1)]);
  await expect(goalGitText('/project', ['worktree', 'list'], undefined)).rejects.toThrow();
});
it('resolves a fully qualified local branch commit and rejects invalid branch input', async () => {
  processOutput([Buffer.from('a'.repeat(40) + '\n')]);
  expect(await resolveGoalBranchSha('/project', 'main', undefined)).toBe('a'.repeat(40));
  expect(doubles.spawn.mock.calls[0]![1]).toContain('refs/heads/main^{commit}');
  await expect(resolveGoalBranchSha('/project', '-option', undefined)).rejects.toThrow();
});
it('does not start a child for an already cancelled operation', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(runGoalGit('/project', ['diff'], 100, controller.signal)).rejects.toThrow();
  expect(doubles.spawn).not.toHaveBeenCalled();
});
it('terminates a process when capture streams are unavailable', async () => {
  const terminate = vi.fn();
  doubles.spawn.mockReturnValue({ child: { stdout: null, stderr: null }, terminate });
  await expect(runGoalGit('/project', ['diff'], 100, undefined)).rejects.toThrow();
  expect(terminate).toHaveBeenCalledOnce();
});
