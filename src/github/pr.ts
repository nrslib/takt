/**
 * GitHub Pull Request utilities
 *
 * Creates PRs via `gh` CLI for CI/CD integration.
 */

import { execFileSync } from 'node:child_process';
import { createLogger } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';
import { checkGhCli, type GitHubIssue } from './issue.js';

const log = createLogger('github-pr');

export interface CreatePrOptions {
  /** Branch to create PR from */
  branch: string;
  /** PR title */
  title: string;
  /** PR body (markdown) */
  body: string;
  /** Base branch (default: repo default branch) */
  base?: string;
  /** Repository in owner/repo format (optional, uses current repo if omitted) */
  repo?: string;
}

export interface CreatePrResult {
  success: boolean;
  /** PR URL on success */
  url?: string;
  /** Error message on failure */
  error?: string;
}

/**
 * Push a branch to origin.
 * Throws on failure.
 */
export function pushBranch(cwd: string, branch: string): void {
  log.info('Pushing branch to origin', { branch });
  execFileSync('git', ['push', 'origin', branch], {
    cwd,
    stdio: 'pipe',
  });
}

/**
 * Create a Pull Request via `gh pr create`.
 */
export function createPullRequest(cwd: string, options: CreatePrOptions): CreatePrResult {
  const ghStatus = checkGhCli();
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error ?? 'gh CLI is not available' };
  }

  const args = [
    'pr', 'create',
    '--title', options.title,
    '--body', options.body,
    '--head', options.branch,
  ];

  if (options.base) {
    args.push('--base', options.base);
  }

  if (options.repo) {
    args.push('--repo', options.repo);
  }

  log.info('Creating PR', { branch: options.branch, title: options.title });

  try {
    const output = execFileSync('gh', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const url = output.trim();
    log.info('PR created', { url });

    return { success: true, url };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('PR creation failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/**
 * Build PR body from issue and execution report.
 */
export function buildPrBody(issue: GitHubIssue | undefined, report: string): string {
  const parts: string[] = [];

  parts.push('## Summary');
  if (issue) {
    parts.push('');
    parts.push(issue.body || issue.title);
  }

  parts.push('');
  parts.push('## Execution Report');
  parts.push('');
  parts.push(report);

  if (issue) {
    parts.push('');
    parts.push(`Closes #${issue.number}`);
  }

  return parts.join('\n');
}
