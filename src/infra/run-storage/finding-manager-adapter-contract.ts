import type {
  FindingLedger,
  FindingManagerReportPublication,
  FindingManagerValidationReport,
} from '../../core/workflow/findings/types.js';
import type { FindingLedgerPublicationDecision } from '../../core/workflow/findings/store.js';
import { normalizeFindingLedgerMutation } from '../../core/workflow/findings/ledger-mutation.js';
import { sha256 } from './canonical-json.js';
import {
  computeFindingManagerReportPublicationId,
  findingManagerValidationReportFileName,
  serializeFindingManagerValidationReport,
} from '../../core/workflow/findings/manager-report-content.js';

export function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (sanitized.length === 0) {
    throw new Error(`Invalid Finding report segment: ${value}`);
  }
  return sanitized;
}

export function managerReportName(
  report: FindingManagerValidationReport,
): string {
  return findingManagerValidationReportFileName(report);
}

export function findingManagerPublicationDomainId(input: {
  readonly runId: string;
  readonly scopeId: string;
  readonly workflowName: string;
}): string {
  return sha256([
    input.runId,
    input.scopeId,
    input.workflowName,
  ].join('\0'));
}

export function normalizeDecision<Result>(
  current: FindingLedger,
  decision: FindingLedgerPublicationDecision<Result>,
  workflowName: string,
): FindingLedgerPublicationDecision<Result> {
  return {
    ...decision,
    mutation: normalizeFindingLedgerMutation(current, decision.mutation, workflowName),
  };
}

export function assertReportRun(
  report: FindingManagerValidationReport,
  runId: string,
): void {
  if (report.runId !== runId) {
    throw new Error(
      `Finding manager report run "${report.runId}" does not match "${runId}"`,
    );
  }
}

export function assertPublicationIntent(
  publication: FindingManagerReportPublication,
  roundMarker: string,
): void {
  assertReportRun(publication.report, publication.originRunId);
  const expectedId = computeFindingManagerReportPublicationId({
    roundMarker,
    originRunId: publication.originRunId,
    fileName: publication.fileName,
    contentSha256: publication.contentSha256,
  });
  if (
    publication.fileName !== managerReportName(publication.report)
    || publication.contentSha256 !== sha256(
      serializeFindingManagerValidationReport(publication.report),
    )
    || publication.publicationId !== expectedId
  ) {
    throw new Error(
      `Finding manager publication "${publication.publicationId}" failed integrity validation`,
    );
  }
}

export function assertNativePublicationContent(
  publication: FindingManagerReportPublication,
  domainId: string,
  runId: string,
): void {
  assertReportRun(publication.report, runId);
  if (
    publication.domainId !== domainId
    || publication.originRunId !== runId
    || publication.destinationRunId !== runId
    || publication.fileName !== managerReportName(publication.report)
    || publication.contentSha256 !== sha256(
      serializeFindingManagerValidationReport(publication.report),
    )
  ) {
    throw new Error(
      `Finding manager publication "${publication.publicationId}" failed integrity validation`,
    );
  }
}

export function assertPublication(
  publication: FindingManagerReportPublication,
  roundMarker: string,
  domainId: string,
  runId: string,
): void {
  assertPublicationIntent(publication, roundMarker);
  assertNativePublicationContent(publication, domainId, runId);
}
