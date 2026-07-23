import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ProviderUsageSnapshot } from '../../models/response.js';
import type { RunPaths } from '../run/run-paths.js';
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  writeNewPrivateFileWithMode,
} from '../../../shared/utils/private-file.js';
import type { FindingContractRecoveryAttemptEvent } from './team-leader-finding-contract-recovery.js';
import type { FindingContractRejectedOutputDigest } from '../team-leader-finding-contract-control-validation.js';
import { buildTeamLeaderAttemptArtifactDirectory } from './team-leader-artifacts.js';

const AUDIT_ISSUE_LIMIT = 50;
const AUDIT_TEXT_LIMIT = 1_000;
const PRIVATE_ARTIFACT_MODE = 0o600;

interface RejectedRawOutputArtifactReference {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export function recordFindingContractRecoveryAttempt<
  TDigest extends FindingContractRejectedOutputDigest,
>(input: {
  readonly runPaths: RunPaths;
  readonly stepName: string;
  readonly attemptId: string;
  readonly boundaryId: string;
  readonly event: FindingContractRecoveryAttemptEvent<TDigest>;
  readonly providerUsage?: ProviderUsageSnapshot;
}): void {
  const directory = buildTeamLeaderAttemptArtifactDirectory(input);
  ensurePrivateDirectory(directory.absoluteDirectory);
  const rejectedRawOutputArtifact = writeRejectedRawOutputArtifact(input, directory);
  const record = {
    timestamp: new Date().toISOString(),
    boundaryId: input.boundaryId,
    step: input.stepName,
    ...projectAttemptEvent(input.event, rejectedRawOutputArtifact),
    ...(input.providerUsage === undefined ? {} : { providerUsage: input.providerUsage }),
  };
  appendPrivateFile(
    join(directory.absoluteDirectory, 'finding-contract-recovery.jsonl'),
    `${JSON.stringify(record)}\n`,
  );
}

function projectAttemptEvent(
  event: FindingContractRecoveryAttemptEvent<FindingContractRejectedOutputDigest>,
  rejectedRawOutputArtifact: RejectedRawOutputArtifactReference | undefined,
): Record<string, unknown> {
  const rejectedDecision = event.rejectedOutput;
  const now = Date.now();
  return {
    boundaryKind: event.boundaryKind,
    type: event.type,
    attempt: event.attempt,
    attemptToken: event.attemptToken,
    mode: event.mode,
    ...(event.strictReason === undefined ? {} : { strictReason: event.strictReason }),
    elapsedMs: event.elapsedMs,
    remainingMs: event.remainingMs,
    episodeStartedAt: new Date(now - event.elapsedMs).toISOString(),
    deadlineAt: new Date(now + event.remainingMs).toISOString(),
    ...(event.envelope?.sessionId === undefined
      ? {}
      : { sessionId: boundText(event.envelope.sessionId) }),
    ...(event.envelope === undefined || event.type === 'rejected'
      ? {}
      : { rawOutputDigest: digestValue(event.envelope.raw) }),
    ...(event.acceptedValue === undefined
      ? {}
      : { normalizedOutputDigest: digestValue(event.acceptedValue) }),
    ...(rejectedRawOutputArtifact === undefined
      ? {}
      : { rawOutputArtifact: rejectedRawOutputArtifact }),
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
            outputDigest: { hash: rejectedDecision.outputDigest.hash },
          },
        }),
  };
}

function writeRejectedRawOutputArtifact(
  input: {
    readonly runPaths: RunPaths;
    readonly boundaryId: string;
    readonly event: FindingContractRecoveryAttemptEvent<FindingContractRejectedOutputDigest>;
  },
  directory: { readonly relativeDirectory: string; readonly absoluteDirectory: string },
): RejectedRawOutputArtifactReference | undefined {
  if (input.event.type !== 'rejected' || input.event.envelope === undefined) {
    return undefined;
  }
  if (input.event.envelope.attemptToken !== input.event.attemptToken) {
    throw new Error('Finding Contract recovery event attempt token does not match its envelope');
  }
  const content = serializeArtifactValue(input.event.envelope.raw);
  const identity = createHash('sha256').update(JSON.stringify({
    boundaryId: input.boundaryId,
    attempt: input.event.attempt,
    attemptToken: input.event.attemptToken,
  })).digest('hex');
  const fileName = `finding-contract-rejected-${identity}.json`;
  const absolutePath = join(directory.absoluteDirectory, fileName);
  writeNewPrivateFileWithMode(absolutePath, content, PRIVATE_ARTIFACT_MODE);
  return {
    path: join(input.runPaths.contextRel, directory.relativeDirectory, fileName),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
  };
}

function digestValue(value: unknown): { readonly hash: string } {
  const serialized = serializeArtifactValue(value);
  return {
    hash: createHash('sha256').update(serialized).digest('hex'),
  };
}

function serializeArtifactValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Finding Contract recovery output cannot be serialized as JSON');
  }
  return serialized;
}

function boundText(value: string): string {
  return value.length <= AUDIT_TEXT_LIMIT ? value : `${value.slice(0, AUDIT_TEXT_LIMIT - 1)}…`;
}
