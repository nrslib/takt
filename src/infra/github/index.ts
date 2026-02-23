/**
 * GitHub integration - barrel exports
 */

export type { GitHubIssue } from './types.js';

export {
  formatIssueAsTask,
  parseIssueNumbers,
  isIssueReference,
  resolveIssueTask,
} from './issue.js';

export { buildPrBody } from './pr.js';
