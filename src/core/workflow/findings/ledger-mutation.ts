import { assertFindingLedgerProjectionInvariant } from '../../models/finding-ledger-invariants.js';
import {
  assertGeneralPendingManagerCommitTransition,
  finalizePendingManagerCommit,
  rebindPendingManagerCommit,
  stagePendingManagerCommit,
} from './manager-pending-commit.js';
import { parseFindingLedger } from './schemas.js';
import type {
  FindingLedger,
  FindingManagerReportPublication,
} from './types.js';
import type { FindingManagerLedgerCommit } from './store.js';
import {
  assertFindingLedgerAppendOnlyProjection,
  assertFindingLedgerAppendOnlyTransition,
} from './finding-integrity.js';
import { addRoundMarker } from './round-marker.js';

export interface FindingLedgerMutationValue<Result> {
  readonly ledger: FindingLedger;
  readonly result: Result;
}

export function cloneFindingLedgerMutation<Result>(
  mutation: FindingLedgerMutationValue<Result>,
): FindingLedgerMutationValue<Result> {
  return {
    ledger: structuredClone(mutation.ledger),
    result: mutation.result,
  };
}

export function normalizeFindingLedger(
  value: unknown,
  workflowName: string,
): FindingLedger {
  const ledger = parseFindingLedger(value);
  if (ledger.workflowName !== workflowName) {
    throw new Error(
      `Finding ledger workflowName mismatch: expected "${workflowName}", got "${ledger.workflowName}"`,
    );
  }
  assertFindingLedgerProjectionInvariant(ledger);
  assertFindingLedgerAppendOnlyProjection(ledger);
  return ledger;
}

function normalizeFindingLedgerTransition(
  current: FindingLedger,
  next: FindingLedger,
  workflowName: string,
): FindingLedger {
  const normalized = normalizeFindingLedger(next, workflowName);
  assertFindingLedgerAppendOnlyTransition(current, normalized);
  return normalized;
}

export function normalizeFindingLedgerMutation<Result>(
  current: FindingLedger,
  mutation: FindingLedgerMutationValue<Result>,
  workflowName: string,
): FindingLedgerMutationValue<Result> {
  const normalized = {
    ...mutation,
    ledger: normalizeFindingLedgerTransition(current, mutation.ledger, workflowName),
  };
  assertGeneralPendingManagerCommitTransition(current, normalized.ledger);
  return normalized;
}

export function assertFindingManagerLedgerCommit<Result>(
  commit: FindingManagerLedgerCommit<Result>,
): void {
  const commitKeys = Object.keys(commit);
  if (commitKeys.some((key) => (
    key !== 'ledger' && key !== 'result' && key !== 'publication'
  ))) {
    throw new Error('Finding manager commit contains forged publication fields');
  }
  if (commit.publication === undefined) {
    return;
  }
  if (commit.ledger.pendingManagerCommit !== undefined) {
    throw new Error('Finding manager commit contains two publication stages');
  }
  const publicationKeys = Object.keys(commit.publication);
  if (
    publicationKeys.length !== 2
    || !publicationKeys.includes('roundMarker')
    || !publicationKeys.includes('report')
  ) {
    throw new Error('Finding manager commit contains forged publication fields');
  }
}

export function normalizePendingManagerCommitFinalization(
  current: FindingLedger,
  publicationId: string,
  workflowName: string,
): FindingLedger {
  return normalizeFindingLedgerTransition(
    current,
    finalizePendingManagerCommit(current, publicationId),
    workflowName,
  );
}

export function normalizePendingManagerCommitRebind(
  current: FindingLedger,
  publication: FindingManagerReportPublication,
  workflowName: string,
): FindingLedger {
  return normalizeFindingLedgerTransition(
    current,
    rebindPendingManagerCommit(
      current,
      publication.publicationId,
      publication,
    ),
    workflowName,
  );
}

export function normalizePendingManagerCommitStage(
  current: FindingLedger,
  completedLedger: FindingLedger,
  roundMarker: string,
  publication: FindingManagerReportPublication,
  workflowName: string,
): FindingLedger {
  const completed = normalizeFindingLedgerTransition(
    current,
    completedLedger,
    workflowName,
  );
  const previousRoundMarkers = current.stopBudget?.roundMarkers ?? [];
  const completedRoundMarkers = completed.stopBudget?.roundMarkers ?? [];
  const expectedRoundMarkers = addRoundMarker(previousRoundMarkers, roundMarker);
  if (
    previousRoundMarkers.includes(roundMarker)
    || completedRoundMarkers.length - previousRoundMarkers.length !== 1
    || completedRoundMarkers.length !== expectedRoundMarkers.length
    || completedRoundMarkers.some(
      (marker, index) => marker !== expectedRoundMarkers[index],
    )
  ) {
    throw new Error(
      `Completed manager round "${roundMarker}" does not match the store transition`,
    );
  }
  return normalizeFindingLedger(
    stagePendingManagerCommit({
      previousLedger: current,
      completedLedger: completed,
      roundMarker,
      publication,
    }),
    workflowName,
  );
}
