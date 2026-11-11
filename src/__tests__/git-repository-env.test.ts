/**
 * Tests for repository identity injection into clone child processes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const mockResolveConfigValue = vi.fn();
vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: (...args: unknown[]) => mockResolveConfigValue(...args),
}));

import {
  detectVcsProviderFromHostname,
  parseRemoteRepositoryUrl,
} from '../infra/git/detect.js';
import {
  buildRepositoryIdentityEnv,
  resolveRepositoryIdentityEnv,
  withRepositoryIdentityEnv,
} from '../infra/git/repository-env.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveConfigValue.mockReturnValue(undefined);
});

describe('parseRemoteRepositoryUrl', () => {
  it.each([
    ['git@github.com:owner/repo.git', { hostname: 'github.com', webHost: 'github.com', path: 'owner/repo' }],
    ['github.com:owner/repo', { hostname: 'github.com', webHost: 'github.com', path: 'owner/repo' }],
    ['ssh://git@github.example.com/owner/repo.git', { hostname: 'github.example.com', webHost: 'github.example.com', path: 'owner/repo' }],
    ['ssh://git@gitlab.example.com:2222/group/sub/project.git', { hostname: 'gitlab.example.com', webHost: 'gitlab.example.com', path: 'group/sub/project' }],
    ['https://github.com/owner/repo', { hostname: 'github.com', webHost: 'github.com', path: 'owner/repo' }],
    ['https://github.com/owner/repo.git/', { hostname: 'github.com', webHost: 'github.com', path: 'owner/repo' }],
    ['https://user:secret-token@GitLab.Example.com/group/project.git', { hostname: 'gitlab.example.com', webHost: 'gitlab.example.com', path: 'group/project' }],
    ['https://oauth2@gitlab.example.com:8443/a/b/c/d.git', { hostname: 'gitlab.example.com', webHost: 'gitlab.example.com:8443', path: 'a/b/c/d' }],
    ['  https://github.com/owner/repo.git\n', { hostname: 'github.com', webHost: 'github.com', path: 'owner/repo' }],
  ])('parses %s', (url, expected) => {
    expect(parseRemoteRepositoryUrl(url)).toEqual(expected);
  });

  it('never returns the userinfo of the URL', () => {
    const parsed = parseRemoteRepositoryUrl('https://user:secret-token@github.com/owner/repo.git');

    expect(JSON.stringify(parsed)).not.toContain('secret-token');
    expect(JSON.stringify(parsed)).not.toContain('user');
  });

  it.each([
    'not-a-url',
    '',
    '/srv/git/repo.git',
    'file:///srv/git/owner/repo.git',
    'C:/repos/owner/repo',
    'https://github.com/repo-only.git',
    'git@github.com:repo-only.git',
    'https://github.com/owner/repo%20name',
    'https://github.com/owner/../repo',
  ])('returns undefined for %j', (url) => {
    expect(parseRemoteRepositoryUrl(url)).toBeUndefined();
  });
});

describe('detectVcsProviderFromHostname', () => {
  it.each([
    ['github.com', 'github'],
    ['gitlab.com', 'gitlab'],
    ['github.example.com', 'github'],
    ['gitlab.example.com', 'gitlab'],
    ['git.gitlab.example.org', 'gitlab'],
    ['GitHub.Example.COM', 'github'],
    ['GITLAB.COM', 'gitlab'],
    ['octocorp.ghe.com', 'github'],
    ['ghe.corp.example', undefined],
    ['github.gitlab.example.com', undefined],
    ['mygithub.example.com', undefined],
    ['github', undefined],
    ['github.com-work', undefined],
    ['gitlab.internal-2', undefined],
    ['bitbucket.org', undefined],
  ])('%s -> %s', (hostname, expected) => {
    expect(detectVcsProviderFromHostname(hostname)).toBe(expected);
  });
});

describe('buildRepositoryIdentityEnv', () => {
  const github = { hostname: 'github.com', webHost: 'github.com', path: 'owner/repo' };
  const ghe = { hostname: 'github.example.com', webHost: 'github.example.com', path: 'owner/repo' };
  const gitlab = { hostname: 'gitlab.example.com', webHost: 'gitlab.example.com', path: 'group/sub/project' };

  it('sets GH_REPO without a host for github.com', () => {
    expect(buildRepositoryIdentityEnv(github, 'github', {})).toEqual({ GH_REPO: 'owner/repo' });
  });

  it('prefixes the host for another GitHub host', () => {
    expect(buildRepositoryIdentityEnv(ghe, 'github', {})).toEqual({ GH_REPO: 'github.example.com/owner/repo' });
  });

  it('prefixes github.com when the caller set GH_HOST', () => {
    expect(buildRepositoryIdentityEnv(github, 'github', { GH_HOST: 'github.example.com' }))
      .toEqual({ GH_REPO: 'github.com/owner/repo' });
  });

  it('skips GH_REPO for a nested path GitHub cannot have', () => {
    expect(buildRepositoryIdentityEnv(gitlab, 'github', {})).toEqual({});
  });

  it('sets GITLAB_REPO as a URL that keeps nested groups', () => {
    expect(buildRepositoryIdentityEnv(gitlab, 'gitlab', {}))
      .toEqual({ GITLAB_REPO: 'https://gitlab.example.com/group/sub/project' });
  });

  it.each([
    ['GH_REPO', 'github' as const, github],
    ['GITLAB_REPO', 'gitlab' as const, gitlab],
  ])('does not override %s set by the caller', (key, provider, remote) => {
    expect(buildRepositoryIdentityEnv(remote, provider, { [key]: 'caller/choice' })).toEqual({});
  });

  it('returns nothing for an undetected provider', () => {
    expect(buildRepositoryIdentityEnv(github, undefined, {})).toEqual({});
  });

  it('skips GITLAB_REPO when a GitLab token is set without a matching host', () => {
    expect(buildRepositoryIdentityEnv(gitlab, 'gitlab', { GITLAB_TOKEN: 'x' })).toEqual({});
    expect(buildRepositoryIdentityEnv(gitlab, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'gitlab.com' })).toEqual({});
  });

  it('compares the port too when a GitLab token is set', () => {
    const withPort = parseRemoteRepositoryUrl('https://gitlab.example.com:8443/group/project.git')!;

    // same hostname, different port: glab would send the token to the other port
    expect(buildRepositoryIdentityEnv(withPort, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'gitlab.example.com:9999' })).toEqual({});
    // the origin has a port, the configured host does not
    expect(buildRepositoryIdentityEnv(withPort, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'gitlab.example.com' })).toEqual({});
    // the origin has no port, the configured host names one
    expect(buildRepositoryIdentityEnv(gitlab, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'gitlab.example.com:8443' })).toEqual({});
    // an explicit http scheme is another endpoint even when URL.host drops its default port
    expect(buildRepositoryIdentityEnv(gitlab, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'http://gitlab.example.com:80' })).toEqual({});
    expect(buildRepositoryIdentityEnv(gitlab, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'http://gitlab.example.com' })).toEqual({});
    expect(buildRepositoryIdentityEnv(withPort, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'http://gitlab.example.com:8443' })).toEqual({});
    // same port, and a default port written out is the same host
    expect(buildRepositoryIdentityEnv(withPort, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'https://gitlab.example.com:8443' }))
      .toEqual({ GITLAB_REPO: 'https://gitlab.example.com:8443/group/project' });
    expect(buildRepositoryIdentityEnv(gitlab, 'gitlab', { GITLAB_TOKEN: 'x', GITLAB_HOST: 'https://gitlab.example.com:443' }))
      .toEqual({ GITLAB_REPO: 'https://gitlab.example.com/group/sub/project' });
  });

  it('sets GITLAB_REPO when a GitLab token is set for the same host', () => {
    expect(buildRepositoryIdentityEnv(gitlab, 'gitlab', {
      OAUTH_TOKEN: 'x', GITLAB_HOST: 'https://gitlab.example.com',
    })).toEqual({ GITLAB_REPO: 'https://gitlab.example.com/group/sub/project' });
  });
});

describe('buildRepositoryIdentityEnv GH_REPO host', () => {
  it('keeps the web port of a GitHub Enterprise Server origin', () => {
    const remote = parseRemoteRepositoryUrl('https://ghe.example.com:8443/owner/repo.git');

    expect(buildRepositoryIdentityEnv(remote!, 'github', {})).toEqual({
      GH_REPO: 'ghe.example.com:8443/owner/repo',
    });
  });

  it('does not add a port for an ssh origin, whose port is not the web port', () => {
    const remote = parseRemoteRepositoryUrl('ssh://git@ghe.example.com:2222/owner/repo.git');

    expect(buildRepositoryIdentityEnv(remote!, 'github', {})).toEqual({
      GH_REPO: 'ghe.example.com/owner/repo',
    });
  });

  it('names github.com explicitly when GH_HOST points elsewhere', () => {
    const remote = parseRemoteRepositoryUrl('https://github.com/owner/repo.git');

    expect(buildRepositoryIdentityEnv(remote!, 'github', { GH_HOST: 'ghe.example.com' })).toEqual({
      GH_REPO: 'github.com/owner/repo',
    });
  });
});

describe('resolveRepositoryIdentityEnv', () => {
  it('reads origin of the project root', () => {
    mockExecFileSync.mockReturnValue('git@github.example.com:owner/repo.git\n');

    expect(resolveRepositoryIdentityEnv('/project', {})).toEqual({ GH_REPO: 'github.example.com/owner/repo' });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['remote', 'get-url', 'origin'],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('lets vcs_provider override the hostname rule', () => {
    mockExecFileSync.mockReturnValue('https://code.example.com/group/sub/project.git\n');
    mockResolveConfigValue.mockReturnValue('gitlab');

    expect(resolveRepositoryIdentityEnv('/project', {}))
      .toEqual({ GITLAB_REPO: 'https://code.example.com/group/sub/project' });
    expect(mockResolveConfigValue).toHaveBeenCalledWith('/project', 'vcsProvider');
  });

  it('lets vcs_provider override a detected provider', () => {
    mockExecFileSync.mockReturnValue('https://gitlab.example.com/owner/repo.git\n');
    mockResolveConfigValue.mockReturnValue('github');

    expect(resolveRepositoryIdentityEnv('/project', {})).toEqual({ GH_REPO: 'gitlab.example.com/owner/repo' });
  });

  it('returns nothing when origin is absent', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('No such remote'); });

    expect(resolveRepositoryIdentityEnv('/project', {})).toEqual({});
  });

  it('returns nothing for an undetected host without config', () => {
    mockExecFileSync.mockReturnValue('git@ghe.corp.example:owner/repo.git\n');

    expect(resolveRepositoryIdentityEnv('/project', {})).toEqual({});
  });
});

describe('withRepositoryIdentityEnv', () => {
  const origin = () => mockExecFileSync.mockReturnValue('git@github.com:owner/repo.git\n');

  it('adds the repository identity to a task that runs in a clone', () => {
    origin();

    expect(withRepositoryIdentityEnv(undefined, '/clones/task', '/project', {})).toEqual({
      GH_REPO: 'owner/repo',
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['remote', 'get-url', 'origin'], expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('leaves the environment untouched for a task in the project root', () => {
    origin();
    const env = { TAKT_OBSERVABILITY: '{}' };

    expect(withRepositoryIdentityEnv(env, '/project', '/project', {})).toBe(env);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('merges with the observability variables and keeps them', () => {
    origin();

    expect(withRepositoryIdentityEnv({ TAKT_OBSERVABILITY: '{}' }, '/clones/task', '/project', {})).toEqual({
      TAKT_OBSERVABILITY: '{}',
      GH_REPO: 'owner/repo',
    });
  });

  it('returns the original environment when there is nothing to add', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no origin');
    });
    const env = { TAKT_OBSERVABILITY: '{}' };

    expect(withRepositoryIdentityEnv(env, '/clones/task', '/project', {})).toBe(env);
    expect(withRepositoryIdentityEnv(undefined, '/clones/task', '/project', {})).toBeUndefined();
  });

  it('keeps a repository variable the caller already set, and it wins over the derived one', () => {
    origin();

    expect(withRepositoryIdentityEnv(undefined, '/clones/task', '/project', { GH_REPO: 'other/repo' })).toEqual({
      GH_REPO: 'other/repo',
    });
  });

  it('keeps the caller\'s repository variables even when the origin yields nothing', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no origin');
    });

    expect(withRepositoryIdentityEnv({ TAKT_OBSERVABILITY: '{}' }, '/clones/task', '/project', {
      GITLAB_REPO: 'https://gitlab.example.com/group/project',
      GITLAB_TOKEN: 'secret',
      HOME: '/home/user',
    })).toEqual({
      TAKT_OBSERVABILITY: '{}',
      GITLAB_REPO: 'https://gitlab.example.com/group/project',
    });
  });

  it('does not carry a caller-set repository variable into the project root', () => {
    const env = { TAKT_OBSERVABILITY: '{}' };

    expect(withRepositoryIdentityEnv(env, '/project', '/project', { GH_REPO: 'other/repo' })).toBe(env);
  });
});
