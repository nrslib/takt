import type { ProvisionalFindingSpec } from './reconciler.js';
import {
  issueOpenConflictOutcomeAuthority,
  verifySameProofAgainstLedger,
  type OpenConflictOutcomeAuthority,
} from './raw-capabilities.js';
import { createEmptyManagerOutput } from './manager-output.js';
import type {
  FindingLedger,
  FindingManagerOutput,
  InterpretationApplicationResult,
} from './types.js';
import type {
  LadderResult,
  LadderTarget,
  ManagerDecisionStageResult,
} from './manager-contracts.js';
import { provisionalSpecForRaw, provisionalSpecForRawKind } from './manager-provisional.js';
import { fullIdentityKeyOf } from './manager-provisional-settlement.js';
import {
  matchesProvisionalRecoveryOrigin,
  type ProvisionalRecoveryOrigin,
} from './provisional-recovery-origin.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';
import { canonicalRawIntegrityDigestOf } from './raw-canonicalization.js';
import { createAnchorAdjudication } from '../../models/finding-anchor-relevance.js';
import type { RawFinding } from './types.js';
import { isProvisionalPromotionSource } from './provisional-promotion-eligibility.js';

export interface LadderCommitPlan {
  output: FindingManagerOutput;
  provisionalSpecs: ProvisionalFindingSpec[];
  interpretationResults: Map<string, InterpretationApplicationResult>;
  recoverySettlements: Map<string, string>;
  recoveryPromotions: Set<string>;
  recoveryProvisionalRawFindingIds: Set<string>;
  staleRecoveryRawFindingIds: Set<string>;
  openConflictOutcomeAuthorities: Map<string, OpenConflictOutcomeAuthority>;
}

function appendNonAbsenceAnchorAdjudication(input: {
  output: FindingManagerOutput;
  raw: RawFinding;
  decision: 'same' | 'new' | 'conflict';
  findingId?: string;
  evidence: string;
}): FindingManagerOutput {
  if (input.raw.target.kind === 'absence') {
    throw new Error(
      `Absence raw finding "${input.raw.rawFindingId}" cannot leave the interpretation ladder without an explicit manager anchor-relevance decision`,
    );
  }
  return {
    ...input.output,
    anchorAdjudications: [
      ...input.output.anchorAdjudications,
      createAnchorAdjudication({
        rawFindingId: input.raw.rawFindingId,
        decision: input.decision,
        anchorRelevance: 'not_applicable',
        ...(input.findingId === undefined ? {} : { findingId: input.findingId }),
        evidence: input.evidence,
      }),
    ],
  };
}

function holdAbsencePendingManagerAnchor(input: {
  plan: LadderCommitPlan;
  raw: RawFinding;
  canonical: Parameters<typeof provisionalSpecForRawKind>[0]['canonical'];
  interpretationKey?: string;
}): LadderCommitPlan {
  return {
    ...input.plan,
    provisionalSpecs: [
      ...input.plan.provisionalSpecs,
      provisionalSpecForRawKind({
        wire: input.raw,
        canonical: input.canonical,
        reason: 'Absence claims require an explicit manager judgment that the authoritative declaration establishes the claimed obligation',
      }, 'raw-adjudication-unresolved'),
    ],
    interpretationResults: withInterpretationResult(
      input.plan.interpretationResults,
      input.interpretationKey,
      'provisional_created',
    ),
  };
}

function withInterpretationResult(
  current: Map<string, InterpretationApplicationResult>,
  key: string | undefined,
  result: InterpretationApplicationResult,
): Map<string, InterpretationApplicationResult> {
  return key === undefined ? current : new Map([...current, [key, result]]);
}

function recoveryOriginIsFresh(
  origin: NonNullable<ManagerDecisionStageResult['ladder']['pendingAppliedReattach'][number]['target']['recoveryOrigins']>[number],
  ledger: FindingLedger,
): boolean {
  const process = ledger.findings.find((finding) => finding.id === origin.provisionalFindingId);
  return process !== undefined && matchesProvisionalRecoveryOrigin(process, origin);
}

function freshRecoveryOrigins(
  origins: NonNullable<ManagerDecisionStageResult['ladder']['pendingAppliedReattach'][number]['target']['recoveryOrigins']>,
  ledger: FindingLedger,
): ProvisionalRecoveryOrigin[] {
  return origins.filter((origin) => recoveryOriginIsFresh(origin, ledger));
}

