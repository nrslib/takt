/**
 * VCS provider auto-detection from git remote URL.
 *
 * Examines the `origin` remote URL to determine whether the repository
 * is hosted on GitHub or GitLab.  Returns `undefined` for hosts that the
 * rules below do not recognise, so callers can fall back to explicit
 * configuration or a default provider.
 */

import { execFileSync } from 'node:child_process';
import { VCS_PROVIDER_TYPES as PROVIDER_TYPES, type VcsProviderType } from '../../core/models/vcs-types.js';

export { VCS_PROVIDER_TYPES } from '../../core/models/vcs-types.js';
export type { VcsProviderType } from '../../core/models/vcs-types.js';

// Public SaaS hosts are matched exactly first. Other hosts fall back to
// detectVcsProviderFromHostname's label rule; anything else needs
// `vcs_provider` in project or global config (.takt/config.yaml).
const HOST_MAP: Record<string, VcsProviderType> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
};

// GitHub Enterprise Cloud with data residency serves each enterprise from a
// subdomain of ghe.com (see `gh help environment`).
const GITHUB_HOSTED_SUFFIXES = ['.ghe.com'] as const;

const REMOTE_URL_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:']);
const WEB_REMOTE_URL_PROTOCOLS = new Set(['https:', 'http:']);
const SCHEME_PREFIX_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;
// scp-like syntax: [user@]host:path, with no slash before the colon. The host
// needs two characters so that a Windows drive letter is not read as a host.
const SCP_LIKE_URL_REGEX = /^(?:[^@/\s]+@)?([^@/:\s]{2,}):(.+)$/;
const REPOSITORY_PATH_SEGMENT_REGEX = /^[\w.-]+$/;
// Last label of a real hostname. Rejects ssh config aliases such as
// `github.com-work`, which name a host only through ~/.ssh/config.
const TOP_LEVEL_LABEL_REGEX = /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/;

/** Repository location parsed from a git remote URL, without any userinfo. */
export interface RemoteRepository {
  /** Lower-case hostname without port. */
  readonly hostname: string;
  /** Hostname plus a non-default port, kept only for http(s) remotes where it is the web port. */
  readonly webHost: string;
  /** Repository path without surrounding slashes or `.git`, e.g. `group/sub/project`. */
  readonly path: string;
}

function normalizeRepositoryPathForIdentity(rawPath: string): string | undefined {
  const path = rawPath.replace(/\/+$/, '').replace(/^\/+/, '').replace(/\.git$/i, '');
  const segments = path.split('/');
  if (segments.length < 2) return undefined;
  const valid = segments.every((segment) =>
    REPOSITORY_PATH_SEGMENT_REGEX.test(segment) && segment !== '.' && segment !== '..');
  return valid ? path : undefined;
}

/**
 * Parse a git remote URL into host and repository path.
 *
 * Accepts `https://`, `http://`, `ssh://`, `git://`, and scp-like
 * `[user@]host:path` URLs. Userinfo (user names, passwords, tokens) is
 * dropped and never returned. Returns `undefined` for local paths, other
 * schemes, a path with fewer than two segments, or a path segment outside
 * `[A-Za-z0-9_.-]`.
 */
export function parseRemoteRepositoryUrl(url: string): RemoteRepository | undefined {
  const trimmed = url.trim();
  if (SCHEME_PREFIX_REGEX.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (!REMOTE_URL_PROTOCOLS.has(parsed.protocol) || parsed.hostname === '') return undefined;
    const path = normalizeRepositoryPathForIdentity(parsed.pathname);
    if (path === undefined) return undefined;
    const hostname = parsed.hostname.toLowerCase();
    const webHost = WEB_REMOTE_URL_PROTOCOLS.has(parsed.protocol) ? parsed.host.toLowerCase() : hostname;
    return { hostname, webHost, path };
  }

  const match = SCP_LIKE_URL_REGEX.exec(trimmed);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const path = normalizeRepositoryPathForIdentity(match[2]);
  if (path === undefined) return undefined;
  const hostname = match[1].toLowerCase();
  return { hostname, webHost: hostname, path };
}

/**
 * Detect the VCS provider from a hostname.
 *
 * 1. Exact public hosts: `github.com`, `gitlab.com`.
 * 2. Subdomains of `ghe.com` are GitHub.
 * 3. A dotted hostname with exactly one DNS label equal to `github` or
 *    `gitlab` (case-insensitive) is that provider, e.g. `github.example.com`
 *    or `git.gitlab.example.org`. A hostname with both labels or neither is
 *    not detected, nor one whose last label is not a top-level domain (a
 *    single label or an ssh alias such as `github.com-work`). Substrings do
 *    not count: `mygithub.example.com` is not detected.
 */
export function detectVcsProviderFromHostname(hostname: string): VcsProviderType | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const exact = HOST_MAP[host];
  if (exact !== undefined) return exact;
  if (GITHUB_HOSTED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'github';

  const labels = host.split('.');
  if (labels.length < 2 || !TOP_LEVEL_LABEL_REGEX.test(labels.at(-1) ?? '')) return undefined;
  const matches = PROVIDER_TYPES.filter((type) => labels.includes(type));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Read the `origin` remote URL of the repository at `cwd`.
 *
 * The URL may contain credentials; callers must not log or persist it.
 */
export function getOriginRemoteUrl(cwd: string): string | undefined {
  try {
    const url = String(
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

// SSH URL pattern: git@<host>:<path>
const SSH_URL_REGEX = /^[\w.-]+@([\w.-]+):/;

function extractHostname(url: string): string | undefined {
  // Try HTTPS / generic URL first
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    // Not a standard URL — try SSH pattern
  }

  const match = SSH_URL_REGEX.exec(url);
  if (match) {
    return match[1];
  }

  return undefined;
}

function extractRepositoryPath(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    const match = /^[\w.-]+@[\w.-]+:(.+)$/.exec(url);
    if (match?.[1] === undefined) return undefined;
    path = match[1];
  }

  const normalized = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  return normalized || undefined;
}

/**
 * Get the hostname of the `origin` remote URL.
 *
 * @param cwd - Working directory for the git command
 * @returns hostname string or `undefined` if unavailable
 */
export function getRemoteHostname(cwd: string): string | undefined {
  let output: string;
  try {
    output = String(
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return undefined;
  }

  const url = output.trim();
  if (!url) {
    return undefined;
  }

  return extractHostname(url);
}

/**
 * Get repository identifiers that must not be sent to an automatic router.
 *
 * Both the full owner/group path and the repository basename are returned so
 * routing text such as "owner/private-repo" and "private-repo" can be redacted.
 */
export function getRemoteRepositoryIdentifiers(cwd: string): string[] {
  let output: string;
  try {
    output = String(
      execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return [];
  }

  const repositoryPath = extractRepositoryPath(output.trim());
  if (repositoryPath === undefined) return [];
  const repositoryName = repositoryPath.split('/').at(-1);
  return repositoryName === undefined || repositoryName === repositoryPath
    ? [repositoryPath]
    : [repositoryPath, repositoryName];
}

/**
 * Detect VCS provider from the `origin` remote URL.
 *
 * @returns `'github'` | `'gitlab'` | `undefined`
 */
export function detectVcsProvider(cwd?: string): VcsProviderType | undefined {
  const hostname = getRemoteHostname(cwd ?? process.cwd());
  if (!hostname) {
    return undefined;
  }

  return detectVcsProviderFromHostname(hostname);
}
