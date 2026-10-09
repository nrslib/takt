/**
 * GitHub implementation of GitProvider
 *
 * Delegates each operation to the corresponding function in
 * issue.ts and pr.ts. This class is the single place that binds
 * the GitProvider contract to the GitHub/gh-CLI implementation.
 */

import { checkGhCli, fetchIssue, listOpenIssues, createIssue, closeIssue, commentOnIssue } from './issue.js';
import type { MergeMethod } from '../../core/models/config-types.js';
import type { PrStatusFetchOptions } from '../../core/workflow/system/pr-execution-context.js';
import type { ListOpenPrsOptions } from '../git/types.js';
import { fetchPrStatus, fetchPrDetails, findExistingPr, commentOnPr, closePr, createPullRequest, fetchPrReviewComments, listOpenPrs, mergePr } from './pr.js';
import type { GitProvider, CliStatus, Issue, ExistingPr, IssueListItem, PrListItem, CreateIssueOptions, CreateIssueResult, CloseIssueResult, CreatePrOptions, CreatePrResult, CommentResult, IssueCommentResult, MergeResult, PrReviewData } from '../git/types.js';

export class GitHubProvider implements GitProvider {
  checkCliStatus(cwd?: string): CliStatus {
    return checkGhCli(cwd ?? process.cwd());
  }

  fetchIssue(issueNumber: number, cwd?: string): Issue {
    return fetchIssue(issueNumber, cwd ?? process.cwd());
  }

  createIssue(options: CreateIssueOptions, cwd?: string): CreateIssueResult {
    return createIssue(options, cwd ?? process.cwd());
  }

  closeIssue(issueNumber: number, comment: string, cwd?: string): CloseIssueResult {
    return closeIssue(issueNumber, comment, cwd ?? process.cwd());
  }

  fetchPrReviewComments(prNumber: number, cwd?: string): PrReviewData {
    return fetchPrReviewComments(prNumber, cwd ?? process.cwd());
  }

  listOpenIssues(cwd?: string): IssueListItem[] {
    return listOpenIssues(cwd ?? process.cwd());
  }

  listOpenPrs(cwd?: string, options?: { readonly allPages?: false }): PrListItem[];
  listOpenPrs(cwd: string | undefined, options: { readonly allPages: true }): Iterable<PrListItem>;
  listOpenPrs(cwd: string | undefined, options: ListOpenPrsOptions | undefined): Iterable<PrListItem>;
  listOpenPrs(cwd?: string, options?: ListOpenPrsOptions): Iterable<PrListItem> {
    return listOpenPrs(cwd ?? process.cwd(), options);
  }

  findExistingPr(branch: string, cwd?: string): ExistingPr | undefined {
    return findExistingPr(branch, cwd ?? process.cwd());
  }

  createPullRequest(options: CreatePrOptions, cwd?: string): CreatePrResult {
    return createPullRequest(options, cwd ?? process.cwd());
  }

  commentOnPr(prNumber: number, body: string, cwd?: string): CommentResult {
    return commentOnPr(prNumber, body, cwd ?? process.cwd());
  }

  commentOnIssue(issueNumber: number, body: string, cwd?: string): IssueCommentResult {
    return commentOnIssue(issueNumber, body, cwd ?? process.cwd());
  }

  closePr(prNumber: number, cwd?: string): MergeResult {
    return closePr(prNumber, cwd ?? process.cwd());
  }

  mergePr(prNumber: number, cwd?: string, method?: MergeMethod, expectedHeadSha?: string): MergeResult {
    return mergePr(prNumber, cwd ?? process.cwd(), method, expectedHeadSha);
  }

  fetchPrStatus(prNumber: number, cwd?: string, options?: PrStatusFetchOptions) {
    return fetchPrStatus(prNumber, cwd ?? process.cwd(), options);
  }

  fetchPrDetails(prNumber: number, cwd?: string, signal?: AbortSignal) {
    return fetchPrDetails(prNumber, cwd ?? process.cwd(), signal);
  }
}
