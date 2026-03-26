/**
 * GitHub Pull Request utilities
 *
 * Creates PRs via `gh` CLI for CI/CD integration.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { checkGhCli } from './issue.js';
import { MAX_PAGES } from '../git/constants.js';
import type { CreatePrOptions, CreatePrResult, ExistingPr, CommentResult, PrReviewData, PrReviewComment } from '../git/types.js';

const log = createLogger('github-pr');

/**
 * Find an open PR for the given branch.
 * Returns undefined if no PR exists.
 */
export function findExistingPr(branch: string, cwd: string): ExistingPr | undefined {
  const ghStatus = checkGhCli(cwd);
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

export function commentOnPr(prNumber: number, body: string, cwd: string): CommentResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
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
const PR_REVIEW_JSON_FIELDS = 'number,title,body,url,headRefName,baseRefName,comments,reviews,files';

/** Raw shape returned by `gh pr view --json` for review data */
interface GhPrViewReviewResponse {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  baseRefName?: string;
  comments: Array<{ author: { login: string }; body: string }>;
  reviews: Array<{
    author: { login: string };
    body: string;
  }>;
  files: Array<{ path: string }>;
}

/** Raw shape from GitHub Pull Request Review Comments API (null fields normalized on parse) */
interface GhPrApiReviewComment {
  body: string;
  path: string;
  line?: number;
  original_line?: number;
  user: { login: string };
}

const INLINE_REVIEW_COMMENTS_PER_PAGE = 100;

/** Raw JSON shape from GitHub API (line/original_line are nullable) */
interface GhPrApiRawReviewComment {
  body: string;
  path: string;
  line: number | null;
  original_line?: number | null;
  user: { login: string };
}

function normalizeReviewComment(raw: GhPrApiRawReviewComment): GhPrApiReviewComment {
  return {
    body: raw.body,
    path: raw.path,
    line: raw.line ?? undefined,
    original_line: raw.original_line ?? undefined,
    user: raw.user,
  };
}

function fetchInlineReviewComments(owner: string, repo: string, prNumber: number, cwd: string): GhPrApiReviewComment[] {
  const comments: GhPrApiReviewComment[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const rawInlineReviewComments = execFileSync(
      'gh',
      ['api', `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=${INLINE_REVIEW_COMMENTS_PER_PAGE}&page=${page}`],
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(rawInlineReviewComments) as GhPrApiRawReviewComment[];
    const normalized = parsed.map(normalizeReviewComment);

    comments.push(...normalized);

    if (parsed.length < INLINE_REVIEW_COMMENTS_PER_PAGE) {
      break;
    }

    page += 1;
  }

  return comments;
}

function parseRepositoryFromPrUrl(prUrl: string): { owner: string; repo: string } {
  const parsed = new URL(prUrl);
  const pathSegments = parsed.pathname.split('/').filter(Boolean);

  if (pathSegments.length < 4 || pathSegments[2] !== 'pull') {
    throw new Error(`Unexpected pull request URL format: ${prUrl}`);
  }

  const [owner, repo] = pathSegments;
  if (!owner || !repo) {
    throw new Error(`Repository owner/repo is missing in pull request URL: ${prUrl}`);
  }

  return { owner, repo };
}

/**
 * Fetch PR review comments and metadata via `gh pr view`.
 * Throws on failure (PR not found, network error, etc.).
 */
export function fetchPrReviewComments(prNumber: number, cwd: string): PrReviewData {
  log.debug('Fetching PR review comments', { prNumber });

  const raw = execFileSync(
    'gh',
    ['pr', 'view', String(prNumber), '--json', PR_REVIEW_JSON_FIELDS],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const data = JSON.parse(raw) as GhPrViewReviewResponse;
  const { owner, repo } = parseRepositoryFromPrUrl(data.url);

  const inlineReviewComments = fetchInlineReviewComments(owner, repo, prNumber, cwd);

  const comments: PrReviewComment[] = data.comments.map((c) => ({
    author: c.author.login,
    body: c.body,
  }));

  const reviews: PrReviewComment[] = [];
  for (const review of data.reviews) {
    if (review.body) {
      reviews.push({ author: review.author.login, body: review.body });
    }
  }
  for (const comment of inlineReviewComments) {
    reviews.push({
      author: comment.user.login,
      body: comment.body,
      path: comment.path,
      line: comment.line ?? comment.original_line,
    });
  }

  return {
    number: data.number,
    title: data.title,
    body: data.body,
    url: data.url,
    headRefName: data.headRefName,
    baseRefName: data.baseRefName,
    comments,
    reviews,
    files: data.files.map((f) => f.path),
  };
}

export function createPullRequest(options: CreatePrOptions, cwd: string): CreatePrResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
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
