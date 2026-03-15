import { withProgress } from '../../shared/ui/index.js';
import { formatIssueAsTask, parseIssueNumbers, formatPrReviewAsTask, getGitProvider } from '../../infra/git/index.js';
import type { PrReviewData } from '../../infra/git/index.js';
import { isDirectTask } from './helpers.js';
export async function resolveIssueInput(
  issueOption: number | undefined,
  task: string | undefined,
): Promise<{ initialInput: string } | null> {
  if (issueOption) {
    const cliStatus = getGitProvider().checkCliStatus();
    if (!cliStatus.available) {
      throw new Error(cliStatus.error);
    }
    const issue = await withProgress(
      'Fetching issue...',
      (fetchedIssue) => `Issue fetched: #${fetchedIssue.number} ${fetchedIssue.title}`,
      async () => getGitProvider().fetchIssue(issueOption),
    );
    return { initialInput: formatIssueAsTask(issue) };
  }

  if (task && isDirectTask(task)) {
    const cliStatus = getGitProvider().checkCliStatus();
    if (!cliStatus.available) {
      throw new Error(cliStatus.error);
    }
    const tokens = task.trim().split(/\s+/);
    const issueNumbers = parseIssueNumbers(tokens);
    if (issueNumbers.length === 0) {
      throw new Error(`Invalid issue reference: ${task}`);
    }
    const issues = await withProgress(
      'Fetching issues...',
      (fetchedIssues) => `Issues fetched: ${fetchedIssues.map((issue) => `#${issue.number}`).join(', ')}`,
      async () => issueNumbers.map((n) => getGitProvider().fetchIssue(n)),
    );
    return { initialInput: issues.map(formatIssueAsTask).join('\n\n---\n\n') };
  }

  return null;
}

export async function resolvePrInput(
  prNumber: number,
): Promise<{ initialInput: string; prBranch: string; baseBranch?: string }> {
  const cliStatus = getGitProvider().checkCliStatus();
  if (!cliStatus.available) {
    throw new Error(cliStatus.error);
  }

  const prReview = await withProgress(
    'Fetching PR review comments...',
    (pr: PrReviewData) => `PR fetched: #${pr.number} ${pr.title}`,
    async () => getGitProvider().fetchPrReviewComments(prNumber),
  );

  return {
    initialInput: formatPrReviewAsTask(prReview),
    prBranch: prReview.headRefName,
    baseBranch: prReview.baseRefName,
  };
}
