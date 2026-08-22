import type { CreateIssueResult } from '../../infra/git/types.js';

export function createIssueSuccess(
  issueNumber: number,
  url = `https://github.com/owner/repo/issues/${issueNumber}`,
): CreateIssueResult {
  return { success: true, issueNumber, url };
}
