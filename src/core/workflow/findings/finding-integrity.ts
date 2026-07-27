import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import type {
  CanonicalRawFindingProvenance,
  RawFinding,
} from './types.js';

const RAW_FINDING_INTEGRITY_VERSION = 1;
const CANONICAL_RAW_INTEGRITY_VERSION = 1;

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function computeRawFindingIntegrityDigest(rawFinding: RawFinding): string {
  return sha256Canonical({
    version: RAW_FINDING_INTEGRITY_VERSION,
    rawFinding,
  });
}

export interface CanonicalRawIntegrityInput {
  canonicalWire: RawFinding;
  provenance: CanonicalRawFindingProvenance;
  reviewerStableKey: string;
  lineageKey: string;
  claimIdentityHash: string;
}

export function computeCanonicalRawIntegrityDigest(
  input: CanonicalRawIntegrityInput,
): string {
  return sha256Canonical({
    version: CANONICAL_RAW_INTEGRITY_VERSION,
    canonicalWire: input.canonicalWire,
    typedEvidence: input.canonicalWire.evidence === undefined
      ? null
      : { ...input.canonicalWire.evidence },
    provenance: input.provenance,
    stableIdentity: {
      rawFindingId: input.canonicalWire.rawFindingId,
      reviewerStableKey: input.reviewerStableKey,
      lineageKey: input.lineageKey,
      claimIdentityHash: input.claimIdentityHash,
    },
  });
}

export function assertRawFindingsAppendOnly(
  current: readonly RawFinding[],
  next: readonly RawFinding[],
): void {
  const currentById = uniqueRawFindingsById(current, 'current');
  const nextById = uniqueRawFindingsById(next, 'next');
  for (const [rawFindingId, existing] of currentById) {
    const candidate = nextById.get(rawFindingId);
    if (candidate === undefined) {
      throw new Error(`Raw finding "${rawFindingId}" cannot be removed from the append-only ledger`);
    }
    if (
      computeRawFindingIntegrityDigest(existing)
      !== computeRawFindingIntegrityDigest(candidate)
    ) {
      throw new Error(`Raw finding "${rawFindingId}" cannot be replaced with different content`);
    }
  }
}

function uniqueRawFindingsById(
  rawFindings: readonly RawFinding[],
  label: string,
): Map<string, RawFinding> {
  const byId = new Map<string, RawFinding>();
  for (const rawFinding of rawFindings) {
    const existing = byId.get(rawFinding.rawFindingId);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate ${label} raw finding "${rawFinding.rawFindingId}" is not allowed`,
      );
    }
    byId.set(rawFinding.rawFindingId, rawFinding);
  }
  return byId;
}
