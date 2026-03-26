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
