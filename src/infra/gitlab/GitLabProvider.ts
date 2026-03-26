/**
 * GitLab implementation of GitProvider
 *
 * Delegates each operation to the corresponding function in
 * issue.ts and pr.ts. This class is the single place that binds
 * the GitProvider contract to the GitLab/glab-CLI implementation.
 */

import { checkGlabCli } from './utils.js';
import { fetchIssue, createIssue } from './issue.js';
import { findExistingMr, commentOnMr, createMergeRequest, fetchMrReviewComments } from './pr.js';
import type { GitProvider, CliStatus, Issue, ExistingPr, CreateIssueOptions, CreateIssueResult, CreatePrOptions, CreatePrResult, CommentResult, PrReviewData } from '../git/types.js';

export class GitLabProvider implements GitProvider {
  checkCliStatus(cwd?: string): CliStatus {
    return checkGlabCli(cwd ?? process.cwd());
  }

  fetchIssue(issueNumber: number, cwd?: string): Issue {
    return fetchIssue(issueNumber, cwd ?? process.cwd());
  }

  createIssue(options: CreateIssueOptions, cwd?: string): CreateIssueResult {
    return createIssue(options, cwd ?? process.cwd());
  }

  fetchPrReviewComments(prNumber: number, cwd?: string): PrReviewData {
    return fetchMrReviewComments(prNumber, cwd ?? process.cwd());
  }

  findExistingPr(branch: string, cwd?: string): ExistingPr | undefined {
    return findExistingMr(branch, cwd ?? process.cwd());
  }

  createPullRequest(options: CreatePrOptions, cwd?: string): CreatePrResult {
    return createMergeRequest(options, cwd ?? process.cwd());
  }

  commentOnPr(prNumber: number, body: string, cwd?: string): CommentResult {
    return commentOnMr(prNumber, body, cwd ?? process.cwd());
  }
}
