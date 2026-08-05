import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import {
  computeTerminalEpisodeId,
  findingContentAddress,
} from '../../models/finding-contract-identity.js';
import type {
  TerminalAdjudicationCandidateSnapshot,
  TerminalSourceClaimRef,
  TerminalTargetCandidateRef,
} from '../../models/finding-contract-types.js';
import type {
  FindingLedger,
  FindingLedgerEntry,
  FindingProvisionalKind,
} from './types.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { hasUnsettledActiveConflictOwnership } from './conflict-ownership.js';

const ENTITY_ADJUDICATION_PROVISIONAL_KINDS = new Set<FindingProvisionalKind>([
  'raw-meaning-ambiguous',
  'raw-adjudication-unresolved',
  'recovery-origin-stale',
  'manager-budget-exhausted',
  'manager-input-overflow',
  'interpretation-interrupted',
  'manager-output-discarded',
  'stale-precondition',
]);

export function isOpenProvisional(
  finding: FindingLedgerEntry,
): finding is FindingLedgerEntry & { provisional: NonNullable<FindingLedgerEntry['provisional']> } {
  return finding.status === 'open'
    && finding.provisional !== undefined
    && finding.reviewerAnomalyReclassification === undefined;
}

export function isOpenProvisionalForActionRecovery(
  finding: FindingLedgerEntry,
): finding is FindingLedgerEntry & { provisional: NonNullable<FindingLedgerEntry['provisional']> } {
  return finding.status === 'open' && finding.provisional !== undefined;
}

function claimSnapshotDigest(finding: FindingLedgerEntry): string {
  return findingContentAddress('terminal-finding-claim-snapshot', {
    findingId: finding.id,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
    rawFindingIds: [...finding.rawFindingIds].sort(compareBinaryStrings),
    evidenceIds: [...finding.evidenceIds].sort(compareBinaryStrings),
  });
}

function provenanceEventId(
  ledger: FindingLedger,
  findingId: string,
  rawFindingId: string,
): string {
  const bindingIds = new Set(ledger.evidenceBindings.filter((binding) => (
    binding.target.entityKind === 'finding'
    && binding.target.entityId === findingId
    && binding.sourceRawFindingId === rawFindingId
  )).map(({ bindingId }) => bindingId));
  const matches = ledger.lifecycleEvents.filter((event) => (
    event.transitions.some((transition) => transition.after.entityKind === 'finding'
      && transition.after.entityId === findingId)
    && event.evidenceBindingIds.some((bindingId) => bindingIds.has(bindingId))
  ));
  if (matches.length === 0) {
    throw new Error(`Terminal source raw "${rawFindingId}" has no provenance event`);
  }
  return matches[0]!.eventId;
}

function sourceClaims(
  ledger: FindingLedger,
  finding: FindingLedgerEntry & { provisional: NonNullable<FindingLedgerEntry['provisional']> },
): TerminalSourceClaimRef[] {
  return finding.provisional.sourceRawFindingIds.map((rawFindingId) => {
    const raws = ledger.rawFindings.filter((raw) => raw.rawFindingId === rawFindingId);
    const snapshots = ledger.rawCanonicalSnapshots.filter(
      (snapshot) => snapshot.rawFindingId === rawFindingId,
    );
    if (raws.length !== 1 || snapshots.length !== 1) {
      throw new Error(`Terminal source raw "${rawFindingId}" must have exact-one raw and canonical snapshot`);
    }
    const snapshot = snapshots[0]!;
    const provenanceEvent = provenanceEventId(ledger, finding.id, rawFindingId);
    const withoutId = {
      rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      rawPayloadDigest: snapshot.rawPayloadDigest,
      provenanceEventId: provenanceEvent,
    };
    return {
      sourceClaimRefId: findingContentAddress('terminal-source-claim-ref', withoutId),
      ...withoutId,
    };
  }).sort((left, right) => compareBinaryStrings(left.sourceClaimRefId, right.sourceClaimRefId));
}