function addRecoverySettlements(
  current: Map<string, string>,
  origins: readonly ProvisionalRecoveryOrigin[],
  target: string,
): Map<string, string> {
  return new Map([
    ...current,
    ...origins.map((origin) => [origin.provisionalFindingId, target] as const),
  ]);
}

function primaryRecoveryOrigin(
  origins: readonly ProvisionalRecoveryOrigin[],
) {
  const primary = origins[0];
  if (primary === undefined) {
    throw new Error('Interpretation recovery target has an empty origin set');
  }
  return primary;
}

function ownsCompletedInterpretation(
  ladder: LadderResult,
  ledger: FindingLedger,
  interpretationKey: string,
): boolean {
  const reservationToken = ladder.interpretationReservations.get(interpretationKey);
  return reservationToken !== undefined && ledger.interpretations.some((record) => (
    record.interpretationKey === interpretationKey
    && record.stage === 'interpretation_completed'
    && record.reservationToken === reservationToken
    && record.canonicalIntegrityDigest
      === ladder.interpretationIntegrityDigests.get(interpretationKey)
  )) === true;
}

function targetForInterpretation(
  ladder: LadderResult,
  interpretationKey: string,
): Pick<LadderTarget, 'wire' | 'canonical'> | undefined {
  const sameTarget = ladder.pendingSameWithProof.find((pending) => (
    pending.viaInterpretationKey === interpretationKey
  ))?.target;
  if (sameTarget !== undefined) {
    return sameTarget;
  }
  const independent = ladder.pendingIndependentNew.find((pending) => (
    pending.viaInterpretationKey === interpretationKey
  ));
  if (independent !== undefined) {
    return independent;
  }
  return ladder.pendingConflicts.find((pending) => (
    pending.viaInterpretationKey === interpretationKey
  ))?.target;
}

function verifyOpenConflictTargetPrecondition(input: {
  ledger: FindingLedger;
  interpretationKey: string;
  rawFindingId: string;
  targetFindingId: string;
  canonicalIntegrityDigest: string;
}): { ok: true } | { ok: false; reason: string } {
  const records = input.ledger.interpretations.filter((record) => (
    record.interpretationKey === input.interpretationKey
  ));
  const record = records[0];
  if (
    records.length !== 1
    || record?.stage !== 'interpretation_completed'
    || record.validatedDecision.decision !== 'open_conflict'
    || record.canonicalIntegrityDigest !== input.canonicalIntegrityDigest
    || record.validatedDecision.rawFindingId !== input.rawFindingId
    || record.validatedDecision.targetFindingId !== input.targetFindingId
  ) {
    return { ok: false, reason: 'the validated open_conflict WAL record is missing or ambiguous' };
  }
  const matching = record.promptPreconditions.filter((precondition) => (
    precondition.targetFindingId === input.targetFindingId
  ));
  const precondition = matching[0];
  if (matching.length !== 1 || precondition === undefined) {
    return { ok: false, reason: `the prompt WAL does not contain exactly one precondition for "${input.targetFindingId}"` };
  }
  if (
    precondition.targetStatus !== 'open'
    || !findingMatchesMutationPrecondition(input.ledger, precondition)
  ) {
    return { ok: false, reason: `conflict target "${input.targetFindingId}" changed after the manager prompt` };
  }
  return { ok: true };
}

export function selectCommittableLadder(
  ladder: LadderResult,
  freshLedger: FindingLedger,
): LadderResult {
  const ownedCompletedKeys = new Set(
    [...ladder.interpretationReservations].flatMap(([key, reservationToken]) => (
      freshLedger.interpretations.some((record) => (
        record.interpretationKey === key
        && record.stage === 'interpretation_completed'
        && record.reservationToken === reservationToken
      ))
        ? [key]
        : []
    )),
  );
  const committableKeys = new Set(
    [...ownedCompletedKeys].filter((key) => (
      ownsCompletedInterpretation(ladder, freshLedger, key)
    )),
  );
  const newlyStaleKeys = new Set(
    [...ownedCompletedKeys].filter((key) => !committableKeys.has(key)),
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
  const staleSpecs = [...newlyStaleKeys].flatMap((key) => {
    const existing = ladder.provisionalByInterpretationKey.get(key);
    if (existing !== undefined) {
      return [existing];
    }
    const target = targetForInterpretation(ladder, key);
    return target === undefined
      ? []
      : [provisionalSpecForRaw({
          wire: target.wire,
          canonical: target.canonical,
          reason: 'The canonical integrity digest changed before commit; the interpretation was rejected as stale',
        })];
  });
  return {
    ...ladder,
    integrityStaleInterpretationKeys: new Set([
      ...ladder.integrityStaleInterpretationKeys,
      ...newlyStaleKeys,
    ]),
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
    )).concat(staleSpecs),
    provisionalByInterpretationKey: new Map(
      [...ladder.provisionalByInterpretationKey].filter(([key]) => committableKeys.has(key)),
    ),
    recoveryProvisionalOrigins: new Map(
      [...ladder.recoveryProvisionalOrigins].filter(([key]) => committableKeys.has(key)),
    ),
  };
}

