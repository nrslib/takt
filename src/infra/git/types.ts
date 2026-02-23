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

export interface GitProvider {
  /** Check CLI tool availability and authentication status */
  checkCliStatus(): CliStatus;

  /** Fetch issue content by number */
  fetchIssue(issueNumber: number): Issue;

  /** Create an issue */
  createIssue(options: CreateIssueOptions): CreateIssueResult;

  /** Find an open PR for the given branch. Returns undefined if no PR exists. */
  findExistingPr(cwd: string, branch: string): ExistingPr | undefined;

  /** Create a pull request */
  createPullRequest(cwd: string, options: CreatePrOptions): CreatePrResult;

  /** Add a comment to an existing PR */
  commentOnPr(cwd: string, prNumber: number, body: string): CommentResult;
}