function targetCandidates(
  ledger: FindingLedger,
  finding: FindingLedgerEntry,
): TerminalTargetCandidateRef[] {
  return ledger.findings.flatMap((candidate) => {
    if (candidate.id === finding.id || candidate.status !== 'open' || candidate.provisional !== undefined) {
      return [];
    }
    const expectedHead = captureFindingLifecycleHead(ledger, 'finding', candidate.id);
    if (expectedHead === undefined) {
      throw new Error(`Terminal target candidate "${candidate.id}" has no lifecycle head`);
    }
    const snapshotDigest = claimSnapshotDigest(candidate);
    const withoutId = {
      findingId: candidate.id,
      expectedHead,
      claimSnapshotDigest: snapshotDigest,
    };
    return [{
      targetRefId: findingContentAddress('terminal-target-candidate-ref', withoutId),
      ...withoutId,
    }];
  }).sort((left, right) => compareBinaryStrings(left.targetRefId, right.targetRefId));
}

export function buildTerminalAdjudicationCandidateSnapshot(input: {
  ledger: FindingLedger;
  finding: FindingLedgerEntry;
  currentRound: number;
  allowExistingEpisode?: boolean;
}): TerminalAdjudicationCandidateSnapshot | undefined {
  const finding = input.finding;
  if (
    !isOpenProvisional(finding)
    || !ENTITY_ADJUDICATION_PROVISIONAL_KINDS.has(finding.provisional.kind)
    || finding.provisional.firstObservedRound >= input.currentRound
    || finding.provisional.sourceRawFindingIds.length === 0
    || hasUnsettledActiveConflictOwnership(input.ledger, finding.id)
  ) {
    return undefined;
  }
  const expectedHead = captureFindingLifecycleHead(input.ledger, 'finding', finding.id);
  if (expectedHead === undefined) {
    throw new Error(`Terminal candidate "${finding.id}" has no lifecycle head`);
  }
  const sources = sourceClaims(input.ledger, finding);
  const targets = targetCandidates(input.ledger, finding);
  const withoutDigest = {
    findingId: finding.id,
    expectedHead,
    provisionalKind: finding.provisional.kind,
    provisionalStableKey: finding.provisional.stableKey,
    lineageKey: finding.provisional.lineageKey,
    sourceClaims: sources,
    targetCandidates: targets,
  };
  const candidateSnapshotDigest = findingContentAddress('terminal-adjudication-candidate', {
    findingId: finding.id,
    expectedHead,
    provisionalKind: finding.provisional.kind,
    provisionalStableKey: finding.provisional.stableKey,
    lineageKey: finding.provisional.lineageKey,
    sourceClaimRefIds: sources.map(({ sourceClaimRefId }) => sourceClaimRefId),
    targetCandidateRefIds: targets.map(({ targetRefId }) => targetRefId),
  });
  const episodeId = computeTerminalEpisodeId({
    findingId: finding.id,
    expectedHead,
    candidateSnapshotDigest,
  });
  if (
    input.allowExistingEpisode !== true
    && input.ledger.terminalAdjudicationEpisodes.some((episode) => episode.episodeId === episodeId)
  ) {
    return undefined;
  }
  return { candidateSnapshotDigest, ...withoutDigest };
}

export function selectTerminalAdjudicationCandidates(input: {
  ledger: FindingLedger;
  currentRound: number;
}): TerminalAdjudicationCandidateSnapshot[] {
  return input.ledger.findings.flatMap((finding) => {
    const candidate = buildTerminalAdjudicationCandidateSnapshot({ ...input, finding });
    return candidate === undefined ? [] : [candidate];
  }).sort((left, right) => compareBinaryStrings(left.findingId, right.findingId));
}

export function terminalAdjudicationAttemptCount(ledger: FindingLedger, findingId: string): number {
  return ledger.terminalAdjudicationAttempts.filter((attempt) => attempt.findingId === findingId).length;
}

export function isTerminalAdjudicationCandidate(input: {
  ledger: FindingLedger;
  finding: FindingLedgerEntry;
  currentRound: number;
}): boolean {
  return buildTerminalAdjudicationCandidateSnapshot(input) !== undefined;
}
