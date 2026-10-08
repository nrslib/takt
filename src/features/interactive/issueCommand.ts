import { formatIssueAsTask, getGitProvider, parseIssueNumbers } from '../../infra/git/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { sanitizeTerminalText } from '../../shared/utils/index.js';

interface IssueCommandResult {
  sourceContext: string;
  issueNumber?: number;
  notice: string;
}

export function resolveIssueCommand(
  cwd: string,
  input: string,
  lang: 'en' | 'ja',
): IssueCommandResult {
  const tokens = input.trim() === '' ? [] : input.trim().split(/\s+/u);
  if (tokens.length === 0) {
    throw new Error(getLabel('interactive.issueCommand.argumentsRequired', lang));
  }

  const issueNumbers = parseIssueNumbers(tokens.map((token) => (
    /^\d+$/u.test(token) ? `#${token}` : token
  )));
  if (issueNumbers.length === 0 || issueNumbers.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
    throw new Error(getLabel('interactive.issueCommand.invalidArguments', lang));
  }

  const provider = getGitProvider();
  const cliStatus = provider.checkCliStatus(cwd);
  if (!cliStatus.available) {
    throw new Error(cliStatus.error);
  }

  const issues = issueNumbers.map((number) => provider.fetchIssue(number, cwd));
  const issueList = issues
    .map((issue) => `#${issue.number} ${sanitizeTerminalText(issue.title)}`)
    .join(', ');

  return {
    sourceContext: issues.map((issue) => formatIssueAsTask(issue)).join('\n\n---\n\n'),
    ...(issueNumbers.length === 1 ? { issueNumber: issueNumbers[0] } : {}),
    notice: getLabel('interactive.issueCommand.fetched', lang, { issues: issueList }),
  };
}
