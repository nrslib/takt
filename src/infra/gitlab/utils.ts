/**
 * GitLab CLI shared utilities
 *
 * Common functions used by both issue.ts and pr.ts to avoid cross-module coupling.
 */

import { execFileSync } from 'node:child_process';
import { MAX_PAGES } from '../git/constants.js';
import { getRemoteHostname } from '../git/detect.js';
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
 * Paginates through results until a page returns fewer than `perPage` items
 * or `MAX_PAGES` is reached (whichever comes first).
 */
export function fetchAllPages<T>(endpoint: string, perPage: number, context: string, cwd: string): T[] {
  const all: T[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const raw = execFileSync(
      'glab',
      ['api', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`],
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const items = parseJson<T[]>(raw, context);

    all.push(...items);

    if (items.length < perPage) {
      break;
    }

    page += 1;
  }

  return all;
}
