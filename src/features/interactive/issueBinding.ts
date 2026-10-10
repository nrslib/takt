export function resolveInstructionIssue(
  instruction: string,
  currentIssueNumber: number | undefined,
): number | undefined {
  if (currentIssueNumber === undefined
    || !Number.isSafeInteger(currentIssueNumber)
    || currentIssueNumber <= 0) {
    return undefined;
  }
  const match = /^# [^\r\n]+\r?\n(?:[ \t]*\r?\n)*Issue: #([1-9][0-9]*)[ \t]*(?:\r?\n|$)/.exec(instruction);
  if (!match) {
    return undefined;
  }
  const issueNumber = Number(match[1]);
  return Number.isSafeInteger(issueNumber) && issueNumber === currentIssueNumber
    ? issueNumber
    : undefined;
}
