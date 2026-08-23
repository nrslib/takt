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

export type IssueCommentResult =
  | { success: true }
  | { success: false; error: string };

export interface MergeResult {
  success: boolean;
  error?: string;
}

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
}

export type CreateIssueResult =
  | { success: true; issueNumber: number; url?: string }
  | { success: false; issueCreated: true; url?: string; error: string }
  | { success: false; issueCreated?: false; error: string };

export function normalizePublicIssueUrl(url: string | undefined): string | undefined {
  if (url === undefined || containsControlCharacter(url)) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
    return undefined;
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export type CloseIssueResult =
  | { success: true; commentCreated?: boolean }
  | { success: false; error: string; commentCreated?: boolean };

export type PrReviewThreadState = 'active' | 'outdated-unresolved' | 'resolved';

export interface PrReviewComment {
  author: string;
  body: string;
  path?: string;
  line?: number;
  url?: string;
  threadState?: PrReviewThreadState;
  resolvedBy?: string;
  isOutdated?: boolean;
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

  closeIssue(issueNumber: number, comment: string, cwd?: string): CloseIssueResult;

  fetchPrReviewComments(prNumber: number, cwd?: string): PrReviewData;

  listOpenIssues(cwd?: string): IssueListItem[];

  listOpenPrs(cwd?: string): PrListItem[];

  findExistingPr(branch: string, cwd?: string): ExistingPr | undefined;

  createPullRequest(options: CreatePrOptions, cwd?: string): CreatePrResult;

  commentOnPr(prNumber: number, body: string, cwd?: string): CommentResult;

  commentOnIssue(issueNumber: number, body: string, cwd?: string): IssueCommentResult;

  closePr(prNumber: number, cwd?: string): MergeResult;

  mergePr(prNumber: number, cwd?: string): MergeResult;
}
