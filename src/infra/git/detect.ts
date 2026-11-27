/**
 * VCS provider auto-detection from git remote URL.
 *
 * Examines the `origin` remote URL to determine whether the repository
 * is hosted on GitHub or GitLab.  Returns `undefined` for unknown hosts
 * (e.g. self-hosted instances), so callers can fall back to explicit
 * configuration or a default provider.
 */

import { execFileSync } from 'node:child_process';
import type { VcsProviderType } from '../../core/models/vcs-types.js';

export { VCS_PROVIDER_TYPES } from '../../core/models/vcs-types.js';
export type { VcsProviderType } from '../../core/models/vcs-types.js';

// Only public SaaS hosts are mapped here. Self-hosted instances
// (e.g. gitlab.example.com) are not auto-detected — set `vcs_provider`
// in project or global config (.takt/config.yaml) to specify the provider.
const HOST_MAP: ReadonlyMap<string, VcsProviderType> = new Map([
  ['github.com', 'github'],
  ['gitlab.com', 'gitlab'],
]);

const REMOTE_URL_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:']);
const WEB_REMOTE_URL_PROTOCOLS = new Set(['https:', 'http:']);
const SCHEME_PREFIX_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;
// scp-like syntax: [user@]host:path, with no slash before the colon. The host
// needs two characters so that a Windows drive letter is not read as a host.
const SCP_LIKE_URL_REGEX = /^(?:[^@/\s]+@)?([^@/:\s]{2,}):(.+)$/;
const REPOSITORY_PATH_SEGMENT_REGEX = /^[\w.-]+$/;
// A hostname as it can appear in a git remote: DNS characters, or a bracketed IPv6 literal. Anything else
// (`#`, `\`, `^`, ...) is not a host takt may put into an environment variable for gh / glab.
const HOSTNAME_REGEX = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/;

/** Repository location parsed from a git remote URL, without any userinfo. */
export interface RemoteRepository {
  /** Lower-case hostname without port. */
  readonly hostname: string;
  /** Hostname plus a non-default port, kept only for http(s) remotes where it is the web port. */
  readonly webHost: string;
  /** Scheme of the web endpoint: the remote's own for http(s), otherwise `https`. */
  readonly webScheme: 'http' | 'https';
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
    if (!HOSTNAME_REGEX.test(hostname)) return undefined;
    const webHost = WEB_REMOTE_URL_PROTOCOLS.has(parsed.protocol) ? parsed.host.toLowerCase() : hostname;
    const webScheme = parsed.protocol === 'http:' ? 'http' : 'https';
    return { hostname, webHost, webScheme, path };
  }

  const match = SCP_LIKE_URL_REGEX.exec(trimmed);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const path = normalizeRepositoryPathForIdentity(match[2]);
  if (path === undefined) return undefined;
  const hostname = match[1].toLowerCase();
  if (!HOSTNAME_REGEX.test(hostname)) return undefined;
  return { hostname, webHost: hostname, webScheme: 'https', path };
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
  const url = getOriginRemoteUrl(cwd);
  if (url === undefined) return undefined;
  return extractHostname(url);
}

/**
 * Get repository identifiers that must not be sent to an automatic router.
 *
 * Both the full owner/group path and the repository basename are returned so
 * routing text such as "owner/private-repo" and "private-repo" can be redacted.
 */
export function getRemoteRepositoryIdentifiers(cwd: string): string[] {
  const url = getOriginRemoteUrl(cwd);
  if (url === undefined) return [];

  const repositoryPath = extractRepositoryPath(url);
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

  return HOST_MAP.get(hostname);
}
