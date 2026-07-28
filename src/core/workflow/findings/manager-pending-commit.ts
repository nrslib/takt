import type {
  FindingLedger,
  FindingManagerCommitProjection,
  FindingManagerReportPublication,
} from './types.js';
import { assertFindingLedgerProjectionInvariant } from '../../models/finding-ledger-invariants.js';
import {
  assertFindingLedgerAppendOnlyTransition,
} from './finding-integrity.js';

function projectManagerCommit(ledger: FindingLedger): FindingManagerCommitProjection {
  return {
    nextId: ledger.nextId,
    updatedAt: ledger.updatedAt,
    findings: ledger.findings,
    evidenceRecords: ledger.evidenceRecords,
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
  const completed = projectManagerCommit(input.completedLedger);
  assertFindingLedgerProjectionInvariant(completed);
  if (completed.stopBudget?.roundMarkers.includes(input.roundMarker) !== true) {
    throw new Error(`Completed manager round "${input.roundMarker}" has no completed stop budget marker`);
  }
  const staged: FindingLedger = {
    ...input.previousLedger,
    pendingManagerCommit: {
      roundMarker: input.roundMarker,
      publication: input.publication,
      completed,
    },
  };
  if (
    assertFindingLedgerAppendOnlyTransition(input.previousLedger, staged)
    !== 'stage'
  ) {
    throw new Error(`Manager round "${input.roundMarker}" did not produce a stage transition`);
  }
  return staged;
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
  const rebound: FindingLedger = {
    ...ledger,
    pendingManagerCommit: {
      ...pending,
      publication,
    },
  };
  const transition = assertFindingLedgerAppendOnlyTransition(ledger, rebound);
  if (transition !== 'rebind' && transition !== 'unchanged') {
    throw new Error(`Pending manager publication "${publicationId}" did not produce a rebind transition`);
  }
  return rebound;
}

export function finalizePendingManagerCommit(
  ledger: FindingLedger,
  publicationId: string,
): FindingLedger {
  const pending = ledger.pendingManagerCommit;
  if (pending === undefined || pending.publication.publicationId !== publicationId) {
    throw new Error(`Pending manager commit CAS failed for publication "${publicationId}"`);
  }
  const finalized: FindingLedger = {
    workflowName: ledger.workflowName,
    ...pending.completed,
  };
  if (assertFindingLedgerAppendOnlyTransition(ledger, finalized) !== 'finalize') {
    throw new Error(`Pending manager publication "${publicationId}" did not produce a finalization transition`);
  }
  return finalized;
}

export function assertGeneralPendingManagerCommitTransition(
  current: FindingLedger,
  next: FindingLedger,
): void {
  const transition = assertFindingLedgerAppendOnlyTransition(current, next);
  if (transition === 'ordinary' || transition === 'unchanged') {
    return;
  }
  const pending = current.pendingManagerCommit;
  if (transition === 'stage') {
    throw new Error(
      `Finding ledger publication "${next.pendingManagerCommit!.publication.publicationId}" `
      + 'cannot be staged through the general mutation API',
    );
  }
  throw new Error(
    `Finding ledger publication "${pending!.publication.publicationId}" is pending; `
    + 'changes require the dedicated finalization API or authorized rebind API',
  );
}
