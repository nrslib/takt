/**
 * GitHub integration - barrel exports
 */

export {
  formatIssueAsTask,
  parseIssueNumbers,
  isIssueReference,
  resolveIssueTask,
} from './issue.js';

export { buildPrBody } from './pr.js';
