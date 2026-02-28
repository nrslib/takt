import { info, success, error } from '../../../shared/ui/index.js';
import { getGitProvider } from '../../../infra/git/index.js';

const TITLE_MAX_LENGTH = 100;
const TITLE_TRUNCATE_LENGTH = 97;
const MARKDOWN_HEADING_PATTERN = /^#{1,3}\s+\S/;

export function extractTitle(task: string): string {
  const lines = task.split('\n');
  const headingLine = lines.find((l) => MARKDOWN_HEADING_PATTERN.test(l));
  const titleLine = headingLine
    ? headingLine.replace(/^#{1,3}\s+/, '')
    : (lines.find((l) => l.trim().length > 0) ?? task);
  return titleLine.length > TITLE_MAX_LENGTH
    ? `${titleLine.slice(0, TITLE_TRUNCATE_LENGTH)}...`
    : titleLine;
}

export function createIssueFromTask(task: string, options?: { labels?: string[] }): number | undefined {
  info('Creating GitHub Issue...');
  const title = extractTitle(task);
  const effectiveLabels = options?.labels?.filter((l) => l.length > 0) ?? [];
  const labels = effectiveLabels.length > 0 ? effectiveLabels : undefined;

  const issueResult = getGitProvider().createIssue({ title, body: task, labels });
  if (issueResult.success) {
    if (!issueResult.url) {
      error('Failed to extract issue number from URL');
      return undefined;
    }
    success(`Issue created: ${issueResult.url}`);
    const num = Number(issueResult.url.split('/').pop());
    if (Number.isNaN(num)) {
      error('Failed to extract issue number from URL');
      return undefined;
    }
    return num;
  } else {
    error(`Failed to create issue: ${issueResult.error}`);
    return undefined;
  }
}
