import { verifySameProofAgainstLedger } from './raw-capabilities.js';
import type {
  DeterministicSameProof,
  FindingLedger,
  InterpretationCase,
} from './types.js';

export interface InterpretationCaseProofFastPathSelection {
  caseId: string;
  lineageKey: string;
  semanticProjectionDigest: string;
  targetFindingId: string;
  targetRevision: number;
  proofs: DeterministicSameProof[];
}

export function selectInterpretationCaseProofFastPath(input: {
  plannedCase: InterpretationCase;
  ledger: FindingLedger;
}): InterpretationCaseProofFastPathSelection | null {
  if (input.plannedCase.kind !== 'provider_case') {
    return null;
  }
  const verified = input.plannedCase.members.map((member) => {
    if (member.proofBinding === undefined) {
      return null;
    }
    const verification = verifySameProofAgainstLedger(member.proofBinding, input.ledger);
    if (!verification.ok || member.proofBinding.rawFindingId !== member.rawFindingId) {
      return null;
    }
    return { proof: member.proofBinding, target: verification.target };
  });
  if (verified.some((entry) => entry === null)) {
    return null;
  }
  const entries = verified.filter((entry) => entry !== null);
  const targetFindingId = entries[0]?.target.id;
  if (
    targetFindingId === undefined
    || entries.some((entry) => entry.target.id !== targetFindingId)
  ) {
    return null;
  }
  return {
    caseId: input.plannedCase.caseId,
    lineageKey: input.plannedCase.lineageKey,
    semanticProjectionDigest: input.plannedCase.semanticProjectionDigest,
    targetFindingId,
    targetRevision: entries[0]!.proof.targetRevision,
    proofs: entries.map((entry) => entry.proof),
  };
}
