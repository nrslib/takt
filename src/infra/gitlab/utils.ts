/**
 * GitLab CLI shared utilities
 *
 * Common functions used by both issue.ts and pr.ts to avoid cross-module coupling.
 */

import { execFileSync } from 'node:child_process';
import { getRemoteHostname } from '../git/detect.js';
import { fetchPaginatedApi } from '../git/paginated-api.js';
import type { CliStatus } from '../git/types.js';

export const ITEMS_PER_PAGE = 100;

export function parseJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`glab returned invalid JSON (${context})`);
  }
}

/**
 * Check if `glab` CLI is available and authenticated.
 *
 * When `cwd` is provided, the hostname of the `origin` remote is extracted
 * and `glab auth status --hostname <host>` is used so that only the
 * target host's authentication state is evaluated (not all configured hosts).
 */
export function checkGlabCli(cwd: string): CliStatus {
  const hostname = getRemoteHostname(cwd);
  const authArgs = hostname
    ? ['auth', 'status', '--hostname', hostname]
    : ['auth', 'status'];

  try {
    execFileSync('glab', authArgs, { cwd, stdio: 'pipe' });
    return { available: true };
  } catch {
    try {
      execFileSync('glab', ['--version'], { cwd, stdio: 'pipe' });
      return {
        available: false,
        error: 'glab CLI is installed but not authenticated. Run `glab auth login` first.',
      };
    } catch {
      return {
        available: false,
        error: 'glab CLI is not installed. Install it from https://gitlab.com/gitlab-org/cli',
      };
    }
  }
}

/**
 * Fetch all pages from a GitLab API endpoint via `glab api`.
 *
 * Follows the API pagination link header until no next page remains.
 */
export function fetchAllPages<T>(endpoint: string, perPage: number, context: string, cwd: string): T[] {
  return fetchPaginatedApi<T>({
    command: 'glab',
    cwd,
    context,
    initialEndpoint: `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${perPage}&page=1`,
    apiPrefix: '/api/v4/',
    parsePage: (body, pageContext) => parseJson<T[]>(body, pageContext),
  });
}
