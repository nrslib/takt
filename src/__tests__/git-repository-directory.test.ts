import { beforeEach, expect, it, vi } from 'vitest';
import { resolveGitRepositoryDirectory } from '../infra/task/gitRepositoryDirectory.js';

const doubles = vi.hoisted(() => ({ exec: vi.fn(), realpath: vi.fn(), environment: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => doubles.exec }));
vi.mock('node:fs/promises', () => ({ realpath: doubles.realpath }));
vi.mock('../infra/task/git-environment.js', () => ({ buildSafeGitEnvironment: doubles.environment }));
beforeEach(() => vi.resetAllMocks());

it('resolves the canonical Git root with hooks and filters disabled', async () => {
  doubles.realpath.mockResolvedValueOnce('/canonical/subdirectory').mockResolvedValueOnce('/canonical');
  const environment = { LANG: 'C' };
  doubles.environment.mockResolvedValue(environment);
  doubles.exec.mockResolvedValue({ stdout: '/root-alias\r\n' });
  expect(await resolveGitRepositoryDirectory('/supplied')).toBe('/canonical');
  expect(doubles.environment).toHaveBeenCalledExactlyOnceWith('/canonical/subdirectory', { allowGitHooks: false, allowGitFilters: false });
  expect(doubles.exec).toHaveBeenCalledExactlyOnceWith('git', ['rev-parse', '--show-toplevel'], {
    cwd: '/canonical/subdirectory', encoding: 'utf8', env: environment,
  });
  expect(doubles.realpath).toHaveBeenLastCalledWith('/root-alias');
});

it('rejects an invalid repository without returning the supplied path', async () => {
  doubles.realpath.mockResolvedValue('/canonical');
  doubles.environment.mockResolvedValue({});
  const failure = new Error('not a repository');
  doubles.exec.mockRejectedValue(failure);
  await expect(resolveGitRepositoryDirectory('/supplied')).rejects.toBe(failure);
  expect(doubles.realpath).toHaveBeenCalledOnce();
});
