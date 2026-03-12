/**
 * Provider-neutral formatting utilities for issues and PRs.
 *
 * These functions operate on the generic Issue / PrReviewData types
 * from git/types.ts and contain no provider-specific logic.
 */

import type { Issue, PrReviewData, CliStatus } from './types.js';

/**
 * Format an issue into task text for piece execution.
 *
 * Output format:
 * ```
 * ## Issue #6: Fix authentication bug
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
export function formatIssueAsTask(issue: Issue): string {
  const parts: string[] = [];

  parts.push(`## Issue #${issue.number}: ${issue.title}`);

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

/** Regex to match `#N` patterns (issue numbers) */
const ISSUE_NUMBER_REGEX = /^#(\d+)$/;

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
 * Format PR review data into task text for piece execution.
 */
export function formatPrReviewAsTask(prReview: PrReviewData): string {
  const parts: string[] = [];

  parts.push(`## PR #${prReview.number} Review Comments: ${prReview.title}`);

  if (prReview.body) {
    parts.push('');
    parts.push('### PR Description');
    parts.push(prReview.body);
  }

  if (prReview.reviews.length > 0) {
    parts.push('');
    parts.push('### Review Comments');
    for (const review of prReview.reviews) {
      const location = review.path
        ? `\n  File: ${review.path}${review.line ? `, Line: ${review.line}` : ''}`
        : '';
      parts.push(`**${review.author}**: ${review.body}${location}`);
    }
  }

  if (prReview.comments.length > 0) {
    parts.push('');
    parts.push('### Conversation Comments');
    for (const comment of prReview.comments) {
      parts.push(`**${comment.author}**: ${comment.body}`);
    }
  }

  if (prReview.files.length > 0) {
    parts.push('');
    parts.push('### Changed Files');
    for (const file of prReview.files) {
      parts.push(`- ${file}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build PR body from issues and execution report.
 * Supports multiple issues (adds "Closes #N" for each).
 */
export function buildPrBody(issues: Issue[] | undefined, report: string): string {
  const parts: string[] = [];

  parts.push('## Summary');
  if (issues && issues.length > 0) {
    parts.push('');
    parts.push(issues[0]!.body || issues[0]!.title);
  }

  parts.push('');
  parts.push('## Execution Report');
  parts.push('');
  parts.push(report);

  if (issues && issues.length > 0) {
    parts.push('');
    parts.push(issues.map((issue) => `Closes #${issue.number}`).join('\n'));
  }

  return parts.join('\n');
}

/**
 * Resolve issue references in a task string.
 * If task contains `#N` patterns (space-separated), fetches issues and returns formatted text.
 * Otherwise returns the task string as-is.
 *
 * Checks VCS CLI availability before fetching.
 * Throws if VCS CLI is not available or issue fetch fails.
 */
export function resolveIssueTask(
  task: string,
  getProvider: () => { checkCliStatus(): CliStatus; fetchIssue(n: number): Issue },
): string {
  const tokens = task.trim().split(/\s+/);
  const issueNumbers = parseIssueNumbers(tokens);

  if (issueNumbers.length === 0) {
    return task;
  }

  const provider = getProvider();
  const cliStatus = provider.checkCliStatus();
  if (!cliStatus.available) {
    throw new Error(cliStatus.error);
  }

  const issues = issueNumbers.map((n) => provider.fetchIssue(n));
  return issues.map(formatIssueAsTask).join('\n\n---\n\n');
}
