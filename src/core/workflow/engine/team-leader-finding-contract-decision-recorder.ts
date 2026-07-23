import { join } from 'node:path';
import type { ProviderUsageSnapshot } from '../../models/response.js';
import type { RunPaths } from '../run/run-paths.js';
import { appendPrivateFile, ensurePrivateDirectory } from '../../../shared/utils/private-file.js';
import type { FindingContractDecisionAttemptEvent } from './team-leader-finding-contract-decision-retry.js';
import { buildTeamLeaderAttemptArtifactDirectory } from './team-leader-artifacts.js';

const AUDIT_ISSUE_LIMIT = 50;
const AUDIT_DIGEST_ITEM_LIMIT = 50;
const AUDIT_TEXT_LIMIT = 1_000;

export function recordFindingContractDecisionAttempt(input: {
  readonly runPaths: RunPaths;
  readonly stepName: string;
  readonly attemptId: string;
  readonly boundaryId: string;
  readonly event: FindingContractDecisionAttemptEvent;
  readonly providerUsage?: ProviderUsageSnapshot;
}): void {
  const directory = buildTeamLeaderAttemptArtifactDirectory(input);
  ensurePrivateDirectory(directory.absoluteDirectory);
  const record = {
    timestamp: new Date().toISOString(),
    boundaryId: input.boundaryId,
    step: input.stepName,
    ...projectAttemptEvent(input.event),
    ...(input.providerUsage === undefined ? {} : { providerUsage: input.providerUsage }),
  };
  appendPrivateFile(
    join(directory.absoluteDirectory, 'decision-recovery.jsonl'),
    `${JSON.stringify(record)}\n`,
  );
}

function projectAttemptEvent(event: FindingContractDecisionAttemptEvent): Record<string, unknown> {
  const rejectedDecision = event.rejectedDecision;
  return {
    type: event.type,
    attempt: event.attempt,
    mode: event.mode,
    ...(event.strictReason === undefined ? {} : { strictReason: event.strictReason }),
    elapsedMs: event.elapsedMs,
    remainingMs: event.remainingMs,
    ...(event.terminationReason === undefined ? {} : { terminationReason: event.terminationReason }),
    ...(event.terminationError === undefined ? {} : { terminationError: event.terminationError }),
    ...(rejectedDecision === undefined
      ? {}
      : {
          rejectedDecision: {
            attempt: rejectedDecision.attempt,
            mode: rejectedDecision.mode,
            issueFingerprint: rejectedDecision.issueFingerprint,
            repeatCount: rejectedDecision.repeatCount,
            issues: rejectedDecision.issues.slice(0, AUDIT_ISSUE_LIMIT).map((issue) => ({
              code: boundText(issue.code),
              category: issue.category,
              path: boundText(issue.path),
              message: boundText(issue.message),
              ...(issue.findingId === undefined ? {} : { findingId: boundText(issue.findingId) }),
              ...(issue.partId === undefined ? {} : { partId: boundText(issue.partId) }),
            })),
            omittedIssueCount: Math.max(0, rejectedDecision.issues.length - AUDIT_ISSUE_LIMIT),
            decisionDigest: {
              hash: rejectedDecision.decisionDigest.hash,
              decision: rejectedDecision.decisionDigest.decision,
              partIds: rejectedDecision.decisionDigest.partIds
                .slice(0, AUDIT_DIGEST_ITEM_LIMIT)
                .map(boundText),
              blockers: rejectedDecision.decisionDigest.blockers
                .slice(0, AUDIT_DIGEST_ITEM_LIMIT)
                .map(boundText),
            },
          },
        }),
  };
}

function boundText(value: string): string {
  return value.length <= AUDIT_TEXT_LIMIT ? value : `${value.slice(0, AUDIT_TEXT_LIMIT - 1)}…`;
}