export function buildLadderCommitPlan(
  ladder: ManagerDecisionStageResult['ladder'],
  freshLedger: FindingLedger,
  staleRecoveryRawFindingIds: ReadonlySet<string>,
): LadderCommitPlan {
  const initialResults = new Map<string, InterpretationApplicationResult>(
    [
      ...[...ladder.provisionalByInterpretationKey].map(([key, spec]) => {
      const staleRecovery = ladder.recoveryProvisionalOrigins.has(key)
        && spec.sourceRawFindingIds.some((rawFindingId) => staleRecoveryRawFindingIds.has(rawFindingId));
      const existsOpen = ladder.recoveryProvisionalOrigins.has(key) || freshLedger.findings.some(
        (finding) => finding.status === 'open' && finding.provisional?.stableKey === spec.stableKey,
      );
      return [
        key,
        staleRecovery || ladder.integrityStaleInterpretationKeys.has(key)
          ? 'stale_precondition'
          : existsOpen ? 'provisional_updated' : 'provisional_created',
      ] as const;
      }),
      ...[...ladder.integrityStaleInterpretationKeys].map((key) => (
        [key, 'stale_precondition'] as const
      )),
    ],
  );
  const initial: LadderCommitPlan = {
    output: createEmptyManagerOutput(),
    provisionalSpecs: [],
    interpretationResults: initialResults,
    recoverySettlements: new Map(),
    recoveryPromotions: new Set(),
    recoveryProvisionalRawFindingIds: new Set(
      [...ladder.provisionalByInterpretationKey].flatMap(([key, spec]) => (
        ladder.recoveryProvisionalOrigins.has(key)
          ? spec.sourceRawFindingIds.filter((rawFindingId) => !staleRecoveryRawFindingIds.has(rawFindingId))
          : []
      )),
    ),
    staleRecoveryRawFindingIds: new Set(staleRecoveryRawFindingIds),
    openConflictOutcomeAuthorities: new Map(),
  };
  const withMatches = ladder.pendingSameWithProof.reduce<LadderCommitPlan>((plan, pending) => {
    if (pending.target.wire.target.kind === 'absence') {
      return holdAbsencePendingManagerAnchor({
        plan,
        raw: pending.target.wire,
        canonical: pending.target.canonical,
        interpretationKey: pending.viaInterpretationKey,
      });
    }
    const origins = pending.target.recoveryOrigins;
    const freshOrigins = origins === undefined
      ? undefined
      : freshRecoveryOrigins(origins, freshLedger);
    if (freshOrigins !== undefined && freshOrigins.length === 0) {
      return {
        ...plan,
        staleRecoveryRawFindingIds: new Set([
          ...plan.staleRecoveryRawFindingIds,
          pending.target.wire.rawFindingId,
        ]),
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
      output: appendNonAbsenceAnchorAdjudication({
        output: {
          ...plan.output,
          matches: [...plan.output.matches, {
            findingId: pending.proof.targetFindingId,
            rawFindingIds: [pending.target.wire.rawFindingId],
            evidence: `Deterministic same proof ${pending.proof.proofId.slice(0, 12)} (exact normalized identity match)`,
          }],
        },
        raw: pending.target.wire,
        decision: 'same',
        findingId: pending.proof.targetFindingId,
        evidence: `Deterministic same proof ${pending.proof.proofId.slice(0, 12)} (exact normalized identity match)`,
      }),
      interpretationResults: withInterpretationResult(
        plan.interpretationResults,
        pending.viaInterpretationKey,
        'matched_with_proof',
      ),
      ...(freshOrigins !== undefined
        ? {
            recoverySettlements: addRecoverySettlements(
              plan.recoverySettlements,
              freshOrigins,
              pending.proof.targetFindingId,
            ),
          }
        : {}),
    };
  }, initial);
  const withIndependent = ladder.pendingIndependentNew.reduce<LadderCommitPlan>((plan, pending) => {
    if (pending.wire.target.kind === 'absence') {
      return holdAbsencePendingManagerAnchor({
        plan,
        raw: pending.wire,
        canonical: pending.canonical,
        interpretationKey: pending.viaInterpretationKey,
      });
    }
    if (
      pending.wire.severity === null
      || pending.wire.title === null
      || pending.wire.description === null
    ) {
      throw new Error(`Independent raw finding "${pending.wire.rawFindingId}" has an incomplete claim payload`);
    }
    const origins = pending.recoveryOrigins;
    const freshOrigins = origins === undefined
      ? undefined
      : freshRecoveryOrigins(origins, freshLedger);
    if (freshOrigins !== undefined && freshOrigins.length === 0) {
      return {
        ...plan,
        staleRecoveryRawFindingIds: new Set([
          ...plan.staleRecoveryRawFindingIds,
          pending.wire.rawFindingId,
        ]),
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'stale_precondition',
        ),
      };
    }
    const promotionOrigins = freshOrigins?.filter((origin) => {
      const process = freshLedger.findings.find(
        (finding) => finding.id === origin.provisionalFindingId,
      );
      return process !== undefined && isProvisionalPromotionSource({
        ledger: freshLedger,
        provisional: process,
        wire: pending.wire,
      });
    });
    const recovery = promotionOrigins === undefined || promotionOrigins.length === 0
      ? undefined
      : primaryRecoveryOrigin(promotionOrigins);
    return {
      ...plan,
      output: appendNonAbsenceAnchorAdjudication({
        output: recovery === undefined
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
                findingId: recovery.provisionalFindingId,
                rawFindingIds: [pending.wire.rawFindingId],
                evidence: 'A fresh interpretation attempt confirmed the provisional as an independent finding',
              }],
            },
        raw: pending.wire,
        decision: recovery === undefined ? 'new' : 'same',
        ...(recovery === undefined
          ? {}
          : { findingId: recovery.provisionalFindingId }),
        evidence: recovery === undefined
          ? 'Manager interpretation confirmed an independent finding'
          : 'A fresh interpretation attempt confirmed the provisional as an independent finding',
      }),
      interpretationResults: withInterpretationResult(
        plan.interpretationResults,
        pending.viaInterpretationKey,
        'created',
      ),
      recoveryPromotions: recovery === undefined
        ? plan.recoveryPromotions
        : new Set([...plan.recoveryPromotions, recovery.provisionalFindingId]),
    };
  }, withMatches);
  const withConflicts = ladder.pendingConflicts.reduce<LadderCommitPlan>((plan, pending) => {
    if (pending.target.wire.target.kind === 'absence') {
      return holdAbsencePendingManagerAnchor({
        plan,
        raw: pending.target.wire,
        canonical: pending.target.canonical,
        interpretationKey: pending.viaInterpretationKey,
      });
    }
    const recoveryOrigins = pending.target.recoveryOrigins;
    const freshOrigins = recoveryOrigins === undefined
      ? undefined
      : freshRecoveryOrigins(recoveryOrigins, freshLedger);
    if (freshOrigins !== undefined && freshOrigins.length === 0) {
      return {
        ...plan,
        staleRecoveryRawFindingIds: new Set([
          ...plan.staleRecoveryRawFindingIds,
          pending.target.wire.rawFindingId,
        ]),
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'stale_precondition',
        ),
      };
    }
    const targetPrecondition = verifyOpenConflictTargetPrecondition({
      ledger: freshLedger,
      interpretationKey: pending.viaInterpretationKey,
      rawFindingId: pending.target.wire.rawFindingId,
      targetFindingId: pending.targetFindingId,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(pending.target.canonical),
    });
    if (!targetPrecondition.ok) {
      return {
        ...plan,
        provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Open-conflict decision became stale before save: ${targetPrecondition.reason}`,
        })],
        interpretationResults: withInterpretationResult(
          plan.interpretationResults,
          pending.viaInterpretationKey,
          'stale_precondition',
        ),
      };
    }
    const origins = freshOrigins;
    const provisionalSpec = origins === undefined
      ? provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: `Held as provisional while an active conflict against finding "${pending.targetFindingId}" is adjudicated`,
        })
      : undefined;
    const conflict = {
      findingIds: origins === undefined
        ? [pending.targetFindingId]
        : [
            pending.targetFindingId,
            ...origins.map((origin) => origin.provisionalFindingId),
          ],
      rawFindingIds: [pending.target.wire.rawFindingId],
      description: `Ambiguous observation "${pending.target.wire.title}" relates to finding "${pending.targetFindingId}" but its identity could not be determined`,
    };
    const authority = provisionalSpec === undefined
      ? undefined
      : issueOpenConflictOutcomeAuthority({
          canonical: pending.target.canonical,
          ledger: freshLedger,
          interpretationKey: pending.viaInterpretationKey,
          conflict,
          provisionalSpec,
        });
    return {
      ...plan,
      output: appendNonAbsenceAnchorAdjudication({
        output: {
          ...plan.output,
          conflicts: [...plan.output.conflicts, conflict],
        },
        raw: pending.target.wire,
        decision: 'conflict',
        findingId: pending.targetFindingId,
        evidence: conflict.description,
      }),
      provisionalSpecs: provisionalSpec === undefined
        ? plan.provisionalSpecs
        : [...plan.provisionalSpecs, provisionalSpec],
      openConflictOutcomeAuthorities: authority === undefined
        ? plan.openConflictOutcomeAuthorities
        : new Map([
            ...plan.openConflictOutcomeAuthorities,
            [pending.target.wire.rawFindingId, authority],
          ]),
      interpretationResults: withInterpretationResult(
        plan.interpretationResults,
        pending.viaInterpretationKey,
        'conflict_created',
      ),
      recoveryPromotions: plan.recoveryPromotions,
    };
  }, withIndependent);
  const freshRawsById = new Map(freshLedger.rawFindings.map((raw) => [raw.rawFindingId, raw]));
  return ladder.pendingAppliedReattach.reduce<LadderCommitPlan>((plan, pending) => {
    if (pending.target.wire.target.kind === 'absence') {
      return holdAbsencePendingManagerAnchor({
        plan,
        raw: pending.target.wire,
        canonical: pending.target.canonical,
      });
    }
    const recoveryOrigins = pending.target.recoveryOrigins;
    const origins = recoveryOrigins === undefined
      ? undefined
      : freshRecoveryOrigins(recoveryOrigins, freshLedger);
    if (origins !== undefined) {
      if (origins.length === 0) {
        return {
          ...plan,
          staleRecoveryRawFindingIds: new Set([
            ...plan.staleRecoveryRawFindingIds,
            pending.target.wire.rawFindingId,
          ]),
        };
      }
      if (pending.applicationResult === 'conflict_created') {
        const conflicts = freshLedger.conflicts.filter((conflict) => (
          conflict.status === 'active'
          && conflict.rawFindingIds.includes(pending.target.wire.rawFindingId)
        ));
        return conflicts.length === 1
          ? {
              ...plan,
              recoverySettlements: addRecoverySettlements(
                plan.recoverySettlements,
                origins,
                `active conflict "${conflicts[0]!.id}"`,
              ),
            }
          : plan;
      }
    }
    const identity = fullIdentityKeyOf(pending.target.wire);
    if (identity === undefined) {
      return {
        ...plan,
        provisionalSpecs: [...plan.provisionalSpecs, provisionalSpecForRaw({
          wire: pending.target.wire,
          canonical: pending.target.canonical,
          reason: 'The candidate has no claim identity and cannot be re-identified as a product finding',
        })],
      };
    }
    const candidates = freshLedger.findings.filter((finding) => {
      if (origins?.some((origin) => origin.provisionalFindingId === finding.id) === true) {
        return false;
      }
      if (finding.status !== 'open') {
        return false;
      }
      if (fullIdentityKeyOf(finding) === identity) {
        return true;
      }
      return finding.rawFindingIds.some((rawFindingId) => {
        const raw = freshRawsById.get(rawFindingId);
        return raw !== undefined && fullIdentityKeyOf(raw) === identity;
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
    if (origins !== undefined) {
      return {
        ...plan,
        recoverySettlements: addRecoverySettlements(
          plan.recoverySettlements,
          origins,
          candidates[0]!.id,
        ),
      };
    }
    return {
      ...plan,
      output: appendNonAbsenceAnchorAdjudication({
        output: {
          ...plan.output,
          matches: [...plan.output.matches, {
            findingId: candidates[0]!.id,
            rawFindingIds: [pending.target.wire.rawFindingId],
            evidence: 'Same-evidence observation reattached to its previously applied finding (exact identity)',
          }],
        },
        raw: pending.target.wire,
        decision: 'same',
        findingId: candidates[0]!.id,
        evidence: 'Same-evidence observation reattached to its previously applied finding (exact identity)',
      }),
    };
  }, withConflicts);
}
