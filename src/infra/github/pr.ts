/**
 * GitHub Pull Request utilities
 *
 * Creates PRs via `gh` CLI for CI/CD integration.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { fetchPaginatedApi } from '../git/paginated-api.js';
import { isTaktManagedPrBody } from '../git/format.js';
import { checkGhCli } from './issue.js';
import { resolveRepositoryNameWithOwner } from './repository.js';
import { parseCodeRabbitRateLimit, type CodeRabbitRateLimit } from './coderabbit-rate-limit.js';
import type {
  CreatePrOptions,
  CreatePrResult,
  ExistingPr,
  CommentResult,
  MergeResult,
  PrListItem,
  ListOpenPrsOptions,
  PrReviewData,
  PrReviewComment,
  PrReviewThreadState,
} from '../git/types.js';

const log = createLogger('github-pr');
export { fetchPrStatus } from './pr-status.js';

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
  state: 'open' | 'closed';
  user: { login: string };
  base: { ref: string; repo: { full_name: string } | null };
  head: { ref: string; repo: { full_name: string } | null };
  body: string | null;
  labels: Array<{ name: string }>;
  draft: boolean;
  updated_at: string;
}

const OPEN_PRS_PER_PAGE = 100;
const REVIEW_THREADS_PER_PAGE = 100;
const REVIEW_THREAD_COMMENTS_PER_PAGE = 100;
const COMMIT_STATUSES_PER_PAGE = 100;
const COMMIT_STATUS_PAGINATION_HARD_CAP = 100;
const GRAPHQL_PAGINATION_HARD_CAP = 100;
// 100 bodies × 65,536 UTF-16 code units × 6 escaped JSON bytes is about 37.5 MiB.
const GITHUB_REVIEW_COMMENT_PAGE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const DELETED_GITHUB_USER_AUTHOR = 'deleted GitHub user';
const CODERABBIT_LOGIN = 'coderabbitai';
const COMPLETED_REVIEW_STATES = new Set(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED']);

export interface CodeRabbitReviewThread {
  id: string;
  author: string;
  body: string;
  replies: Array<{ author: string; body: string }>;
  path: string;
  line?: number;
  url: string;
  isOutdated: boolean;
}

export interface CodeRabbitReviewStatus {
  headSha: string;
  hasCodeRabbitPost: boolean;
  hasCodeRabbitStatus: boolean;
  unresolvedThreadCount: number;
  rateLimit?: CodeRabbitRateLimit;
  reviewedHeadShas: string[];
}

export interface CacciaPullRequestDetails {
  number: number;
  headBranch: string;
  headSha: string;
  headRepositoryUrl: string;
  headRepositoryPushUrls: string[];
}

export function listOpenPrs(cwd: string, options?: { readonly allPages?: false }): PrListItem[];
export function listOpenPrs(cwd: string, options: { readonly allPages: true }): Iterable<PrListItem>;
export function listOpenPrs(cwd: string, options: ListOpenPrsOptions | undefined): Iterable<PrListItem>;
export function listOpenPrs(cwd: string, options?: ListOpenPrsOptions): Iterable<PrListItem> {
  const repo = resolveRepositoryNameWithOwner(cwd);
  // マージやコメントによって後続ページの位置が変わらないよう、全状態を作成順で取得する。
  const query = options?.allPages === true ? 'state=all&sort=created&direction=asc' : 'state=open';
  const prs = fetchPaginatedApi<GhPrListResponseItem>({
    command: 'gh',
    cwd,
    context: 'open pull request list',
    allPages: options?.allPages,
    initialEndpoint: `repos/${repo}/pulls?${query}&per_page=${OPEN_PRS_PER_PAGE}&page=1`,
    parsePage: (body) => JSON.parse(body) as GhPrListResponseItem[],
  });

  const items = toPrListItems(prs, options?.allPages === true);
  return options?.allPages === true ? items : Array.from(items);
}

function* toPrListItems(prs: Iterable<GhPrListResponseItem>, openOnly: boolean): Generator<PrListItem> {
  for (const pr of prs) {
    if (openOnly && pr.state !== 'open') continue;
    yield {
      number: pr.number,
      author: pr.user.login,
      base_branch: pr.base.ref,
      head_branch: pr.head.ref,
      managed_by_takt: isTaktManagedPrBody(pr.body),
      labels: pr.labels.map((label) => label.name),
      same_repository: pr.head.repo?.full_name === pr.base.repo?.full_name,
      draft: pr.draft,
      updated_at: pr.updated_at,
    };
  }
}

export function commentOnPr(prNumber: number, body: string, cwd: string): CommentResult;
export function commentOnPr(prNumber: number, body: string, cwd: string,
  options: { deadlineAt: number; signal?: AbortSignal }): Promise<{ success: true } | undefined>;
export function commentOnPr(prNumber: number, body: string, cwd: string,
  options?: { deadlineAt: number; signal?: AbortSignal }): CommentResult | Promise<{ success: true } | undefined> {
  if (options !== undefined) {
    return runGhCommand(['pr', 'comment', String(prNumber), '--body', body], cwd, options.deadlineAt, options.signal)
      .then(() => ({ success: true as const }))
      .catch((error: unknown) => {
        if (error instanceof ReviewStatusDeadlineExceededError) return undefined;
        throw error;
      });
  }
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

const REVIEW_THREADS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:${REVIEW_THREADS_PER_PAGE}, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          resolvedBy { login }
          comments(first:${REVIEW_THREAD_COMMENTS_PER_PAGE}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              path
              line
              originalLine
              body
              url
              author { login }
            }
          }
        }
      }
    }
  }
}
`;

const REVIEW_THREAD_COMMENTS_QUERY = `
query($threadId:ID!, $commentsEndCursor:String) {
  node(id:$threadId) {
    ... on PullRequestReviewThread {
      comments(first:${REVIEW_THREAD_COMMENTS_PER_PAGE}, after:$commentsEndCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path
          line
          originalLine
          body
          url
          author { login }
        }
      }
    }
  }
}
`;

const CODERABBIT_REVIEWS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviews(first:${REVIEW_THREADS_PER_PAGE}, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          author { login }
          state
          submittedAt
          commit { oid }
        }
      }
    }
  }
}
`;

const CODERABBIT_ISSUE_COMMENTS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      comments(first:${REVIEW_THREADS_PER_PAGE}, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          author { login }
          body
          createdAt
        }
      }
    }
  }
}
`;

const CODERABBIT_THREAD_STARTERS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:${REVIEW_THREADS_PER_PAGE}, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first:${REVIEW_THREAD_COMMENTS_PER_PAGE}) {
            pageInfo { hasNextPage endCursor }
            nodes { author { login } }
          }
        }
      }
    }
  }
}
`;

const CODERABBIT_REVIEW_THREADS_QUERY = `
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      headRefOid
      reviewThreads(first:${REVIEW_THREADS_PER_PAGE}, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          resolvedBy { login }
          comments(first:1) {
            pageInfo { hasNextPage endCursor }
            nodes {
              path
              line
              originalLine
              body
              url
              author { login }
            }
          }
        }
      }
    }
  }
}
`;

const CODERABBIT_REVIEW_THREAD_REPLIES_QUERY = `
query($threadId:ID!, $commentsEndCursor:String) {
  node(id:$threadId) {
    ... on PullRequestReviewThread {
      comments(first:${REVIEW_THREAD_COMMENTS_PER_PAGE}, after:$commentsEndCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          body
          author { login }
        }
      }
    }
  }
}
`;

const CACCIA_PULL_REQUEST_QUERY = `
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      number
      headRefName
      headRefOid
      headRepository {
        sshUrl
      }
    }
  }
}
`;

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { id isResolved }
  }
}
`;

interface GhGraphqlReviewThreadsResponse {
  data?: {
    repository: {
      pullRequest: {
        reviewThreads: GhGraphqlReviewThreadsConnection;
      } | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface GhGraphqlReviewThreadsConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: GhGraphqlReviewThread[];
}

interface GhGraphqlReviewThreadCommentsResponse {
  data?: {
    node: GhGraphqlReviewThreadCommentsNode | null;
  };
  errors?: Array<{ message: string }>;
}

interface GhGraphqlCodeRabbitRepliesResponse {
  data?: {
    node?: {
      comments?: GhGraphqlCodeRabbitRepliesConnection | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface GhGraphqlCodeRabbitRepliesConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: Array<{
    body: string;
    author: { login: string } | null;
  }>;
}

interface GhGraphqlReviewThreadCommentsNode {
  comments?: GhGraphqlReviewThreadCommentsConnection;
}

interface GhGraphqlReviewThreadCommentsConnection {
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
  nodes: GhGraphqlReviewThreadComment[];
}

interface GhGraphqlReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: { login: string } | null;
  comments: GhGraphqlReviewThreadCommentsConnection;
}

interface GhGraphqlReviewThreadComment {
  path: string;
  line: number | null;
  originalLine: number | null;
  body: string;
  url: string;
  author: { login: string } | null;
}

function buildReviewThreadsGraphqlArgs(
  owner: string,
  repo: string,
  prNumber: number,
  endCursor: string | undefined,
): string[] {
  const args = [
    'api',
    'graphql',
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `number=${prNumber}`,
  ];

  if (endCursor !== undefined) {
    args.push('-f', `endCursor=${endCursor}`);
  }

  args.push('-f', `query=${REVIEW_THREADS_QUERY}`);
  return args;
}

function buildReviewThreadCommentsGraphqlArgs(threadId: string, commentsEndCursor: string): string[] {
  return [
    'api',
    'graphql',
    '-f',
    `threadId=${threadId}`,
    '-f',
    `commentsEndCursor=${commentsEndCursor}`,
    '-f',
    `query=${REVIEW_THREAD_COMMENTS_QUERY}`,
  ];
}

function buildCodeRabbitReviewThreadRepliesGraphqlArgs(threadId: string, commentsEndCursor: string): string[] {
  return [
    'api',
    'graphql',
    '-f',
    `threadId=${threadId}`,
    '-f',
    `commentsEndCursor=${commentsEndCursor}`,
    '-f',
    `query=${CODERABBIT_REVIEW_THREAD_REPLIES_QUERY}`,
  ];
}

function parseReviewThreadsResponse(raw: string): GhGraphqlReviewThreadsConnection {
  const parsed = JSON.parse(raw) as GhGraphqlReviewThreadsResponse;
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }

  const pullRequest = parsed.data?.repository?.pullRequest;
  if (!pullRequest) {
    throw new Error('Missing pull request reviewThreads in GraphQL response');
  }

  return pullRequest.reviewThreads;
}

function parseCodeRabbitReviewThreadsResponse(
  raw: string,
  prNumber: number,
  expectedHeadSha: string,
): GhGraphqlReviewThreadsConnection {
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: {
          headRefOid?: unknown;
          reviewThreads?: GhGraphqlReviewThreadsConnection | null;
        } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }

  const pullRequest = parsed.data?.repository?.pullRequest;
  if (!pullRequest?.reviewThreads) {
    throw new Error(`Missing pull request reviewThreads in GraphQL response for pull request #${prNumber}`);
  }
  if (pullRequest.headRefOid !== expectedHeadSha) {
    throw new Error(`Pull request #${prNumber} head changed while reading review threads`);
  }
  return pullRequest.reviewThreads;
}

function parseReviewThreadCommentsResponse(raw: string): GhGraphqlReviewThreadCommentsConnection {
  const parsed = JSON.parse(raw) as GhGraphqlReviewThreadCommentsResponse;
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }

  const thread = parsed.data?.node;
  if (!thread?.comments) {
    throw new Error('Missing pull request review thread comments in GraphQL response');
  }

  return thread.comments;
}

function parseCodeRabbitReviewThreadRepliesResponse(
  raw: string,
  threadId: string,
  prNumber: number,
): GhGraphqlCodeRabbitRepliesConnection {
  const parsed = JSON.parse(raw) as GhGraphqlCodeRabbitRepliesResponse;
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }

  const comments = parsed.data?.node?.comments;
  if (!comments) {
    throw new Error(`Missing comments for review thread ${threadId} in pull request #${prNumber}`);
  }

  return comments;
}

function resolveThreadState(thread: GhGraphqlReviewThread): PrReviewThreadState {
  if (thread.isResolved) {
    return 'resolved';
  }
  if (thread.isOutdated) {
    return 'outdated-unresolved';
  }
  return 'active';
}

function resolveReviewThreadCommentAuthor(comment: GhGraphqlReviewThreadComment): string {
  if (comment.author) {
    return comment.author.login;
  }
  return DELETED_GITHUB_USER_AUTHOR;
}

async function fetchCodeRabbitReviewThreadReplies(
  threadId: string,
  initialEndCursor: string | null,
  cwd: string,
  prNumber: number,
  signal: AbortSignal | undefined,
): Promise<Array<{ author: string; body: string }>> {
  if (!initialEndCursor) {
    throw new Error(`Missing starter comment cursor for review thread ${threadId} in pull request #${prNumber}`);
  }

  const replies: Array<{ author: string; body: string }> = [];
  let endCursor = initialEndCursor;
  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
    const raw = await runGhCommand(
      buildCodeRabbitReviewThreadRepliesGraphqlArgs(threadId, endCursor),
      cwd,
      undefined,
      signal,
      GITHUB_REVIEW_COMMENT_PAGE_MAX_BUFFER_BYTES,
    );
    const response = parseCodeRabbitReviewThreadRepliesResponse(raw, threadId, prNumber);
    replies.push(...response.nodes.map((comment) => ({
      author: comment.author?.login ?? DELETED_GITHUB_USER_AUTHOR,
      body: comment.body,
    })));
    if (!response.pageInfo.hasNextPage) {
      return replies;
    }
    if (!response.pageInfo.endCursor) {
      throw new Error(`Missing reply endCursor for review thread ${threadId} in pull request #${prNumber}`);
    }
    endCursor = response.pageInfo.endCursor;
  }

  throw new Error(`Pagination limit exceeded while fetching replies for review thread ${threadId} in pull request #${prNumber} (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`);
}

function fetchReviewThreadComments(
  thread: GhGraphqlReviewThread,
  prNumber: number,
  cwd: string,
): GhGraphqlReviewThreadComment[] {
  const comments = [...thread.comments.nodes];
  let pageInfo = thread.comments.pageInfo;

  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP && pageInfo.hasNextPage; page += 1) {
    if (!pageInfo.endCursor) {
      throw new Error(`Missing review thread comments endCursor for next page in pull request #${prNumber}`);
    }

    const raw = execFileSync(
      'gh',
      buildReviewThreadCommentsGraphqlArgs(thread.id, pageInfo.endCursor),
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const nextComments = parseReviewThreadCommentsResponse(raw);
    comments.push(...nextComments.nodes);
    pageInfo = nextComments.pageInfo;
  }

  if (pageInfo.hasNextPage) {
    throw new Error(
      `Pagination limit exceeded while fetching pull request #${prNumber} review thread comments (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`,
    );
  }

  return comments;
}

function mapReviewThreadComments(
  thread: GhGraphqlReviewThread,
  comments: GhGraphqlReviewThreadComment[],
): PrReviewComment[] {
  const threadState = resolveThreadState(thread);
  return comments.map((comment) => {
    const line = comment.line ?? comment.originalLine ?? undefined;
    return {
      author: resolveReviewThreadCommentAuthor(comment),
      body: comment.body,
      path: comment.path,
      ...(line !== undefined ? { line } : {}),
      url: comment.url,
      threadState,
      ...(thread.resolvedBy ? { resolvedBy: thread.resolvedBy.login } : {}),
      isOutdated: thread.isOutdated,
    };
  });
}

function fetchPrReviewThreads(owner: string, repo: string, prNumber: number, cwd: string): PrReviewComment[] {
  try {
    const comments: PrReviewComment[] = [];
    let endCursor: string | undefined;

    for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
      const raw = execFileSync(
        'gh',
        buildReviewThreadsGraphqlArgs(owner, repo, prNumber, endCursor),
        { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const reviewThreads = parseReviewThreadsResponse(raw);

      for (const thread of reviewThreads.nodes) {
        const threadComments = fetchReviewThreadComments(thread, prNumber, cwd);
        comments.push(...mapReviewThreadComments(thread, threadComments));
      }

      if (!reviewThreads.pageInfo.hasNextPage) {
        return comments;
      }
      if (!reviewThreads.pageInfo.endCursor) {
        throw new Error('Missing reviewThreads endCursor for next page');
      }
      endCursor = reviewThreads.pageInfo.endCursor;
    }

    throw new Error(
      `Pagination limit exceeded while fetching pull request #${prNumber} review threads (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`,
    );
  } catch (err) {
    throw new Error(`GraphQL reviewThreads failed: ${getErrorMessage(err)}`);
  }
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

interface PullRequestLocator {
  hasCodeRabbitStatus: boolean;
  owner: string;
  repo: string;
  headSha: string;
}

class ReviewStatusDeadlineExceededError extends Error {}

function isCommandTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const commandError = error as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };
  return commandError.code === 'ETIMEDOUT'
    || (commandError.killed === true && commandError.signal === 'SIGKILL');
}

function runGhCommand(
  args: string[],
  cwd: string,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
  maxBuffer?: number,
): Promise<string> {
  const timeout = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
  if (timeout !== undefined && timeout <= 0) {
    return Promise.reject(new ReviewStatusDeadlineExceededError());
  }

  const options = {
    cwd,
    encoding: 'utf-8' as const,
    ...(maxBuffer !== undefined ? { maxBuffer } : {}),
    ...(timeout !== undefined ? { timeout, killSignal: 'SIGKILL' as const } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
  return new Promise((resolve, reject) => {
    execFile('gh', args, options, (error, stdout) => {
      if (error) {
        if (deadlineAt !== undefined && isCommandTimeoutError(error)) {
          reject(new ReviewStatusDeadlineExceededError());
        } else {
          reject(error);
        }
        return;
      }
      resolve(stdout);
    });
  });
}

function parsePullRequestLocator(raw: string, prNumber: number): PullRequestLocator {
  const response = JSON.parse(raw) as { url?: unknown; headRefOid?: unknown;
    statusCheckRollup?: Array<{ __typename: string; name?: string; context?: string }> };
  if (typeof response.url !== 'string' || typeof response.headRefOid !== 'string' || !response.headRefOid) {
    throw new Error(`Missing pull request URL or head SHA for pull request #${prNumber}`);
  }
  return { ...parseRepositoryFromPrUrl(response.url), headSha: response.headRefOid,
    hasCodeRabbitStatus: response.statusCheckRollup?.some((check) =>
      check.__typename === 'CheckRun' ? check.name === 'CodeRabbit' : check.context === 'CodeRabbit') === true };
}

async function fetchPullRequestLocatorAsync(
  prNumber: number,
  cwd: string,
  deadlineAt?: number,
  signal?: AbortSignal,
  includeStatusChecks = false,
): Promise<PullRequestLocator> {
  const raw = await runGhCommand(
    ['pr', 'view', String(prNumber), '--json', includeStatusChecks ? 'url,headRefOid,statusCheckRollup' : 'url,headRefOid'],
    cwd,
    deadlineAt,
    signal,
  );
  return parsePullRequestLocator(raw, prNumber);
}

function buildCodeRabbitGraphqlArgs(
  owner: string,
  repo: string,
  prNumber: number,
  query: string,
  endCursor: string | undefined,
): string[] {
  const args = [
    'api',
    'graphql',
    '-f', `owner=${owner}`,
    '-f', `repo=${repo}`,
    '-F', `number=${prNumber}`,
  ];
  if (endCursor !== undefined) {
    args.push('-f', `endCursor=${endCursor}`);
  }
  args.push('-f', `query=${query}`);
  return args;
}

interface CodeRabbitReviewNode {
  author: { login: string } | null;
  state: string;
  submittedAt: string | null;
  commit: { oid: string } | null;
}

interface CodeRabbitReviewPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: CodeRabbitReviewNode[];
}

function parseCodeRabbitReviewPage(raw: string, prNumber: number): CodeRabbitReviewPage {
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: { reviews?: CodeRabbitReviewPage | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const reviews = parsed.data?.repository?.pullRequest?.reviews;
  if (!reviews) {
    throw new Error(`Missing pull request reviews in GraphQL response for pull request #${prNumber}`);
  }
  return reviews;
}

async function fetchCodeRabbitReviews(
  locator: PullRequestLocator,
  prNumber: number,
  cwd: string,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): Promise<CodeRabbitReviewNode[]> {
  const reviews: CodeRabbitReviewNode[] = [];
  let endCursor: string | undefined;
  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
    const raw = await runGhCommand(
      buildCodeRabbitGraphqlArgs(locator.owner, locator.repo, prNumber, CODERABBIT_REVIEWS_QUERY, endCursor),
      cwd,
      deadlineAt,
      signal,
    );
    const response = parseCodeRabbitReviewPage(raw, prNumber);
    reviews.push(...response.nodes);
    if (!response.pageInfo.hasNextPage) {
      return reviews;
    }
    if (!response.pageInfo.endCursor) {
      throw new Error(`Missing reviews endCursor for pull request #${prNumber}`);
    }
    endCursor = response.pageInfo.endCursor;
  }
  throw new Error(`Pagination limit exceeded while fetching pull request #${prNumber} reviews (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`);
}

interface CodeRabbitThreadStarterPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{ id: string; isResolved: boolean; comments: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ author: { login: string } | null }>;
  } }>;
}

function parseCodeRabbitThreadStarterPage(raw: string, prNumber: number): CodeRabbitThreadStarterPage {
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: { reviewThreads?: CodeRabbitThreadStarterPage | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const threads = parsed.data?.repository?.pullRequest?.reviewThreads;
  if (!threads) {
    throw new Error(`Missing pull request reviewThreads in GraphQL response for pull request #${prNumber}`);
  }
  for (const thread of threads.nodes) {
    if (typeof thread.isResolved !== 'boolean' || typeof thread.comments.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error(`Missing review thread resolution or comment pagination for pull request #${prNumber}`);
    }
  }
  return threads;
}

async function fetchCodeRabbitThreadStarters(
  locator: PullRequestLocator,
  prNumber: number,
  cwd: string,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{ hasPost: boolean; unresolvedCount: number }> {
  let hasPost = false;
  let unresolvedCount = 0;
  let endCursor: string | undefined;
  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
    const raw = await runGhCommand(
      buildCodeRabbitGraphqlArgs(locator.owner, locator.repo, prNumber, CODERABBIT_THREAD_STARTERS_QUERY, endCursor),
      cwd,
      deadlineAt,
      signal,
    );
    const response = parseCodeRabbitThreadStarterPage(raw, prNumber);
    for (const thread of response.nodes) {
      const starter = thread.comments.nodes[0]?.author?.login;
      if (starter?.toLowerCase() === CODERABBIT_LOGIN && thread.isResolved === false) {
        unresolvedCount += 1;
      }
      hasPost ||= thread.comments.nodes.some((comment) => comment.author?.login.toLowerCase() === CODERABBIT_LOGIN);
      let commentsCursor = thread.comments.pageInfo.hasNextPage ? thread.comments.pageInfo.endCursor : undefined;
      if (thread.comments.pageInfo.hasNextPage && !commentsCursor) {
        throw new Error(`Missing thread comments endCursor for pull request #${prNumber}`);
      }
      for (let commentPage = 1; commentsCursor; commentPage += 1) {
        if (commentPage >= GRAPHQL_PAGINATION_HARD_CAP) throw new Error('Thread comment pagination limit exceeded');
        const query = `query($threadId:ID!, $commentsEndCursor:String) {
          node(id:$threadId) { ... on PullRequestReviewThread {
            comments(first:${REVIEW_THREAD_COMMENTS_PER_PAGE}, after:$commentsEndCursor) {
              pageInfo { hasNextPage endCursor } nodes { author { login } }
            }
          } }
        }`;
        const rawComments = await runGhCommand(['api', 'graphql', '-f', `query=${query}`,
          '-f', `threadId=${thread.id}`, '-f', `commentsEndCursor=${commentsCursor}`], cwd, deadlineAt, signal);
        const comments = parseCodeRabbitReviewThreadRepliesResponse(rawComments, thread.id, prNumber);
        hasPost ||= comments.nodes.some((comment) => comment.author?.login.toLowerCase() === CODERABBIT_LOGIN);
        if (comments.pageInfo.hasNextPage && !comments.pageInfo.endCursor) {
          throw new Error(`Missing thread comments endCursor for pull request #${prNumber}`);
        }
        commentsCursor = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : undefined;
      }
    }
    if (!response.pageInfo.hasNextPage) {
      return { hasPost, unresolvedCount };
    }
    if (!response.pageInfo.endCursor) {
      throw new Error(`Missing reviewThreads endCursor for pull request #${prNumber}`);
    }
    endCursor = response.pageInfo.endCursor;
  }
  throw new Error(`Pagination limit exceeded while fetching pull request #${prNumber} review threads (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`);
}

interface CodeRabbitIssueComment {
  author: { login: string } | null;
  body: string;
  createdAt: string;
}

interface CodeRabbitIssueCommentPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: CodeRabbitIssueComment[];
}

function parseCodeRabbitIssueCommentPage(raw: string, prNumber: number): CodeRabbitIssueCommentPage {
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: { comments?: CodeRabbitIssueCommentPage | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const comments = parsed.data?.repository?.pullRequest?.comments;
  if (!comments) {
    throw new Error(`Missing pull request comments in GraphQL response for pull request #${prNumber}`);
  }
  return comments;
}

async function fetchCodeRabbitIssueComments(
  locator: PullRequestLocator,
  prNumber: number,
  cwd: string,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): Promise<CodeRabbitIssueComment[]> {
  const comments: CodeRabbitIssueComment[] = [];
  let endCursor: string | undefined;
  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
    const raw = await runGhCommand(
      buildCodeRabbitGraphqlArgs(locator.owner, locator.repo, prNumber, CODERABBIT_ISSUE_COMMENTS_QUERY, endCursor),
      cwd,
      deadlineAt,
      signal,
      GITHUB_REVIEW_COMMENT_PAGE_MAX_BUFFER_BYTES,
    );
    const response = parseCodeRabbitIssueCommentPage(raw, prNumber);
    comments.push(...response.nodes);
    if (!response.pageInfo.hasNextPage) {
      return comments;
    }
    if (!response.pageInfo.endCursor) {
      throw new Error(`Missing comments endCursor for pull request #${prNumber}`);
    }
    endCursor = response.pageInfo.endCursor;
  }
  throw new Error(`Pagination limit exceeded while fetching pull request #${prNumber} comments (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`);
}

function getReviewedHeadShaFromIssueComment(body: string): string | undefined {
  const match = /<!--\s*final_review_risk_coverage:(\{[\s\S]*?\})\s*-->/u.exec(body);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    const coverage = JSON.parse(match[1]) as { coveredCommitId?: unknown; kind?: unknown };
    if (coverage.kind === 'reviewed' && typeof coverage.coveredCommitId === 'string') {
      return coverage.coveredCommitId;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Returns unresolved review threads whose first comment was created by CodeRabbit. */
