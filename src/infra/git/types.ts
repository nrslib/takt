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

export interface IssueListItem {
  number: number;
  title: string;
  labels: string[];
  updated_at: string;
}

export interface PrListItem {
  number: number;
  author: string;
  base_branch: string;
  head_branch: string;
  managed_by_takt: boolean;
  labels: string[];
  same_repository: boolean;
  draft: boolean;
  updated_at: string;
}

export interface CreatePrOptions {
  branch: string;
  title: string;
  body: string;
  labels?: string[];
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

export interface MergeResult {
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

  listOpenIssues(cwd?: string): IssueListItem[];

  listOpenPrs(cwd?: string): PrListItem[];

  findExistingPr(branch: string, cwd?: string): ExistingPr | undefined;

  createPullRequest(options: CreatePrOptions, cwd?: string): CreatePrResult;

  commentOnPr(prNumber: number, body: string, cwd?: string): CommentResult;

  mergePr(prNumber: number, cwd?: string): MergeResult;
}
