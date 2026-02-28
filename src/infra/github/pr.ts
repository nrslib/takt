/**
 * GitHub Pull Request utilities
 *
 * Creates PRs via `gh` CLI for CI/CD integration.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { checkGhCli } from './issue.js';
import type { Issue, CreatePrOptions, CreatePrResult, ExistingPr, CommentResult, PrReviewData, PrReviewComment } from '../git/types.js';

const log = createLogger('github-pr');

/**
 * Find an open PR for the given branch.
 * Returns undefined if no PR exists.
 */
export function findExistingPr(cwd: string, branch: string): ExistingPr | undefined {
  const ghStatus = checkGhCli();
  if (!ghStatus.available) return undefined;

  try {
    const output = execFileSync(
      'gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1'],
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const prs = JSON.parse(output) as ExistingPr[];
    return prs[0];
  } catch (e) {
    log.debug('gh pr list failed, treating as no PR', { error: getErrorMessage(e) });
    return undefined;
  }
}

export function commentOnPr(cwd: string, prNumber: number, body: string): CommentResult {
  const ghStatus = checkGhCli();
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error ?? 'gh CLI is not available' };
  }

  try {
    execFileSync('gh', ['pr', 'comment', String(prNumber), '--body', body], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('PR comment failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/** JSON fields requested from `gh pr view` for review data */
const PR_REVIEW_JSON_FIELDS = 'number,title,body,url,headRefName,comments,reviews,files';

/** Raw shape returned by `gh pr view --json` for review data */
interface GhPrViewReviewResponse {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  comments: Array<{ author: { login: string }; body: string }>;
  reviews: Array<{
    author: { login: string };
    body: string;
    comments: Array<{ body: string; path: string; line: number; author: { login: string } }>;
  }>;
  files: Array<{ path: string }>;
}

/**
 * Fetch PR review comments and metadata via `gh pr view`.
 * Throws on failure (PR not found, network error, etc.).
 */
export function fetchPrReviewComments(prNumber: number): PrReviewData {
  log.debug('Fetching PR review comments', { prNumber });

  const raw = execFileSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', PR_REVIEW_JSON_FIELDS],
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const data = JSON.parse(raw) as GhPrViewReviewResponse;

  const comments: PrReviewComment[] = data.comments.map((c) => ({
    author: c.author.login,
    body: c.body,
  }));

  const reviews: PrReviewComment[] = [];
  for (const review of data.reviews) {
    if (review.body) {
      reviews.push({ author: review.author.login, body: review.body });
    }
    for (const comment of review.comments) {
      reviews.push({
        author: comment.author.login,
        body: comment.body,
        path: comment.path,
        line: comment.line,
      });
    }
  }

  return {
    number: data.number,
    title: data.title,
    body: data.body,
    url: data.url,
    headRefName: data.headRefName,
    comments,
    reviews,
    files: data.files.map((f) => f.path),
  };
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

  if (options.draft) {
    args.push('--draft');
  }

  log.info('Creating PR', { branch: options.branch, title: options.title, draft: options.draft });

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
