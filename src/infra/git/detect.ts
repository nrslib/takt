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
const HOST_MAP: Record<string, VcsProviderType> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
};

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

  return HOST_MAP[hostname];
}
