/**
 * Repository identity for child processes of tasks that run in a clone.
 *
 * A `worktree: true` task runs in a clone whose `origin` is removed, so
 * `gh` / `glab` cannot infer the repository from git remotes there. The
 * identity is derived from the project root's `origin` and passed through the
 * CLIs' own environment variables. No remote and no credential is added.
 */

import { resolveConfigValue } from '../config/resolveConfigValue.js';
import {
  detectVcsProviderFromHostname,
  getOriginRemoteUrl,
  parseRemoteRepositoryUrl,
  type RemoteRepository,
} from './detect.js';
import type { VcsProviderType } from './detect.js';

const GITHUB_DEFAULT_HOST = 'github.com';
// glab reads a token from these variables (`glab config --help`, `token` key).
const GITLAB_ENV_TOKEN_KEYS = ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN'] as const;
// glab reads its default host from these variables, first one set wins.
const GITLAB_ENV_HOST_KEYS = ['GITLAB_HOST', 'GITLAB_URI', 'GL_HOST'] as const;

function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return value !== undefined && value !== '';
}

function hostnameOf(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function buildGitHubEnv(remote: RemoteRepository, ambientEnv: NodeJS.ProcessEnv): Record<string, string> {
  if (isSet(ambientEnv, 'GH_REPO') || remote.path.split('/').length !== 2) return {};
  // OWNER/REPO resolves against GH_HOST when it is set, so name github.com then.
  // webHost keeps a non-default http(s) port, which gh uses as part of the API host.
  const needsHost = remote.webHost !== GITHUB_DEFAULT_HOST || isSet(ambientEnv, 'GH_HOST');
  return { GH_REPO: needsHost ? `${remote.webHost}/${remote.path}` : remote.path };
}

function buildGitLabEnv(remote: RemoteRepository, ambientEnv: NodeJS.ProcessEnv): Record<string, string> {
  if (isSet(ambientEnv, 'GITLAB_REPO')) return {};
  // glab sends a token from the environment to the host named by GITLAB_REPO.
  // When such a token is present, name the repository only if the caller's
  // own host variable already points at the same host, so the token never
  // reaches a host it was not meant for.
  if (GITLAB_ENV_TOKEN_KEYS.some((key) => isSet(ambientEnv, key))) {
    const hostKey = GITLAB_ENV_HOST_KEYS.find((key) => isSet(ambientEnv, key));
    const configuredHost = hostKey === undefined ? undefined : ambientEnv[hostKey];
    if (configuredHost === undefined || hostnameOf(configuredHost) !== remote.hostname) return {};
  }
  // The URL form keeps the host and nested groups unambiguous: glab treats a
  // plain `host/group/project` as a group path unless the host is configured.
  return { GITLAB_REPO: `https://${remote.webHost}/${remote.path}` };
}

/**
 * Build the repository identity variables for a parsed origin.
 *
 * Variables already set in `ambientEnv` are never overridden; an undetected
 * provider yields no variables.
 */
export function buildRepositoryIdentityEnv(
  remote: RemoteRepository,
  provider: VcsProviderType | undefined,
  ambientEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  switch (provider) {
    case 'github':
      return buildGitHubEnv(remote, ambientEnv);
    case 'gitlab':
      return buildGitLabEnv(remote, ambientEnv);
    case undefined:
      return {};
  }
}

/**
 * Resolve repository identity variables from the project root's `origin`.
 *
 * The provider is `vcs_provider` from config (project, then global) when set,
 * otherwise detected from the origin hostname.
 */
export function resolveRepositoryIdentityEnv(
  projectCwd: string,
  ambientEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const url = getOriginRemoteUrl(projectCwd);
  const remote = url === undefined ? undefined : parseRemoteRepositoryUrl(url);
  if (remote === undefined) return {};
  const provider = resolveConfigValue(projectCwd, 'vcsProvider') ?? detectVcsProviderFromHostname(remote.hostname);
  return buildRepositoryIdentityEnv(remote, provider, ambientEnv);
}

/**
 * A task in a clone has no `origin`, so `gh` / `glab` cannot find the
 * repository there. Name it from the project root's origin. A task in the
 * project root keeps its remotes and the CLIs' own choice (for example
 * `gh repo set-default`), so nothing is added there.
 */
export function withRepositoryIdentityEnv(
  childProcessEnv: Readonly<Record<string, string>> | undefined,
  cwd: string,
  projectCwd: string,
  ambientEnv: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> | undefined {
  if (cwd === projectCwd) {
    return childProcessEnv;
  }
  const identityEnv = resolveRepositoryIdentityEnv(projectCwd, ambientEnv);
  if (Object.keys(identityEnv).length === 0) {
    return childProcessEnv;
  }
  return { ...childProcessEnv, ...identityEnv };
}
