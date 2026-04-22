/**
 * Provider-neutral formatting utilities for issues and PRs.
 *
 * These functions operate on the generic Issue / PrReviewData types
 * from git/types.ts and contain no provider-specific logic.
 */

import type { CreatePrOptions, Issue, PrReviewData } from './types.js';

export const TAKT_MANAGED_PR_MARKER = '<!-- takt:managed -->';

export function isTaktManagedPrBody(body: string | null | undefined): boolean {
  if (!body) {
    return false;
  }
  return body.includes(TAKT_MANAGED_PR_MARKER);
}

function appendTaktManagedPrMarker(body: string): string {
  if (body.includes(TAKT_MANAGED_PR_MARKER)) {
    return body;
  }
  return `${body}\n\n${TAKT_MANAGED_PR_MARKER}`;
}

export function buildTaktManagedPrOptions(body: string): Pick<CreatePrOptions, 'body'> {
  return {
    body: appendTaktManagedPrMarker(body),
  };
}

/**
 * Format an issue into task text for workflow execution.
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
 * Format PR review data into task text for workflow execution.
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
