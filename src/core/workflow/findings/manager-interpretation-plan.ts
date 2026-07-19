import type { ProvisionalFindingSpec } from './reconciler.js';
import {
  computeInterpretationKey,
  computeProvisionalStableKey,
  detectRawFindingAmbiguities,
} from './raw-canonicalization.js';
import { MANAGER_INTERPRETATION_LIMITS } from './raw-finding-limits.js';
import { issueDeterministicSameProofs } from './raw-capabilities.js';
import { countInterpretationEpochs } from './interpretation-wal.js';
import type {
  AmbiguousInterpretation,
  DeterministicSameProof,
  FindingLedger,
} from './types.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import { provisionalSpecForRaw } from './manager-provisional.js';
import type { LadderResult, LadderTarget } from './manager-contracts.js';
import type { beginInterpretations } from './interpretation-wal.js';

export function emptyLadderResult(ambiguousRawCount: number): LadderResult {
  return {
    pendingSameWithProof: [],
    pendingIndependentNew: [],
    pendingConflicts: [],
    provisionalSpecs: [],
    provisionalByInterpretationKey: new Map(),
    pendingAppliedReattach: [],
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
  });
  const proofsByRawId = new Map(
    [...issuedProofs].filter(([rawFindingId]) => !input.provisionalOnlyRawFindingIds.has(rawFindingId)),
  );
  const classified = input.tainted.reduce<Omit<InitialLadderPlan, 'proofsByRawId'>>((plan, item) => {
    const target: LadderTarget = {
      canonical: item.canonical,
      wire: item.wire,
      interpretationKey: computeInterpretationKey({
        reviewerStableKey: item.canonical.reviewerStableKey,
        lineageKey: item.canonical.lineageKey,
        candidateEvidenceHash: item.canonical.evidenceHash,
      }),
    };
    const proof = proofsByRawId.get(item.canonical.rawFindingId);
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
        return {
          ...plan,
          result: {
            ...plan.result,
            pendingIndependentNew: [...plan.result.pendingIndependentNew, { wire: item.wire }],
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
    if (input.begin.appliedByKey.has(key)) {
      const priorResult = input.begin.appliedByKey.get(key);
      if ((priorResult === 'created' || priorResult === 'matched_with_proof')
        && !input.provisionalOnlyRawFindingIds.has(target.canonical.rawFindingId)) {
        return {
          ...plan,
          result: {
            ...plan.result,
            pendingAppliedReattach: [...plan.result.pendingAppliedReattach, { target }],
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
    if (!input.begin.interruptedKeys.has(key)) {
      return { ...plan, toCall: [...plan.toCall, target] };
    }
    const spec: ProvisionalFindingSpec = {
      ...provisionalSpecForRaw({
        wire: target.wire,
        canonical: target.canonical,
        reason: 'Interpretation was interrupted before the manager decision was recorded; kept provisional without re-interpreting',
      }),
      kind: 'interpretation-interrupted',
      stableKey: computeProvisionalStableKey({
        reviewerStableKey: target.canonical.reviewerStableKey,
        lineageKey: target.canonical.lineageKey,
        provisionalKind: 'interpretation-interrupted',
      }),
    };
    return {
      ...plan,
      result: {
        ...plan.result,
        provisionalSpecs: [...plan.result.provisionalSpecs, spec],
        provisionalByInterpretationKey: new Map([
          ...plan.result.provisionalByInterpretationKey,
          [key, spec],
        ]),
        stats: {
          ...plan.result.stats,
          interruptedInterpretations: plan.result.stats.interruptedInterpretations + 1,
        },
      },
    };
  }, { result: input.result, decidedByKey: new Map(), toCall: [] });
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
        reason: `Interpretation "${rawDecision.decision}" is not allowed for an unverified persists/reopened claim (no matching source_quote); restricted to a gate-blocking provisional so it cannot mutate an existing finding`,
      }
      : rawDecision;
    if (decision.decision === 'create_independent') {
      return {
        ...result,
        pendingIndependentNew: [...result.pendingIndependentNew, { wire: target.wire, viaInterpretationKey: key }],
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
    };
  }, input.result);
}
