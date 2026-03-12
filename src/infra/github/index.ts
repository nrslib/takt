/**
 * GitHub integration - barrel exports
 */

export { checkGhCli, fetchIssue, createIssue } from './issue.js';
export type { GitHubIssue, GhCliStatus, CreateIssueOptions, CreateIssueResult } from './types.js';

export { findExistingPr, commentOnPr, fetchPrReviewComments, createPullRequest } from './pr.js';
