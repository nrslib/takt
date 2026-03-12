/**
 * GitLab implementation of GitProvider
 *
 * Delegates each operation to the corresponding function in
 * issue.ts and pr.ts. This class is the single place that binds
 * the GitProvider contract to the GitLab/glab-CLI implementation.
 */

import { checkGlabCli, fetchIssue, createIssue } from './issue.js';
import { findExistingMr, commentOnMr, createMergeRequest, fetchMrReviewComments } from './pr.js';
import type { GitProvider, CliStatus, Issue, ExistingPr, CreateIssueOptions, CreateIssueResult, CreatePrOptions, CreatePrResult, CommentResult, PrReviewData } from '../git/types.js';

export class GitLabProvider implements GitProvider {
  checkCliStatus(): CliStatus {
    return checkGlabCli();
  }

  fetchIssue(issueNumber: number): Issue {
    return fetchIssue(issueNumber);
  }

  createIssue(options: CreateIssueOptions): CreateIssueResult {
    return createIssue(options);
  }

  fetchPrReviewComments(prNumber: number): PrReviewData {
    return fetchMrReviewComments(prNumber);
  }

  findExistingPr(cwd: string, branch: string): ExistingPr | undefined {
    return findExistingMr(cwd, branch);
  }

  createPullRequest(cwd: string, options: CreatePrOptions): CreatePrResult {
    return createMergeRequest(cwd, options);
  }

  commentOnPr(cwd: string, prNumber: number, body: string): CommentResult {
    return commentOnMr(cwd, prNumber, body);
  }
}
