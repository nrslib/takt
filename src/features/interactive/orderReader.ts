/**
 * Order reader for retry/instruct modes.
 *
 * Reads the previous order.md from a run's context directory
 * to inject into conversation system prompts.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find and read the previous order.md content from a run directory.
 *
 * When runSlug is provided, reads directly from that run's context.
 * When runSlug is null, scans .takt/runs/ directories in reverse order
 * and returns the first order.md found.
 *
 * @returns The order.md content, or null if not found.
 */
export function findPreviousOrderContent(worktreeCwd: string, runSlug: string | null): string | null {
  if (runSlug) {
    return readOrderFromRun(worktreeCwd, runSlug);
  }

  return findOrderFromLatestRun(worktreeCwd);
}

function readOrderFromRun(worktreeCwd: string, slug: string): string | null {
  const orderPath = join(worktreeCwd, '.takt', 'runs', slug, 'context', 'task', 'order.md');
  if (!existsSync(orderPath)) {
    return null;
  }
  const content = readFileSync(orderPath, 'utf-8').trim();
  return content || null;
}

function findOrderFromLatestRun(worktreeCwd: string): string | null {
  const runsDir = join(worktreeCwd, '.takt', 'runs');
  if (!existsSync(runsDir)) {
    return null;
  }

  const entries = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();

  for (const slug of entries) {
    const content = readOrderFromRun(worktreeCwd, slug);
    if (content) {
      return content;
    }
  }

  return null;
}
