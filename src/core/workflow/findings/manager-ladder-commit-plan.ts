import type { ProvisionalFindingSpec } from './reconciler.js';
import { verifySameProofAgainstLedger } from './raw-capabilities.js';
import { createEmptyManagerOutput } from './manager-output.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  InterpretationApplicationResult,
} from './types.js';
import type { LadderResult, ManagerDecisionStageResult } from './manager-contracts.js';
import { provisionalSpecForRaw, provisionalSpecForRawKind } from './manager-provisional.js';
import { fullIdentityKeyOf } from './manager-provisional-settlement.js';

export interface LadderCommitPlan {
  output: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  interpretationResults: Map<string, InterpretationApplicationResult>;
  recoverySettlements: Map<string, string>;
  recoveryPromotions: Set<string>;
  recoveryProvisionalRawFindingIds: Set<string>;
}

function withInterpretationResult(
  current: Map<string, InterpretationApplicationResult>,
  key: string | undefined,
  result: InterpretationApplicationResult,
): Map<string, InterpretationApplicationResult> {
  return key === undefined ? current : new Map([...current, [key, result]]);
}

function recoveryOriginIsFresh(
  origin: NonNullable<ManagerDecisionStageResult['ladder']['pendingAppliedReattach'][number]['target']['recoveryOrigin']>,
  ledger: FindingLedger,
): boolean {
  const process = ledger.findings.find((finding) => finding.id === origin.provisionalFindingId);
  return process?.status === 'open'
    && process.provisional !== undefined
    && (process.revision ?? 1) === origin.expectedProvisionalRevision;
}

function ownsCompletedInterpretation(
  ladder: LadderResult,
  ledger: FindingLedger,
  interpretationKey: string,
): boolean {
  const reservationToken = ladder.interpretationReservations.get(interpretationKey);
  return reservationToken !== undefined && ledger.interpretations?.some((record) => (
    record.interpretationKey === interpretationKey
    && record.stage === 'interpretation_completed'
    && record.reservationToken === reservationToken
  )) === true;
}

export function selectCommittableLadder(
  ladder: LadderResult,
  freshLedger: FindingLedger,
): LadderResult {
  const committableKeys = new Set(
    [...ladder.interpretationReservations.keys()].filter((key) => (
      ownsCompletedInterpretation(ladder, freshLedger, key)
    )),
  );
  const excludedSpecs = new Set(
    [...ladder.provisionalByInterpretationKey]
      .filter(([key]) => !committableKeys.has(key))
      .map(([, spec]) => spec),
  );
  const canCommit = (key: string | undefined, rawFindingId: string): boolean => (
    !ladder.deferredRawFindingIds.has(rawFindingId)
    && (key === undefined || committableKeys.has(key))
  );
  return {
    ...ladder,
    pendingSameWithProof: ladder.pendingSameWithProof.filter((pending) => (
      canCommit(pending.viaInterpretationKey, pending.target.wire.rawFindingId)
    )),
    pendingIndependentNew: ladder.pendingIndependentNew.filter((pending) => (
      canCommit(pending.viaInterpretationKey, pending.wire.rawFindingId)
    )),
    pendingConflicts: ladder.pendingConflicts.filter((pending) => (
      canCommit(pending.viaInterpretationKey, pending.target.wire.rawFindingId)
    )),
    provisionalSpecs: ladder.provisionalSpecs.filter((spec) => (
      !excludedSpecs.has(spec)
      && spec.sourceRawFindingIds.every((rawFindingId) => !ladder.deferredRawFindingIds.has(rawFindingId))
    )),
    provisionalByInterpretationKey: new Map(
      [...ladder.provisionalByInterpretationKey].filter(([key]) => committableKeys.has(key)),
    ),
    recoveryProvisionalInterpretationKeys: new Set(
      [...ladder.recoveryProvisionalInterpretationKeys].filter((key) => committableKeys.has(key)),
    ),
  };
}

