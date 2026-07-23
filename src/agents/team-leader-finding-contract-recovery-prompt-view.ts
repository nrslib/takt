import type {
  FindingContractRecoveryPromptContext,
} from '../core/workflow/engine/team-leader-finding-contract-recovery.js';

const HISTORY_LIMIT = 20;
const HISTORY_ISSUE_LIMIT = 5;
const TEXT_LIMIT = 1_000;

export function projectFindingContractRecoveryIssueHistory(
  recovery: FindingContractRecoveryPromptContext,
): Array<Record<string, unknown>> {
  return recovery.issueHistory.slice(-HISTORY_LIMIT).map((entry) => ({
    fingerprint: boundFindingContractRecoveryText(entry.fingerprint),
    occurrenceCount: entry.occurrenceCount,
    firstAttempt: entry.firstAttempt,
    lastAttempt: entry.lastAttempt,
    issues: entry.issues.slice(0, HISTORY_ISSUE_LIMIT).map((issue) => ({
      code: boundFindingContractRecoveryText(issue.code),
      category: issue.category,
      path: boundFindingContractRecoveryText(issue.path),
      retryability: issue.retryability,
      ...(issue.findingId === undefined
        ? {}
        : { findingId: boundFindingContractRecoveryText(issue.findingId) }),
      ...(issue.partId === undefined
        ? {}
        : { partId: boundFindingContractRecoveryText(issue.partId) }),
    })),
    omittedIssueCount: Math.max(0, entry.issues.length - HISTORY_ISSUE_LIMIT),
  }));
}

export function boundFindingContractRecoveryText(value: string): string {
  return value.length <= TEXT_LIMIT ? value : `${value.slice(0, TEXT_LIMIT - 1)}…`;
}
