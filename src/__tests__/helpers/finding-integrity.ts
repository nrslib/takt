import type { RawFinding } from '../../core/workflow/findings/types.js';
import { computeRawEvidenceHash } from '../../core/workflow/findings/raw-canonicalization.js';
import { computeCanonicalRawIntegrityDigest } from '../../core/workflow/findings/finding-integrity.js';

export function storedRawReconcileProvenance(
  rawFinding: RawFinding,
  reviewerStableKey: string,
  lineageKey: string,
) {
  const claimIdentityHash = computeRawEvidenceHash(rawFinding);
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
