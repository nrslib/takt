import type { FindingLedgerEntry } from './types.js';
import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';

export interface CanonicalEntityHeadProjection {
  findings: Array<{
    id: string;
    revision: number;
    status: FindingLedgerEntry['status'];
    lifecycle: FindingLedgerEntry['lifecycle'];
    severity: FindingLedgerEntry['severity'];
    title: string | null;
    description: string | null;
    suggestion: string | null;
    target: FindingLedgerEntry['target'];
    targetIdentityHash: string | null;
    claimIdentityHash: string | null;
    semanticClaimIdentityHash: string | null;
    provisional: { kind: NonNullable<FindingLedgerEntry['provisional']>['kind'] } | null;
  }>;
}

export function buildCanonicalEntityHeadProjection(
  findings: readonly FindingLedgerEntry[],
): CanonicalEntityHeadProjection {
  return {
    findings: [...findings]
      .sort((left, right) => compareBinaryStrings(left.id, right.id))
      .map((finding) => ({
        id: finding.id,
        revision: finding.revision,
        status: finding.status,
        lifecycle: finding.lifecycle,
        severity: finding.severity,
        title: finding.title,
        description: finding.description ?? null,
        suggestion: finding.suggestion ?? null,
        target: finding.target === null ? null : structuredClone(finding.target),
        targetIdentityHash: finding.targetIdentityHash,
        claimIdentityHash: finding.claimIdentityHash,
        semanticClaimIdentityHash: finding.semanticClaimIdentityHash,
        provisional: finding.provisional === undefined
          ? null
          : { kind: finding.provisional.kind },
      })),
  };
}
