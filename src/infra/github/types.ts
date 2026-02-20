/**
 * GitHub module type definitions
 */

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: Array<{ author: string; body: string }>;
}

export interface GhCliStatus {
  available: boolean;
  error?: string;
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
