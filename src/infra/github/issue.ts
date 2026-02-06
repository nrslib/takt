/**
 * GitHub Issue utilities
 *
 * Fetches issue content via `gh` CLI and formats it as task text
 * for piece execution or task creation.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { GitHubIssue, GhCliStatus, CreateIssueOptions, CreateIssueResult } from './types.js';

export type { GitHubIssue, GhCliStatus, CreateIssueOptions, CreateIssueResult };

const log = createLogger('github');

/** Regex to match `#N` patterns (issue numbers) */
const ISSUE_NUMBER_REGEX = /^#(\d+)$/;

/**
 * Check if `gh` CLI is available and authenticated.
 */
export function checkGhCli(): GhCliStatus {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
    return { available: true };
  } catch {
    try {
      execFileSync('gh', ['--version'], { stdio: 'pipe' });
      return {
        available: false,
        error: 'gh CLI is installed but not authenticated. Run `gh auth login` first.',
      };
    } catch {
      return {
        available: false,
        error: 'gh CLI is not installed. Install it from https://cli.github.com/',
      };
    }
  }
}

/**
 * Fetch issue content via `gh issue view`.
 * Throws on failure (issue not found, network error, etc.).
 */
export function fetchIssue(issueNumber: number): GitHubIssue {
  log.debug('Fetching issue', { issueNumber });

  const raw = execFileSync(
    'gh',
    ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels,comments'],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const data = JSON.parse(raw) as {
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    comments: Array<{ author: { login: string }; body: string }>;
  };

  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    labels: data.labels.map((l) => l.name),
    comments: data.comments.map((c) => ({
      author: c.author.login,
      body: c.body,
    })),
  };
}

/**
 * Format a GitHub issue into task text for piece execution.
 *
 * Output format:
 * ```
 * ## GitHub Issue #6: Fix authentication bug
 *
 * {body}
 *
 * ### Labels
 * bug, priority:high
 *
 * ### Comments
 * **user1**: Comment body...
 * ```
 */
export function formatIssueAsTask(issue: GitHubIssue): string {
  const parts: string[] = [];

  parts.push(`## GitHub Issue #${issue.number}: ${issue.title}`);

  if (issue.body) {
    parts.push('');
    parts.push(issue.body);
  }

  if (issue.labels.length > 0) {
    parts.push('');
    parts.push('### Labels');
    parts.push(issue.labels.join(', '));
  }

  if (issue.comments.length > 0) {
    parts.push('');
    parts.push('### Comments');
    for (const comment of issue.comments) {
      parts.push(`**${comment.author}**: ${comment.body}`);
    }
  }

  return parts.join('\n');
}

/**
 * Parse `#N` patterns from argument strings.
 * Returns issue numbers found, or empty array if none.
 *
 * Each argument must be exactly `#N` (no mixed text).
 * Examples:
 *   ['#6'] → [6]
 *   ['#6', '#7'] → [6, 7]
 *   ['Fix bug'] → []
 *   ['#6', 'and', '#7'] → [] (mixed, not all are issue refs)
 */
export function parseIssueNumbers(args: string[]): number[] {
  if (args.length === 0) return [];

  const numbers: number[] = [];
  for (const arg of args) {
    const match = arg.match(ISSUE_NUMBER_REGEX);
    if (!match?.[1]) return []; // Not all args are issue refs
    numbers.push(Number.parseInt(match[1], 10));
  }

  return numbers;
}

/**
 * Check if a single task string is an issue reference (`#N`).
 */
export function isIssueReference(task: string): boolean {
  return ISSUE_NUMBER_REGEX.test(task.trim());
}

/**
 * Resolve issue references in a task string.
 * If task contains `#N` patterns (space-separated), fetches issues and returns formatted text.
 * Otherwise returns the task string as-is.
 *
 * Checks gh CLI availability before fetching.
 * Throws if gh CLI is not available or issue fetch fails.
 */
export function resolveIssueTask(task: string): string {
  const tokens = task.trim().split(/\s+/);
  const issueNumbers = parseIssueNumbers(tokens);

  if (issueNumbers.length === 0) {
    return task;
  }

  const ghStatus = checkGhCli();
  if (!ghStatus.available) {
    throw new Error(ghStatus.error ?? 'gh CLI is not available');
  }

  log.info('Resolving issue references', { issueNumbers });

  const issues = issueNumbers.map((n) => fetchIssue(n));
  return issues.map(formatIssueAsTask).join('\n\n---\n\n');
}

/**
 * Create a GitHub Issue via `gh issue create`.
 */
export function createIssue(options: CreateIssueOptions): CreateIssueResult {
  const ghStatus = checkGhCli();
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  const args = ['issue', 'create', '--title', options.title, '--body', options.body];
  if (options.labels && options.labels.length > 0) {
    args.push('--label', options.labels.join(','));
  }

  log.info('Creating issue', { title: options.title });

  try {
    const output = execFileSync('gh', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const url = output.trim();
    log.info('Issue created', { url });

    return { success: true, url };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('Issue creation failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}