export async function fetchCodeRabbitReviewThreads(
  prNumber: number,
  cwd: string,
  expectedHeadSha: string,
  signal?: AbortSignal,
): Promise<CodeRabbitReviewThread[]> {
  const locator = await fetchPullRequestLocatorAsync(prNumber, cwd, undefined, signal);
  if (locator.headSha !== expectedHeadSha) {
    throw new Error(`Pull request #${prNumber} head changed before reading review threads`);
  }
  const threads: CodeRabbitReviewThread[] = [];
  let endCursor: string | undefined;

  for (let page = 1; page <= GRAPHQL_PAGINATION_HARD_CAP; page += 1) {
    const raw = await runGhCommand(
      buildCodeRabbitGraphqlArgs(locator.owner, locator.repo, prNumber, CODERABBIT_REVIEW_THREADS_QUERY, endCursor),
      cwd,
      undefined,
      signal,
      GITHUB_REVIEW_COMMENT_PAGE_MAX_BUFFER_BYTES,
    );
    const response = parseCodeRabbitReviewThreadsResponse(raw, prNumber, expectedHeadSha);
    for (const thread of response.nodes) {
      if (thread.isResolved) {
        continue;
      }
      const starter = thread.comments.nodes[0];
      if (!starter) {
        throw new Error(`Missing starter comment for review thread ${thread.id} in pull request #${prNumber}`);
      }
      if (starter.author?.login.toLowerCase() !== CODERABBIT_LOGIN) {
        continue;
      }
      const line = starter.line ?? starter.originalLine ?? undefined;
      threads.push({
        id: thread.id,
        author: starter.author.login,
        body: starter.body,
        replies: thread.comments.pageInfo.hasNextPage
          ? await fetchCodeRabbitReviewThreadReplies(
            thread.id,
            thread.comments.pageInfo.endCursor,
            cwd,
            prNumber,
            signal,
          )
          : [],
        path: starter.path,
        ...(line === undefined ? {} : { line }),
        url: starter.url,
        isOutdated: thread.isOutdated,
      });
    }
    if (!response.pageInfo.hasNextPage) {
      return threads;
    }
    if (!response.pageInfo.endCursor) {
      throw new Error(`Missing reviewThreads endCursor for pull request #${prNumber}`);
    }
    endCursor = response.pageInfo.endCursor;
  }
  throw new Error(`Pagination limit exceeded while fetching pull request #${prNumber} review threads (>${GRAPHQL_PAGINATION_HARD_CAP} pages)`);
}

