/**
 * Git provider abstraction types
 *
 * Defines the GitProvider interface and its supporting types,
 * decoupled from any specific provider implementation.
 */

export interface CliStatus {
  available: boolean;
  error?: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
}

export interface ExistingPr {
  number: number;
  url: string;
}

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
  /** Create PR as draft */
  draft?: boolean;
}

export interface CreatePrResult {
  success: boolean;
  /** PR URL on success */
  url?: string;
  /** Error message on failure */
  error?: string;
}

export interface CommentResult {
  success: boolean;
  /** Error message on failure */
  error?: string;
}

export interface CreateIssueOptions {
  /** Issue title */
  title: string;
  /** Issue body (markdown) */
  body: string;
  /** Labels to apply */
  labels?: string[];
}

export interface CreateIssueResult {
  success: boolean;
  /** Issue URL on success */
  url?: string;
  /** Error message on failure */
  error?: string;
}

/** PR review comment (conversation or inline) */
export interface PrReviewComment {
  author: string;
  body: string;
  /** File path for inline comments (undefined for conversation comments) */
  path?: string;
  /** Line number for inline comments */
  line?: number;
}

/** PR review data including metadata and review comments */
export interface PrReviewData {
  number: number;
  title: string;
  body: string;
  url: string;
  /** Branch name of the PR head */
  headRefName: string;
  /** Conversation comments (non-review) */
  comments: PrReviewComment[];
  /** Review comments (from reviews) */
  reviews: PrReviewComment[];
  /** Changed file paths */
  files: string[];
}

export interface GitProvider {
  /** Check CLI tool availability and authentication status */
  checkCliStatus(): CliStatus;

  fetchIssue(issueNumber: number): Issue;

  createIssue(options: CreateIssueOptions): CreateIssueResult;

  /** Fetch PR review comments and metadata */
  fetchPrReviewComments(prNumber: number): PrReviewData;

  /** Find an open PR for the given branch. Returns undefined if no PR exists. */
  findExistingPr(cwd: string, branch: string): ExistingPr | undefined;

  createPullRequest(cwd: string, options: CreatePrOptions): CreatePrResult;

  commentOnPr(cwd: string, prNumber: number, body: string): CommentResult;
}
