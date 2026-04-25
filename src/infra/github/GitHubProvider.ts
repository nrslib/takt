/**
 * GitHub implementation of GitProvider
 *
 * Delegates each operation to the corresponding function in
 * issue.ts and pr.ts. This class is the single place that binds
 * the GitProvider contract to the GitHub/gh-CLI implementation.
 */

import { checkGhCli, fetchIssue, listOpenIssues, createIssue } from './issue.js';
import { findExistingPr, commentOnPr, closePr, createPullRequest, fetchPrReviewComments, listOpenPrs, mergePr } from './pr.js';
import type { GitProvider, CliStatus, Issue, ExistingPr, IssueListItem, PrListItem, CreateIssueOptions, CreateIssueResult, CreatePrOptions, CreatePrResult, CommentResult, MergeResult, PrReviewData } from '../git/types.js';

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

  fetchPrReviewComments(prNumber: number, cwd?: string): PrReviewData {
    return fetchPrReviewComments(prNumber, cwd ?? process.cwd());
  }

  listOpenIssues(cwd?: string): IssueListItem[] {
    return listOpenIssues(cwd ?? process.cwd());
  }

  listOpenPrs(cwd?: string): PrListItem[] {
    return listOpenPrs(cwd ?? process.cwd());
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

  closePr(prNumber: number, cwd?: string): MergeResult {
    return closePr(prNumber, cwd ?? process.cwd());
  }

  mergePr(prNumber: number, cwd?: string): MergeResult {
    return mergePr(prNumber, cwd ?? process.cwd());
  }
}
