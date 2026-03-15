/**
 * GitLab CLI shared utilities
 *
 * Common functions used by both issue.ts and pr.ts to avoid cross-module coupling.
 */

import { execFileSync } from 'node:child_process';
import { MAX_PAGES } from '../git/constants.js';
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
 */
export function checkGlabCli(): CliStatus {
  try {
    execFileSync('glab', ['auth', 'status'], { stdio: 'pipe' });
    return { available: true };
  } catch {
    try {
      execFileSync('glab', ['--version'], { stdio: 'pipe' });
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
export function fetchAllPages<T>(endpoint: string, perPage: number, context: string): T[] {
  const all: T[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const raw = execFileSync(
      'glab',
      ['api', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
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
