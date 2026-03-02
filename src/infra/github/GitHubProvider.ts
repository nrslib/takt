/**
 * GitHub implementation of GitProvider
 *
 * Delegates each operation to the corresponding function in
 * issue.ts and pr.ts. This class is the single place that binds
 * the GitProvider contract to the GitHub/gh-CLI implementation.
 */

import { checkGhCli, fetchIssue, createIssue } from './issue.js';
import { findExistingPr, commentOnPr, createPullRequest, fetchPrReviewComments } from './pr.js';
import type { GitProvider, CliStatus, Issue, ExistingPr, CreateIssueOptions, CreateIssueResult, CreatePrOptions, CreatePrResult, CommentResult, PrReviewData } from '../git/types.js';

export class GitHubProvider implements GitProvider {
  checkCliStatus(): CliStatus {
    return checkGhCli();
  }

  fetchIssue(issueNumber: number): Issue {
    return fetchIssue(issueNumber);
  }

  createIssue(options: CreateIssueOptions): CreateIssueResult {
    return createIssue(options);
  }

  fetchPrReviewComments(prNumber: number): PrReviewData {
    return fetchPrReviewComments(prNumber);
  }

  findExistingPr(cwd: string, branch: string): ExistingPr | undefined {
    return findExistingPr(cwd, branch);
  }

  createPullRequest(cwd: string, options: CreatePrOptions): CreatePrResult {
    return createPullRequest(cwd, options);
  }

  commentOnPr(cwd: string, prNumber: number, body: string): CommentResult {
    return commentOnPr(cwd, prNumber, body);
  }
}
