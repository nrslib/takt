import type {
  FindingLedger,
  FindingManagerCommitProjection,
  FindingManagerReportPublication,
} from './types.js';
import { assertFindingLedgerProjectionInvariant } from '../../models/finding-ledger-invariants.js';
import { assertRawFindingsAppendOnly } from './finding-integrity.js';

function projectManagerCommit(ledger: FindingLedger): FindingManagerCommitProjection {
  return {
    nextId: ledger.nextId,
    updatedAt: ledger.updatedAt,
    findings: ledger.findings,
    rawFindings: ledger.rawFindings,
    conflicts: ledger.conflicts,
    interpretations: ledger.interpretations,
    ...(ledger.fixpoint === undefined ? {} : { fixpoint: ledger.fixpoint }),
    ...(ledger.stopBudget === undefined ? {} : { stopBudget: ledger.stopBudget }),
    ...(ledger.reviewerAnomalies === undefined
      ? {}
      : { reviewerAnomalies: ledger.reviewerAnomalies }),
    ...(ledger.reviewIntegrity === undefined
      ? {}
      : { reviewIntegrity: ledger.reviewIntegrity }),
  };
}

function withoutPending(ledger: FindingLedger): FindingLedger {
  const current = { ...ledger };
  delete current.pendingManagerCommit;
  return current;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function samePublicationIntent(
  current: FindingManagerReportPublication,
  next: FindingManagerReportPublication,
): boolean {
  return current.publicationId === next.publicationId
    && current.domainId === next.domainId
    && current.originRunId === next.originRunId
    && current.fileName === next.fileName
    && current.contentSha256 === next.contentSha256
    && sameValue(current.report, next.report);
}

function samePublication(
  current: FindingManagerReportPublication,
  next: FindingManagerReportPublication,
): boolean {
  return samePublicationIntent(current, next)
    && current.destinationRunId === next.destinationRunId;
}

export function stagePendingManagerCommit(input: {
  completedLedger: FindingLedger;
  previousLedger: FindingLedger;
  roundMarker: string;
  publication: FindingManagerReportPublication;
}): FindingLedger {
  if (input.previousLedger.pendingManagerCommit !== undefined) {
    throw new Error(
      `Cannot stage manager round "${input.roundMarker}" while another manager commit is pending`,
    );
  }
  if (input.completedLedger.workflowName !== input.previousLedger.workflowName) {
    throw new Error(`Completed manager round "${input.roundMarker}" changed the workflow identity`);
  }
  if (input.completedLedger.pendingManagerCommit !== undefined) {
    throw new Error(`Completed manager round "${input.roundMarker}" contains a nested pending commit`);
  }
  assertRawFindingsAppendOnly(
    input.previousLedger.rawFindings,
    input.completedLedger.rawFindings,
  );
  const completed = projectManagerCommit(input.completedLedger);
  assertFindingLedgerProjectionInvariant(completed);
  if (completed.stopBudget?.roundMarkers.includes(input.roundMarker) !== true) {
    throw new Error(`Completed manager round "${input.roundMarker}" has no completed stop budget marker`);
  }
  return {
    ...input.previousLedger,
    pendingManagerCommit: {
      roundMarker: input.roundMarker,
      publication: input.publication,
      completed,
    },
  };
}

export function rebindPendingManagerCommit(
  ledger: FindingLedger,
  publicationId: string,
  publication: FindingManagerReportPublication,
): FindingLedger {
  const pending = ledger.pendingManagerCommit;
  if (pending === undefined || pending.publication.publicationId !== publicationId) {
    throw new Error(`Pending manager commit CAS failed for publication "${publicationId}"`);
  }
  if (!samePublicationIntent(pending.publication, publication)) {
    throw new Error(`Pending manager publication intent changed for "${publicationId}"`);
  }
  return {
    ...ledger,
    pendingManagerCommit: {
      ...pending,
      publication,
    },
  };
}

export function finalizePendingManagerCommit(
  ledger: FindingLedger,
  publicationId: string,
): FindingLedger {
  const pending = ledger.pendingManagerCommit;
  if (pending === undefined || pending.publication.publicationId !== publicationId) {
    throw new Error(`Pending manager commit CAS failed for publication "${publicationId}"`);
  }
  const finalized = {
    workflowName: ledger.workflowName,
    ...pending.completed,
  };
  assertRawFindingsAppendOnly(ledger.rawFindings, finalized.rawFindings);
  return finalized;
}

export function assertGeneralPendingManagerCommitTransition(
  current: FindingLedger,
  next: FindingLedger,
): void {
  const pending = current.pendingManagerCommit;
  if (pending === undefined) {
    if (next.pendingManagerCommit === undefined) {
      return;
    }
    throw new Error(
      `Finding ledger publication "${next.pendingManagerCommit.publication.publicationId}" `
      + 'cannot be staged through the general mutation API',
    );
  }
  const nextPending = next.pendingManagerCommit;
  if (nextPending !== undefined) {
    const topLevelUnchanged = sameValue(withoutPending(current), withoutPending(next));
    const completedUnchanged = sameValue(pending.completed, nextPending.completed);
    const pendingUnchanged = pending.roundMarker === nextPending.roundMarker
      && samePublication(pending.publication, nextPending.publication);
    if (topLevelUnchanged && completedUnchanged && pendingUnchanged) {
      return;
    }
  }
  throw new Error(
    `Finding ledger publication "${pending.publication.publicationId}" is pending; `
    + 'changes require the dedicated finalization API or authorized rebind API',
  );
}