export function buildLadderCommitPlan(
  ladder: ManagerDecisionStageResult['ladder'],
  freshLedger: FindingLedger,
): LadderCommitPlan {
  const initialResults = new Map<string, InterpretationApplicationResult>(
    [...ladder.provisionalByInterpretationKey].map(([key, spec]) => {
      const existsOpen = ladder.recoveryProvisionalInterpretationKeys.has(key) || freshLedger.findings.some(
        (finding) => finding.status === 'open' && finding.provisional?.stableKey === spec.stableKey,
      );
      return [key, existsOpen ? 'provisional_updated' : 'provisional_created'];
    }),
  );
  const initial: LadderCommitPlan = {
    output: createEmptyManagerOutput(),
    provisionalSpecs: [],
    interpretationResults: initialResults,
    recoverySettlements: new Map(),
    recoveryPromotions: new Set(),
    recoveryProvisionalRawFindingIds: new Set(
      [...ladder.provisionalByInterpretationKey].flatMap(([key, spec]) => (
        ladder.recoveryProvisionalInterpretationKeys.has(key) ? spec.sourceRawFindingIds : []
      )),
    ),
  };
  const withMatches = ladder.pendingSameWithProof.reduce<LadderCommitPlan>((plan, pending) => {
    if (pending.target.recoveryOrigin !== undefined
      && !recoveryOriginIsFresh(pending.target.recoveryOrigin, freshLedger)) {
      return {
        ...plan,
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'stale_precondition',
        ),
      };
    }
    const verification = verifySameProofAgainstLedger(pending.proof, freshLedger);
    if (!verification.ok) {
      // proof 経路は解釈ラダーを通らず WAL を持たない — ambiguous のまま落とすと
      // epochs=0 が恒久化する。裁定未了として RawAdjudicationRecovery の管轄へ。
      return {
        ...plan,
        provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRawKind({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Deterministic same proof became stale before save: ${verification.reason}`,
        }, 'raw-adjudication-unresolved')],
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'stale_precondition',
        ),
      };
    }
    return {
      ...plan,
      output: {
        ...plan.output,
        matches: [...plan.output.matches, {
          findingId: pending.proof.targetFindingId,
          rawFindingIds: [pending.target.wire.rawFindingId],
          evidence: `Deterministic same proof ${pending.proof.proofId.slice(0, 12)} (exact normalized identity match)`,
        }],
      },
      interpretationResults: withInterpretationResult(
        plan.interpretationResults,
        pending.viaInterpretationKey,
        'matched_with_proof',
      ),
      ...(pending.target.recoveryOrigin !== undefined
        ? {
            recoverySettlements: new Map([
              ...plan.recoverySettlements,
              [
                pending.target.recoveryOrigin.provisionalFindingId,
                pending.proof.targetFindingId,
              ],
            ]),
          }
        : {}),
    };
  }, initial);
  const withIndependent = ladder.pendingIndependentNew.reduce<LadderCommitPlan>((plan, pending) => {
    const origin = pending.recoveryOrigin;
    if (origin !== undefined && !recoveryOriginIsFresh(origin, freshLedger)) {
      return {
        ...plan,
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'stale_precondition',
        ),
      };
    }
    return {
      ...plan,
      output: origin === undefined
        ? {
            ...plan.output,
            newFindings: [...plan.output.newFindings, {
              rawFindingIds: [pending.wire.rawFindingId],
              title: pending.wire.title,
              severity: pending.wire.severity,
            }],
          }
        : {
            ...plan.output,
            matches: [...plan.output.matches, {
              findingId: origin.provisionalFindingId,
              rawFindingIds: [pending.wire.rawFindingId],
              evidence: 'A fresh interpretation attempt confirmed the provisional as an independent finding',
            }],
          },
      interpretationResults: withInterpretationResult(
        plan.interpretationResults,
        pending.viaInterpretationKey,
        'created',
      ),
      recoveryPromotions: origin === undefined
        ? plan.recoveryPromotions
        : new Set([...plan.recoveryPromotions, origin.provisionalFindingId]),
    };
  }, withMatches);
  const withConflicts = ladder.pendingConflicts.reduce<LadderCommitPlan>((plan, pending) => {
    if (pending.target.recoveryOrigin !== undefined
      && !recoveryOriginIsFresh(pending.target.recoveryOrigin, freshLedger)) {
      return {
        ...plan,
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'stale_precondition',
        ),
      };
    }
    const target = freshLedger.findings.find((finding) => finding.id === pending.targetFindingId);
    if (target === undefined || target.status !== 'open') {
      return {
        ...plan,
        provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Conflict target "${pending.targetFindingId}" is no longer open; observation kept provisional`,
        })],
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'provisional_created',
        ),
      };
    }
    const origin = pending.target.recoveryOrigin;
    return {
      ...plan,
      output: {
        ...plan.output,
        conflicts: [...plan.output.conflicts, {
          findingIds: origin === undefined
            ? [pending.targetFindingId]
            : [pending.targetFindingId, origin.provisionalFindingId],
          rawFindingIds: [pending.target.wire.rawFindingId],
          description: `Ambiguous observation "${pending.target.wire.title}" relates to finding "${pending.targetFindingId}" but its identity could not be determined`,
        }],
      },
      provisionalSpecs: origin === undefined
        ? [...plan.provisionalSpecs, provisionalSpecForRaw({
            wire: pending.target.wire,
            canonical: pending.target.canonical,
            reason: `Held as provisional while an active conflict against finding "${pending.targetFindingId}" is adjudicated`,
          })]
        : plan.provisionalSpecs,
      interpretationResults: withInterpretationResult(
        plan.interpretationResults,
        pending.viaInterpretationKey,
        'conflict_created',
      ),
      recoveryPromotions: origin === undefined
        ? plan.recoveryPromotions
        : new Set([...plan.recoveryPromotions, origin.provisionalFindingId]),
    };
  }, withIndependent);
  const freshRawsById = new Map(freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  return ladder.pendingAppliedReattach.reduce<LadderCommitPlan>((plan, pending) => {
    const origin = pending.target.recoveryOrigin;
    if (origin !== undefined) {
      const process = freshLedger.findings.find((finding) => finding.id === origin.provisionalFindingId);
      if (process === undefined
        || process.status !== 'open'
        || process.provisional === undefined
        || (process.revision ?? 1) !== origin.expectedProvisionalRevision) {
        return plan;
      }
      if (pending.applicationResult === 'conflict_created') {
        const conflicts = freshLedger.conflicts.filter((conflict) => (
          conflict.status === 'active'
          && conflict.rawFindingIds.includes(pending.target.wire.rawFindingId)
        ));
        return conflicts.length === 1
          ? {
              ...plan,
              recoverySettlements: new Map([
                ...plan.recoverySettlements,
                [process.id, `active conflict "${conflicts[0]!.id}"`],
              ]),
            }
          : plan;
      }
    }
    const identity = fullIdentityKeyOf(
      pending.target.wire.location,
      pending.target.wire.title,
      pending.target.wire.description,
    );
    const candidates = freshLedger.findings.filter((finding) => {
      if (origin?.provisionalFindingId === finding.id) {
        return false;
      }
      if (finding.status !== 'open') {
        return false;
      }
      if (fullIdentityKeyOf(finding.location, finding.title, finding.description) === identity) {
        return true;
      }
      return finding.rawFindingIds.some((rawFindingId) => {
        const raw = freshRawsById.get(rawFindingId);
        return raw !== undefined && fullIdentityKeyOf(raw.location, raw.title, raw.description) === identity;
      });
    });
    if (candidates.length !== 1) {
      return {
        ...plan,
        provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: 'Same-evidence observation reappeared after its interpretation was applied, but its previously created finding could not be uniquely re-identified; kept provisional',
        })],
      };
    }
    if (origin !== undefined) {
      return {
        ...plan,
        recoverySettlements: new Map([
          ...plan.recoverySettlements,
          [origin.provisionalFindingId, candidates[0]!.id],
        ]),
      };
    }
    return {
      ...plan,
      output: {
        ...plan.output,
        matches: [...plan.output.matches, {
          findingId: candidates[0]!.id,
          rawFindingIds: [pending.target.wire.rawFindingId],
          evidence: 'Same-evidence observation reattached to its previously applied finding (exact identity)',
        }],
      },
    };
  }, withConflicts);
}
