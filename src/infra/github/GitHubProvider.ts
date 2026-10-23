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
import type { PrCiFailure } from '../../core/workflow/system/pr-ci.js';
import type { GitHubPullRequestTarget } from './pull-request-target.js';
import { collectPrCiFailure, rerunPrCi } from './pr-ci.js';
import type { ListOpenPrsOptions } from '../git/types.js';
import { fetchPrStatus, fetchPrDetails, fetchPrListItem, fetchPrSelectionData, findExistingPr, commentOnPr, closePr, createPullRequest, fetchPrReviewComments, listOpenPrNumbers, listOpenPrs, mergePr } from './pr.js';
import type { GitProvider, CliStatus, Issue, ExistingPr, IssueListItem, PrListItem, CreateIssueOptions, CreateIssueResult, CloseIssueResult, CreatePrOptions, CreatePrResult, CommentResult, IssueCommentResult, MergeResult, PrReviewData } from '../git/types.js';

export class GitHubProvider implements GitProvider {
  constructor(private readonly pullRequest?: GitHubPullRequestTarget) {}

  private targetArguments(prNumber: number): [] | [GitHubPullRequestTarget] {
    if (this.pullRequest === undefined) return [];
    if (this.pullRequest.number !== prNumber) throw new Error('PR number does not match the published target');
    return [this.pullRequest];
  }

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
    return fetchPrReviewComments(prNumber, cwd ?? process.cwd(), ...this.targetArguments(prNumber));
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

  listOpenPrNumbers(cwd: string): number[] {
    return listOpenPrNumbers(cwd);
  }

  fetchPrListItem(prNumber: number, cwd: string): PrListItem | undefined {
    return fetchPrListItem(prNumber, cwd);
  }

  fetchPrSelectionData(prNumber: number, cwd: string) {
    return fetchPrSelectionData(prNumber, cwd);
  }

  findExistingPr(branch: string, cwd?: string): ExistingPr | undefined {
    return findExistingPr(branch, cwd ?? process.cwd());
  }

  createPullRequest(options: CreatePrOptions, cwd?: string): CreatePrResult {
    return createPullRequest(options, cwd ?? process.cwd());
  }

  commentOnPr(prNumber: number, body: string, cwd?: string): CommentResult {
    return commentOnPr(prNumber, body, cwd ?? process.cwd(), ...this.targetArguments(prNumber));
  }

  commentOnIssue(issueNumber: number, body: string, cwd?: string): IssueCommentResult {
    return commentOnIssue(issueNumber, body, cwd ?? process.cwd());
  }

  closePr(prNumber: number, cwd?: string): MergeResult {
    return closePr(prNumber, cwd ?? process.cwd(), ...this.targetArguments(prNumber));
  }

  mergePr(prNumber: number, cwd?: string, method?: MergeMethod, expectedHeadSha?: string): MergeResult {
    return mergePr(prNumber, cwd ?? process.cwd(), method, expectedHeadSha, ...this.targetArguments(prNumber));
  }

  fetchPrStatus(prNumber: number, cwd?: string, options?: PrStatusFetchOptions) {
    return fetchPrStatus(prNumber, cwd ?? process.cwd(), options, ...this.targetArguments(prNumber));
  }

  async fetchPrCiFailure(prNumber: number, headSha: string, cwd: string, options?: PrStatusFetchOptions) {
    const target = this.targetArguments(prNumber);
    const status = await fetchPrStatus(prNumber, cwd, options, ...target);
    return collectPrCiFailure(status, headSha, cwd, options, ...target);
  }

  rerunPrCi(failure: PrCiFailure, cwd: string, options?: PrStatusFetchOptions) {
    return rerunPrCi(failure, cwd, options, ...this.targetArguments(failure.number));
  }

  fetchPrDetails(prNumber: number, cwd?: string, signal?: AbortSignal) {
    return fetchPrDetails(prNumber, cwd ?? process.cwd(), signal, ...this.targetArguments(prNumber));
  }
}
