import type {
  FindingLedgerEntry,
  FindingProvisionalMetadata,
} from './types.js';

export interface ProvisionalRecoveryOrigin {
  provisionalFindingId: string;
  expectedProvisionalRevision: number;
  expectedTargetIdentityHash: string | null;
  expectedProvisionalStableKey: string;
  expectedProvisionalLineageKey: string;
  expectedRecoveryReviewerStableKey?: string;
}

export function snapshotProvisionalRecoveryOrigin(
  finding: FindingLedgerEntry & { provisional: FindingProvisionalMetadata },
): ProvisionalRecoveryOrigin {
  return {
    provisionalFindingId: finding.id,
    expectedProvisionalRevision: finding.revision,
    expectedTargetIdentityHash: finding.targetIdentityHash,
    expectedProvisionalStableKey: finding.provisional.stableKey,
    expectedProvisionalLineageKey: finding.provisional.lineageKey,
    ...(finding.provisional.recoveryReviewerStableKey === undefined
      ? {}
      : {
          expectedRecoveryReviewerStableKey:
            finding.provisional.recoveryReviewerStableKey,
        }),
  };
}

export function matchesProvisionalRecoveryOrigin(
  finding: FindingLedgerEntry,
  origin: ProvisionalRecoveryOrigin,
): finding is FindingLedgerEntry & { provisional: FindingProvisionalMetadata } {
  return finding.id === origin.provisionalFindingId
    && finding.status === 'open'
    && finding.provisional !== undefined
    && finding.revision === origin.expectedProvisionalRevision
    && finding.targetIdentityHash === origin.expectedTargetIdentityHash
    && finding.provisional.stableKey === origin.expectedProvisionalStableKey
    && finding.provisional.lineageKey === origin.expectedProvisionalLineageKey
    && finding.provisional.recoveryReviewerStableKey
      === origin.expectedRecoveryReviewerStableKey;
}

export function collectStaleRecoveryRawFindingIds(
  items: readonly {
    canonical: { rawFindingId: string };
    recoveryOrigins?: readonly ProvisionalRecoveryOrigin[];
  }[],
  ledger: { findings: FindingLedgerEntry[] },
): Set<string> {
  const findingsById = new Map(ledger.findings.map((finding) => [finding.id, finding]));
  return new Set(items.flatMap((item) => {
    if (item.recoveryOrigins === undefined) {
      return [];
    }
    const anyFresh = item.recoveryOrigins.some((origin) => {
      const finding = findingsById.get(origin.provisionalFindingId);
      return finding !== undefined && matchesProvisionalRecoveryOrigin(finding, origin);
    });
    return anyFresh ? [] : [item.canonical.rawFindingId];
  }));
}
