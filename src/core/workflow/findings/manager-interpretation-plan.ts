import {
  canonicalRawIntegrityDigestOf,
  computeRawEvidenceHash,
  detectRawFindingAmbiguities,
} from './raw-canonicalization.js';
import { MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import { issueDeterministicSameProofs } from './raw-capabilities.js';
import {
  countInterpretationEpochs,
  resolveInterpretationAttempt,
} from './interpretation-wal.js';
import type {
  AmbiguousInterpretation,
  DeterministicSameProof,
  FindingLedger,
} from './types.js';
import {
  assertCanonicalIntakeRecoveryStates,
  type CanonicalIntakeItem,
} from './manager-admission.js';
import { provisionalSpecForRaw } from './manager-provisional.js';
import type { LadderResult, LadderTarget } from './manager-contracts.js';
import type { beginInterpretations } from './interpretation-wal.js';

export function emptyLadderResult(ambiguousRawCount: number): LadderResult {
  return {
    interpretationReservations: new Map(),
    interpretationIntegrityDigests: new Map(),
    integrityStaleInterpretationKeys: new Set(),
    deferredRawFindingIds: new Set(),
    pendingSameWithProof: [],
    pendingIndependentNew: [],
    pendingConflicts: [],
    provisionalSpecs: [],
    provisionalByInterpretationKey: new Map(),
    pendingAppliedReattach: [],
    recoveryProvisionalOrigins: new Map(),
    stats: {
      ambiguousRawCount,
      managerCalls: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      reusedCompletedDecisions: 0,
      interruptedInterpretations: 0,
      budgetExhaustedLineages: 0,
    },
  };
}

interface InitialLadderPlan {
  result: LadderResult;
  needsInterpretation: LadderTarget[];
  proofsByRawId: Map<string, DeterministicSameProof>;
}

export function classifyInitialLadderTargets(input: {
  tainted: readonly CanonicalIntakeItem[];
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
  previousLedger: FindingLedger;
}): InitialLadderPlan {
  const issuedProofs = issueDeterministicSameProofs({
    ledger: input.previousLedger,
    ambiguousRawFindings: input.tainted.map((item) => item.canonical),
    excludedTargetFindingIdsByRawFindingId: new Map(input.tainted.map((item) => [
      item.canonical.rawFindingId,
      new Set(item.recoveryOrigins?.map((origin) => origin.provisionalFindingId) ?? []),
    ])),
  });
  const proofsByRawId = new Map(
    [...issuedProofs].filter(([rawFindingId]) => !input.provisionalOnlyRawFindingIds.has(rawFindingId)),
  );
  assertCanonicalIntakeRecoveryStates(input.tainted, input.previousLedger);
  const classified = input.tainted.reduce<Omit<InitialLadderPlan, 'proofsByRawId'>>((plan, item) => {
    const recoveryEvidenceIsRecorded = item.recoveryOrigins !== undefined
      && item.recoveryOrigins.every((origin) => (
        input.previousLedger.findings.some((finding) => (
          finding.id === origin.provisionalFindingId
          && finding.provisional?.sourceRawFindingIds.some((rawFindingId) => (
            input.previousLedger.rawFindings.some((raw) => (
              raw.rawFindingId === rawFindingId
              && computeRawEvidenceHash(raw) === item.canonical.evidenceSetHash
            ))
          )) === true
        ))
      ));
    const attempt = resolveInterpretationAttempt({
      ledger: input.previousLedger,
      reviewerStableKey: item.canonical.reviewerStableKey,
      lineageKey: item.canonical.lineageKey,
      candidateEvidenceHash: item.canonical.evidenceSetHash,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(item.canonical),
    });
    const target: LadderTarget = item.interpretationRecoveryAttempt === true
      ? {
          canonical: item.canonical,
          wire: item.wire,
          ...attempt,
          interpretationRecoveryAttempt: true,
          recoveryOrigins: item.recoveryOrigins,
        }
      : {
          canonical: item.canonical,
          wire: item.wire,
          ...attempt,
        };
    const proof = item.recoveryOrigins === undefined || recoveryEvidenceIsRecorded
      ? proofsByRawId.get(item.canonical.rawFindingId)
      : undefined;
    if (proof !== undefined) {
      return {
        ...plan,
        result: {
          ...plan.result,
          pendingSameWithProof: [...plan.result.pendingSameWithProof, { target, proof }],
        },
      };
    }
    if (item.canonical.coherence === 'coherent' && item.canonical.relation === 'new') {
      const ambiguity = detectRawFindingAmbiguities(item.canonical, input.previousLedger);
      if (ambiguity.codes.length === 0) {
        const pendingIndependent = target.interpretationRecoveryAttempt === true
          ? {
              wire: item.wire,
              canonical: item.canonical,
              interpretationRecoveryAttempt: true as const,
              recoveryOrigins: target.recoveryOrigins,
            }
          : { wire: item.wire, canonical: item.canonical };
        return {
          ...plan,
          result: {
            ...plan.result,
            pendingIndependentNew: [...plan.result.pendingIndependentNew, pendingIndependent],
          },
        };
      }
    }
    if (countInterpretationEpochs(input.previousLedger, item.canonical.lineageKey)
      >= MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage) {
      return {
        ...plan,
        result: {
          ...plan.result,
          provisionalSpecs: [...plan.result.provisionalSpecs, provisionalSpecForRaw({
            wire: item.wire,
            canonical: item.canonical,
            reason: `Ambiguous raw finding reached the automatic interpretation limit (${MANAGER_INTERPRETATION_LIMITS.maxInterpretationEpochsPerLineage} epochs per lineage); kept provisional without re-interpreting`,
          })],
        },
      };
    }
    return { ...plan, needsInterpretation: [...plan.needsInterpretation, target] };
  }, {
    result: emptyLadderResult(input.tainted.length),
    needsInterpretation: [],
  });
  return { ...classified, proofsByRawId };
}

interface WalLadderPlan {
  result: LadderResult;
  decidedByKey: Map<string, AmbiguousInterpretation>;
  toCall: LadderTarget[];
}

export function classifyInterpretationWal(input: {
  targets: LadderTarget[];
  begin: Awaited<ReturnType<typeof beginInterpretations>>;
  result: LadderResult;
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
}): WalLadderPlan {
  return input.targets.reduce<WalLadderPlan>((plan, target) => {
    const key = target.interpretationKey;
    if (input.begin.deferredKeys.has(key)) {
      return {
        ...plan,
        result: {
          ...plan.result,
          deferredRawFindingIds: new Set([
            ...plan.result.deferredRawFindingIds,
            target.wire.rawFindingId,
          ]),
        },
      };
    }
    if (input.begin.integrityStaleKeys.has(key)) {
      return {
        ...plan,
        result: {
          ...plan.result,
          integrityStaleInterpretationKeys: new Set([
            ...plan.result.integrityStaleInterpretationKeys,
            key,
          ]),
        },
        decidedByKey: new Map([
          ...plan.decidedByKey,
          [key, {
            decision: 'provisional',
            rawFindingId: target.canonical.rawFindingId,
            reason: 'A prior WAL decision has a different canonical integrity digest; the observation is stale and was kept provisional',
          }],
        ]),
      };
    }
    if (input.begin.appliedByKey.has(key)) {
      const priorResult = input.begin.appliedByKey.get(key);
      if ((priorResult === 'created' || priorResult === 'matched_with_proof' || priorResult === 'conflict_created')
        && !input.provisionalOnlyRawFindingIds.has(target.canonical.rawFindingId)) {
        return {
          ...plan,
          result: {
            ...plan.result,
            pendingAppliedReattach: [
              ...plan.result.pendingAppliedReattach,
              { target, applicationResult: priorResult },
            ],
          },
        };
      }
      return {
        ...plan,
        result: {
          ...plan.result,
          provisionalSpecs: [...plan.result.provisionalSpecs, provisionalSpecForRaw({
            wire: target.wire,
            canonical: target.canonical,
            reason: 'Same-evidence observation reappeared after its interpretation was already applied; attached to the existing provisional without re-interpreting',
          })],
        },
      };
    }
    const completed = input.begin.completedByKey.get(key);
    if (completed !== undefined) {
      return {
        ...plan,
        result: {
          ...plan.result,
          stats: {
            ...plan.result.stats,
            reusedCompletedDecisions: plan.result.stats.reusedCompletedDecisions + 1,
          },
        },
        decidedByKey: new Map([...plan.decidedByKey, [key, completed]]),
      };
    }
    return { ...plan, toCall: [...plan.toCall, target] };
  }, {
    result: {
      ...input.result,
      stats: {
        ...input.result.stats,
        interruptedInterpretations: input.result.stats.interruptedInterpretations
          + input.begin.interruptedPriorKeys.size,
      },
    },
    decidedByKey: new Map(),
    toCall: [],
  });
}

export function applyInterpretationDecisions(input: {
  result: LadderResult;
  decisions: ReadonlyMap<string, AmbiguousInterpretation>;
  interpretationTargets: LadderTarget[];
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
  proofsByRawId: ReadonlyMap<string, DeterministicSameProof>;
}): LadderResult {
  const targetsByKey = new Map(input.interpretationTargets.map((target) => [target.interpretationKey, target]));
  return [...input.decisions].reduce<LadderResult>((result, [key, rawDecision]) => {
    const target = targetsByKey.get(key);
    if (target === undefined) {
      return result;
    }
    const decision: AmbiguousInterpretation = input.provisionalOnlyRawFindingIds.has(target.canonical.rawFindingId)
      && rawDecision.decision !== 'provisional'
      ? {
        decision: 'provisional',
        rawFindingId: rawDecision.rawFindingId,
        reason: `Interpretation "${rawDecision.decision}" is not allowed for an unverified persists/reopened claim; restricted to a gate-blocking provisional so it cannot mutate an existing finding`,
      }
      : rawDecision;
    if (decision.decision === 'create_independent') {
      const pendingIndependent = target.interpretationRecoveryAttempt === true
        ? {
            wire: target.wire,
            canonical: target.canonical,
            viaInterpretationKey: key,
            interpretationRecoveryAttempt: true as const,
            recoveryOrigins: target.recoveryOrigins,
          }
        : {
            wire: target.wire,
            canonical: target.canonical,
            viaInterpretationKey: key,
          };
      return {
        ...result,
        pendingIndependentNew: [...result.pendingIndependentNew, pendingIndependent],
      };
    }
    if (decision.decision === 'open_conflict') {
      return {
        ...result,
        pendingConflicts: [...result.pendingConflicts, {
          target,
          targetFindingId: decision.targetFindingId,
          viaInterpretationKey: key,
        }],
      };
    }
    if (decision.decision === 'same_with_proof') {
      const proof = input.proofsByRawId.get(decision.rawFindingId);
      if (proof !== undefined && proof.proofId === decision.proofId) {
        return {
          ...result,
          pendingSameWithProof: [...result.pendingSameWithProof, { target, proof, viaInterpretationKey: key }],
        };
      }
    }
    const spec = provisionalSpecForRaw({
      wire: target.wire,
      canonical: target.canonical,
      reason: decision.decision === 'same_with_proof'
        ? 'Stored same_with_proof decision no longer matches an engine-issued proof; kept provisional'
        : decision.reason,
    });
    return {
      ...result,
      provisionalSpecs: [...result.provisionalSpecs, spec],
      provisionalByInterpretationKey: new Map([...result.provisionalByInterpretationKey, [key, spec]]),
      recoveryProvisionalOrigins: target.recoveryOrigins === undefined
        ? result.recoveryProvisionalOrigins
        : new Map([...result.recoveryProvisionalOrigins, [key, target.recoveryOrigins]]),
    };
  }, input.result);
}
