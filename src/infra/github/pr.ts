/**
 * GitHub Pull Request utilities
 *
 * Creates PRs via `gh` CLI for CI/CD integration.
 */

import { execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { fetchPaginatedApi } from '../git/paginated-api.js';
import { isTaktManagedPrBody } from '../git/format.js';
import { checkGhCli } from './issue.js';
import type { CreatePrOptions, CreatePrResult, ExistingPr, CommentResult, MergeResult, PrListItem, PrReviewData, PrReviewComment } from '../git/types.js';

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

interface GhPrListResponseItem {
  number: number;
  user: { login: string };
  base: { ref: string; repo: { full_name: string } | null };
  head: { ref: string; repo: { full_name: string } | null };
  body: string | null;
  labels: Array<{ name: string }>;
  draft: boolean;
  updated_at: string;
}

interface GhRepoViewResponse {
  nameWithOwner: string;
}

const OPEN_PRS_PER_PAGE = 100;
const INLINE_REVIEW_COMMENTS_PER_PAGE = 100;

function resolveRepositoryNameWithOwner(cwd: string): string {
  const output = execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner'],
    { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const repo = JSON.parse(output) as GhRepoViewResponse;
  if (!repo.nameWithOwner) {
    throw new Error('gh repo view did not return nameWithOwner');
  }
  return repo.nameWithOwner;
}

export function listOpenPrs(cwd: string): PrListItem[] {
  const repo = resolveRepositoryNameWithOwner(cwd);
  const prs = fetchPaginatedApi<GhPrListResponseItem>({
    command: 'gh',
    cwd,
    context: 'open pull request list',
    initialEndpoint: `repos/${repo}/pulls?state=open&per_page=${OPEN_PRS_PER_PAGE}&page=1`,
    parsePage: (body) => JSON.parse(body) as GhPrListResponseItem[],
  });

  return prs.map((pr) => ({
    number: pr.number,
    author: pr.user.login,
    base_branch: pr.base.ref,
    head_branch: pr.head.ref,
    managed_by_takt: isTaktManagedPrBody(pr.body),
    labels: pr.labels.map((label) => label.name),
    same_repository: pr.head.repo?.full_name === pr.base.repo?.full_name,
    draft: pr.draft,
    updated_at: pr.updated_at,
  }));
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
  return fetchPaginatedApi<GhPrApiReviewComment>({
    command: 'gh',
    cwd,
    context: `pull request #${prNumber} inline review comments`,
    initialEndpoint: `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=${INLINE_REVIEW_COMMENTS_PER_PAGE}&page=1`,
    parsePage: (body) => {
      const parsed = JSON.parse(body) as GhPrApiRawReviewComment[];
      return parsed.map(normalizeReviewComment);
    },
  });
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

  for (const label of options.labels ?? []) {
    args.push('--label', label);
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

export function mergePr(prNumber: number, cwd: string): MergeResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  try {
    execFileSync('gh', ['pr', 'merge', String(prNumber), '--merge', '--delete-branch'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('PR merge failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}
