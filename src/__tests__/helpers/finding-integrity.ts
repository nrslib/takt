import type { RawFinding } from '../../core/workflow/findings/types.js';
import { computeClaimIdentityHash } from '../../core/workflow/findings/evidence-domain.js';
import { computeCanonicalRawIntegrityDigest } from '../../core/workflow/findings/finding-integrity.js';

export function storedRawReconcileProvenance(
  rawFinding: RawFinding,
  reviewerStableKey: string,
  lineageKey: string,
) {
  const claimIdentityHash = computeClaimIdentityHash(rawFinding);
  const canonicalProvenance = {
    origin: 'stored-ledger' as const,
    ambiguityOrigin: false,
    clarificationAttempted: false,
    ambiguityCodes: [],
  };
  return {
    reviewerStableKey,
    lineageKey,
    claimIdentityHash,
    canonicalProvenance,
    canonicalIntegrityDigest: computeCanonicalRawIntegrityDigest({
      canonicalWire: rawFinding,
      provenance: canonicalProvenance,
      reviewerStableKey,
      lineageKey,
      claimIdentityHash,
    }),
  };
}
