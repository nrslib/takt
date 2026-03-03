import { withProgress } from '../../shared/ui/index.js';
import { formatIssueAsTask, parseIssueNumbers, formatPrReviewAsTask } from '../../infra/github/index.js';
import { getGitProvider } from '../../infra/git/index.js';
import type { PrReviewData } from '../../infra/git/index.js';
import { isDirectTask } from './helpers.js';
export async function resolveIssueInput(
  issueOption: number | undefined,
  task: string | undefined,
): Promise<{ initialInput: string } | null> {
  if (issueOption) {
    const ghStatus = getGitProvider().checkCliStatus();
    if (!ghStatus.available) {
      throw new Error(ghStatus.error);
    }
    const issue = await withProgress(
      'Fetching GitHub Issue...',
      (fetchedIssue) => `GitHub Issue fetched: #${fetchedIssue.number} ${fetchedIssue.title}`,
      async () => getGitProvider().fetchIssue(issueOption),
    );
    return { initialInput: formatIssueAsTask(issue) };
  }

  if (task && isDirectTask(task)) {
    const ghStatus = getGitProvider().checkCliStatus();
    if (!ghStatus.available) {
      throw new Error(ghStatus.error);
    }
    const tokens = task.trim().split(/\s+/);
    const issueNumbers = parseIssueNumbers(tokens);
    if (issueNumbers.length === 0) {
      throw new Error(`Invalid issue reference: ${task}`);
    }
    const issues = await withProgress(
      'Fetching GitHub Issue...',
      (fetchedIssues) => `GitHub Issues fetched: ${fetchedIssues.map((issue) => `#${issue.number}`).join(', ')}`,
      async () => issueNumbers.map((n) => getGitProvider().fetchIssue(n)),
    );
    return { initialInput: issues.map(formatIssueAsTask).join('\n\n---\n\n') };
  }

  return null;
}

export async function resolvePrInput(
  prNumber: number,
): Promise<{ initialInput: string; prBranch: string; baseBranch?: string }> {
  const ghStatus = getGitProvider().checkCliStatus();
  if (!ghStatus.available) {
    throw new Error(ghStatus.error);
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
