import type {
  FindingLedger,
  FindingLifecycleEntityHead,
  FindingProvisionalKind,
} from './types.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

export function conflictTargetPaths(input: {
  ledger: FindingLedger;
  conflictId: string;
}): string[] {
  const conflict = input.ledger.conflicts.find((candidate) => candidate.id === input.conflictId);
  if (conflict === undefined) {
    return [];
  }
  const findings = conflict.findingIds
    .map((findingId) => input.ledger.findings.find((finding) => finding.id === findingId))
    .filter((finding): finding is NonNullable<typeof finding> => finding !== undefined);
  const rawFindingIds = [
    ...new Set([
      ...conflict.rawFindingIds,
      ...findings.flatMap((finding) => finding.rawFindingIds),
    ]),
  ];
  const rawFindings = rawFindingIds
    .map((rawFindingId) => input.ledger.rawFindings.find((raw) => raw.rawFindingId === rawFindingId))
    .filter((raw): raw is NonNullable<typeof raw> => raw !== undefined);
  const paths = new Set<string>();
  for (const target of [
    ...findings.map((finding) => finding.target),
    ...rawFindings.map((raw) => raw.target),
  ]) {
    if (target?.kind === 'code') {
      target.paths.forEach((path) => paths.add(path));
    }
  }
  return [...paths].sort(compareBinaryStrings);
}

export type ConflictTargetClassification =
  | {
      kind: 'product_target';
      findingId: string;
      expectedHead: FindingLifecycleEntityHead;
    }
  | {
      kind: 'provisional_target';
      findingId: string;
      expectedHead: FindingLifecycleEntityHead;
      provisionalKind: FindingProvisionalKind;
      provisionalStableKey: string;
      provisionalLineageKey: string;
      targetIdentityHash: string | null;
      claimIdentityHash: string | null;
      semanticClaimIdentityHash: string | null;
    };

export function classifyConflictTarget(input: {
  ledger: FindingLedger;
  targetFindingId: string;
}): ConflictTargetClassification {
  const finding = input.ledger.findings.find(
    (candidate) => candidate.id === input.targetFindingId,
  );
  if (finding === undefined || finding.status !== 'open') {
    throw new Error(`Conflict target "${input.targetFindingId}" must be an open finding`);
  }
  const expectedHead = captureFindingLifecycleHead(
    input.ledger,
    'finding',
    finding.id,
  );
  if (expectedHead === undefined) {
    throw new Error(`Conflict target "${finding.id}" has no lifecycle head`);
  }
  if (finding.provisional === undefined) {
    return { kind: 'product_target', findingId: finding.id, expectedHead };
  }
  return {
    kind: 'provisional_target',
    findingId: finding.id,
    expectedHead,
    provisionalKind: finding.provisional.kind,
    provisionalStableKey: finding.provisional.stableKey,
    provisionalLineageKey: finding.provisional.lineageKey,
    targetIdentityHash: finding.targetIdentityHash,
    claimIdentityHash: finding.claimIdentityHash,
    semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
  };
}