async function fetchCodeRabbitCommitStatus(
  locator: PullRequestLocator,
  cwd: string,
  deadlineAt: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{ present: boolean; completed: boolean }> {
  let fetchedStatusCount = 0;
  let present = false;
  for (let page = 1; page <= COMMIT_STATUS_PAGINATION_HARD_CAP; page += 1) {
    const raw = await runGhCommand(
      [
        'api',
        `repos/${locator.owner}/${locator.repo}/commits/${locator.headSha}/status?per_page=${COMMIT_STATUSES_PER_PAGE}&page=${page}`,
      ],
      cwd,
      deadlineAt,
      signal,
    );
    const response = JSON.parse(raw) as {
      statuses?: Array<{ context: string; state: string }>;
      total_count?: number;
    };
    if (!Array.isArray(response.statuses)) {
      throw new Error(`Missing commit statuses for pull request head ${locator.headSha}`);
    }
    present ||= response.statuses.some((status) => status.context === 'CodeRabbit');
    if (response.statuses.some((status) => status.context === 'CodeRabbit' && status.state === 'success')) {
      return { present: true, completed: true };
    }

    fetchedStatusCount += response.statuses.length;
    const totalCount = typeof response.total_count === 'number' ? response.total_count : undefined;
    const hasNextPage = totalCount === undefined
      ? response.statuses.length === COMMIT_STATUSES_PER_PAGE
      : fetchedStatusCount < totalCount;
    if (!hasNextPage) {
      return { present, completed: false };
    }
  }
  throw new Error(
    `Pagination limit exceeded while fetching commit statuses for pull request head ${locator.headSha} (>${COMMIT_STATUS_PAGINATION_HARD_CAP} pages)`,
  );
}

/** Returns CodeRabbit review events, commit status and post coverage for wait and re-review checks. */
export async function fetchCodeRabbitReviewStatus(
  prNumber: number,
  cwd: string,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<CodeRabbitReviewStatus | undefined> {
  let locator: PullRequestLocator;
  let reviews: CodeRabbitReviewNode[];
  let threads: Awaited<ReturnType<typeof fetchCodeRabbitThreadStarters>>;
  let issueComments: CodeRabbitIssueComment[];
  let commitStatus: Awaited<ReturnType<typeof fetchCodeRabbitCommitStatus>>;
  try {
    locator = await fetchPullRequestLocatorAsync(prNumber, cwd, deadlineAt, signal, true);
    reviews = await fetchCodeRabbitReviews(locator, prNumber, cwd, deadlineAt, signal);
    threads = await fetchCodeRabbitThreadStarters(locator, prNumber, cwd, deadlineAt, signal);
    issueComments = await fetchCodeRabbitIssueComments(locator, prNumber, cwd, deadlineAt, signal);
    commitStatus = await fetchCodeRabbitCommitStatus(locator, cwd, deadlineAt, signal);
  } catch (error) {
    if (error instanceof ReviewStatusDeadlineExceededError) {
      return undefined;
    }
    throw error;
  }

  const coderabbitReviews = reviews.filter((review) =>
    review.author?.login.toLowerCase() === CODERABBIT_LOGIN
    && review.submittedAt !== null
    && COMPLETED_REVIEW_STATES.has(review.state));
  const coderabbitIssueComments = issueComments.filter((comment) =>
    comment.author?.login.toLowerCase() === CODERABBIT_LOGIN);
  const rateLimit = coderabbitIssueComments.flatMap((comment) => {
    const rateLimit = parseCodeRabbitRateLimit(comment.body, comment.createdAt);
    return rateLimit === undefined ? [] : [rateLimit];
  }).sort((left, right) => (right.createdAt ?? NaN) - (left.createdAt ?? NaN))[0];
  return {
    headSha: locator.headSha,
    hasCodeRabbitPost: reviews.some((review) => review.author?.login.toLowerCase() === CODERABBIT_LOGIN)
      || threads.hasPost
      || coderabbitIssueComments.length > 0,
    hasCodeRabbitStatus: locator.hasCodeRabbitStatus || commitStatus.present,
    unresolvedThreadCount: threads.unresolvedCount,
    ...(rateLimit === undefined ? {} : { rateLimit }),
    reviewedHeadShas: [...new Set([
      ...coderabbitReviews
        .map((review) => review.commit?.oid)
        .filter((sha): sha is string => sha !== null && sha !== undefined),
      ...coderabbitIssueComments
        .map((comment) => getReviewedHeadShaFromIssueComment(comment.body))
        .filter((sha): sha is string => sha !== undefined),
      ...(commitStatus.completed ? [locator.headSha] : []),
    ])],
  };
}

function resolveCacciaHeadRepositoryUrl(
  originUrl: string,
  headRepositorySshUrl: string,
  locator: PullRequestLocator,
  prNumber: number,
): string {
  const headMatch = /^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\.git$/u.exec(headRepositorySshUrl);
  if (!headMatch?.[1]) {
    throw new Error(`Invalid GitHub SSH URL for pull request #${prNumber}`);
  }
  if (headMatch[1].endsWith('/.') || headMatch[1].endsWith('/..')) {
    throw new Error(`Invalid GitHub SSH URL for pull request #${prNumber}`);
  }

  const originMatch = /^(git@github\.com:|(?:https|ssh):\/\/[^\s/?#]+\/)([^\s/?#]+\/[^\s/?#]+)\/?$/u.exec(originUrl);
  if (!originMatch?.[1] || !originMatch[2]) {
    throw new Error(`Invalid GitHub origin URL for pull request #${prNumber}`);
  }
  if (originMatch[1] !== 'git@github.com:') {
    const parsed = new URL(originUrl);
    if (parsed.hostname !== 'github.com') {
      throw new Error(`Invalid GitHub origin host for pull request #${prNumber}`);
    }
  }

  const headRepository = headMatch[1];
  const originRepository = originMatch[2].replace(/\.git$/iu, '');
  if (originRepository.toLowerCase() === headRepository.toLowerCase()) {
    return originUrl;
  }
  if (originRepository.toLowerCase() !== `${locator.owner}/${locator.repo}`.toLowerCase()) {
    throw new Error(`Origin does not match the base or head repository for pull request #${prNumber}`);
  }
  return `${originMatch[1]}${headRepository}.git`;
}

function readCacciaOriginUrlOutput(
  cwd: string,
  mode: 'fetch' | 'push',
  signal: AbortSignal | undefined,
): Promise<string> {
  const args = mode === 'push' ? ['--push', '--all', 'origin'] : ['origin'];
  return new Promise((resolve, reject) => {
    execFile('git', ['remote', 'get-url', ...args], {
      cwd,
      encoding: 'utf-8',
      ...(signal === undefined ? {} : { signal }),
    }, (error, stdout) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Reads the current PR head and its remote targets without changing the project worktree. */
export async function fetchCacciaPullRequestDetails(
  prNumber: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<CacciaPullRequestDetails> {
  const locator = await fetchPullRequestLocatorAsync(prNumber, cwd, undefined, signal);
  const raw = await runGhCommand(
    buildCodeRabbitGraphqlArgs(locator.owner, locator.repo, prNumber, CACCIA_PULL_REQUEST_QUERY, undefined),
    cwd,
    undefined,
    signal,
  );
  const parsed = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: {
          number: number;
          headRefName: string;
          headRefOid: string;
          headRepository: { sshUrl: string } | null;
        } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const pullRequest = parsed.data?.repository?.pullRequest;
  if (!pullRequest || pullRequest.number !== prNumber || !pullRequest.headRepository) {
    throw new Error(`Missing pull request head repository for pull request #${prNumber}`);
  }
  if (pullRequest.headRefOid !== locator.headSha) {
    throw new Error(`Pull request #${prNumber} head changed while reading its metadata`);
  }
  const headRepositorySshUrl = pullRequest.headRepository.sshUrl;
  const originUrl = await readCacciaOriginUrlOutput(cwd, 'fetch', signal);
  const headRepositoryUrl = resolveCacciaHeadRepositoryUrl(
    originUrl, headRepositorySshUrl, locator, prNumber,
  );
  const pushUrlOutput = await readCacciaOriginUrlOutput(cwd, 'push', signal);
  const headRepositoryPushUrls = pushUrlOutput.split(/\r?\n/u).map((pushUrl) => (
    resolveCacciaHeadRepositoryUrl(pushUrl, headRepositorySshUrl, locator, prNumber)
  ));
  return {
    number: pullRequest.number,
    headBranch: pullRequest.headRefName,
    headSha: pullRequest.headRefOid,
    headRepositoryUrl,
    headRepositoryPushUrls,
  };
}

export async function fetchPrDetails(prNumber: number, cwd: string, signal?: AbortSignal) {
  const head = await fetchCacciaPullRequestDetails(prNumber, cwd, signal);
  const raw = await runGhCommand(['pr', 'view', String(prNumber), '--json', 'baseRefName,isCrossRepository'], cwd, undefined, signal);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('baseRefName' in parsed)
    || typeof parsed.baseRefName !== 'string' || parsed.baseRefName.length === 0
    || !('isCrossRepository' in parsed) || typeof parsed.isCrossRepository !== 'boolean') {
    throw new Error('Missing PR base branch');
  }
  return { ...head, baseBranch: parsed.baseRefName, sameRepository: !parsed.isCrossRepository };
}

/** Reads the current PR head SHA without fetching the additional clone metadata. */
export async function fetchCacciaPullRequestHeadSha(
  prNumber: number,
  cwd: string,
  signal?: AbortSignal,
  deadlineAt?: number,
): Promise<string> {
  const locator = await fetchPullRequestLocatorAsync(prNumber, cwd, deadlineAt, signal);
  return locator.headSha;
}

/** Resolves the supplied GitHub review thread through its GraphQL thread ID. */
export async function resolveReviewThread(threadId: string, cwd: string, signal?: AbortSignal): Promise<void> {
  const raw = await runGhCommand(
    ['api', 'graphql', '-f', `threadId=${threadId}`, '-f', `query=${RESOLVE_REVIEW_THREAD_MUTATION}`],
    cwd,
    undefined,
    signal,
  );
  const parsed = JSON.parse(raw) as {
    data?: { resolveReviewThread?: { thread?: { id: string; isResolved: boolean } | null } | null };
    errors?: Array<{ message: string }>;
  };
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '));
  }
  const thread = parsed.data?.resolveReviewThread?.thread;
  if (!thread || thread.id !== threadId || !thread.isResolved) {
    throw new Error(`GitHub did not resolve review thread ${threadId}`);
  }
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
  const threadReviewComments = fetchPrReviewThreads(owner, repo, prNumber, cwd);

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
  reviews.push(...threadReviewComments);

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

export function mergePr(prNumber: number, cwd: string, method: import('../../core/models/config-types.js').MergeMethod = 'merge', expectedHeadSha?: string): MergeResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  try {
    execFileSync('gh', ['pr', 'merge', String(prNumber), `--${method}`, '--delete-branch',
      ...(expectedHeadSha === undefined ? [] : ['--match-head-commit', expectedHeadSha])], {
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

export function closePr(prNumber: number, cwd: string): MergeResult {
  const ghStatus = checkGhCli(cwd);
  if (!ghStatus.available) {
    return { success: false, error: ghStatus.error };
  }

  try {
    execFileSync('gh', ['pr', 'close', String(prNumber)], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true };
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    log.error('PR close failed', { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}
