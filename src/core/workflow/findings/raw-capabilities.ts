import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import type {
  CanonicalRawFinding,
  DeterministicSameProof,
  FindingLedger,
  FindingLedgerEntry,
} from './types.js';
import { assertCanonicalRawFinding } from './raw-canonicalization.js';

const SAME_PROOF_REGISTRY = new WeakSet<object>();

type UnbrandedSameProof = {
  [K in keyof DeterministicSameProof as K extends symbol ? never : K]:
    DeterministicSameProof[K];
};

function issueProof(value: UnbrandedSameProof): DeterministicSameProof {
  const branded = value as unknown as DeterministicSameProof;
  SAME_PROOF_REGISTRY.add(branded);
  return branded;
}

export function isEngineIssuedSameProof(value: unknown): value is DeterministicSameProof {
  return typeof value === 'object' && value !== null && SAME_PROOF_REGISTRY.has(value);
}

function sameProofIdentityKey(fields: {
  targetIdentityHash: string | null;
  semanticClaimIdentityHash: string | null;
}): string | undefined {
  return fields.targetIdentityHash === null || fields.semanticClaimIdentityHash === null
    ? undefined
    : canonicalJson({
        targetIdentityHash: fields.targetIdentityHash,
        semanticClaimIdentityHash: fields.semanticClaimIdentityHash,
      });
}

function indexOpenFinding(
  index: Map<string, FindingLedgerEntry[]>,
  identity: string,
  finding: FindingLedgerEntry,
): void {
  const indexed = index.get(identity) ?? [];
  if (!indexed.some((candidate) => candidate.id === finding.id)) {
    index.set(identity, [...indexed, finding]);
  }
}

function openFindingsByIdentity(ledger: FindingLedger): Map<string, FindingLedgerEntry[]> {
  const rawById = new Map(ledger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  const index = new Map<string, FindingLedgerEntry[]>();
  for (const finding of ledger.findings) {
    if (finding.status !== 'open' || finding.provisional !== undefined) {
      continue;
    }
    const ownIdentity = sameProofIdentityKey(finding);
    if (ownIdentity !== undefined) {
      indexOpenFinding(index, ownIdentity, finding);
    }
    for (const rawFindingId of finding.rawFindingIds) {
      const raw = rawById.get(rawFindingId);
      if (raw === undefined) {
        continue;
      }
      const rawIdentity = sameProofIdentityKey(raw);
      if (rawIdentity !== undefined) {
        indexOpenFinding(index, rawIdentity, finding);
      }
    }
  }
  return index;
}

export function issueDeterministicSameProofs(input: {
  ledger: FindingLedger;
  ambiguousRawFindings: readonly CanonicalRawFinding[];
  excludedTargetFindingIdsByRawFindingId: ReadonlyMap<string, ReadonlySet<string>>;
}): Map<string, DeterministicSameProof> {
  const index = openFindingsByIdentity(input.ledger);
  const proofs = new Map<string, DeterministicSameProof>();
  for (const raw of input.ambiguousRawFindings) {
    assertCanonicalRawFinding(raw, 'issueDeterministicSameProofs');
    if (raw.title === undefined || raw.description === undefined) {
      continue;
    }
    const identity = sameProofIdentityKey(raw);
    if (identity === undefined) {
      continue;
    }
    const excluded = input.excludedTargetFindingIdsByRawFindingId.get(raw.rawFindingId);
    const targets = (index.get(identity) ?? []).filter(
      (candidate) => excluded?.has(candidate.id) !== true,
    );
    if (targets.length !== 1) {
      continue;
    }
    const target = targets[0]!;
    const identityHash = createHash('sha256').update(identity).digest('hex');
    const proofId = createHash('sha256').update([
      'same-proof',
      raw.rawFindingId,
      target.id,
      String(target.revision),
      identityHash,
    ].join('\0')).digest('hex');
    proofs.set(raw.rawFindingId, issueProof({
      proofId,
      rawFindingId: raw.rawFindingId,
      targetFindingId: target.id,
      targetRevision: target.revision,
      targetIdentityHash: raw.targetIdentityHash,
      identityHash,
      algorithmVersion: 1,
    }));
  }
  return proofs;
}

export function verifySameProofAgainstLedger(
  proof: DeterministicSameProof,
  ledger: FindingLedger,
): { ok: true; target: FindingLedgerEntry } | { ok: false; reason: string } {
  if (!isEngineIssuedSameProof(proof)) {
    return { ok: false, reason: 'proof was not issued by the engine' };
  }
  const target = ledger.findings.find((finding) => finding.id === proof.targetFindingId);
  if (target === undefined) {
    return { ok: false, reason: `target finding "${proof.targetFindingId}" no longer exists` };
  }
  if (target.status !== 'open' || target.provisional !== undefined) {
    return { ok: false, reason: `target finding "${proof.targetFindingId}" is not an open product finding` };
  }
  if (target.revision !== proof.targetRevision) {
    return { ok: false, reason: `target finding "${proof.targetFindingId}" revision changed` };
  }
  if (target.targetIdentityHash !== proof.targetIdentityHash) {
    return { ok: false, reason: `target finding "${proof.targetFindingId}" target identity changed` };
  }
  return { ok: true, target };
}
