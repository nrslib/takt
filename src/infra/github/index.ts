/**
 * GitHub integration - barrel exports
 */

export type { GitHubIssue, GhCliStatus, CreatePrOptions, CreatePrResult, CreateIssueOptions, CreateIssueResult } from './types.js';

export {
  checkGhCli,
  fetchIssue,
  formatIssueAsTask,
  parseIssueNumbers,
  isIssueReference,
  resolveIssueTask,
  createIssue,
} from './issue.js';

export { pushBranch, createPullRequest, buildPrBody } from './pr.js';
