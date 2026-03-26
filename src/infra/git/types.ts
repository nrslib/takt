export type CliStatus =
  | { available: true }
  | { available: false; error: string };

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
  branch: string;
  title: string;
  body: string;
  base?: string;
  repo?: string;
  draft?: boolean;
}

export interface CreatePrResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface CommentResult {
  success: boolean;
  error?: string;
}

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
}

export interface CreateIssueResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface PrReviewComment {
  author: string;
  body: string;
  path?: string;
  line?: number;
}

export interface PrReviewData {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  baseRefName?: string;
  comments: PrReviewComment[];
  reviews: PrReviewComment[];
  files: string[];
}

export interface GitProvider {
  checkCliStatus(cwd?: string): CliStatus;

  fetchIssue(issueNumber: number, cwd?: string): Issue;

  createIssue(options: CreateIssueOptions, cwd?: string): CreateIssueResult;

  fetchPrReviewComments(prNumber: number, cwd?: string): PrReviewData;

  findExistingPr(branch: string, cwd?: string): ExistingPr | undefined;

  createPullRequest(options: CreatePrOptions, cwd?: string): CreatePrResult;

  commentOnPr(prNumber: number, body: string, cwd?: string): CommentResult;
}
