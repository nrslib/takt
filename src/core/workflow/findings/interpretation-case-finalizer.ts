import { compareBinaryStrings } from '../../../shared/utils/binary-string-comparator.js';
import { canonicalJson } from '../../../shared/utils/canonical-json.js';
import { computeInterpretationCohortId } from '../../models/finding-interpretation-identity.js';
import {
  computeConflictHoldingAllocationId,
  computeConflictHoldingStableKey,
  computeConflictRawClaimLandingId,
  computeConflictRawClaimSnapshotDigest,
  computeInterpretationCaseSnapshotId,
  computeInterpretationObservationDigest,
  computeInterpretationOriginSnapshotSetDigest,
} from '../../models/finding-contract-identity.js';
import { formatConflictId } from '../../models/finding-conflict-identity.js';
import type {
  ConflictRawClaimLanding,
  InterpretationAttemptApplication,
} from '../../models/finding-contract-types.js';
import type { CanonicalIntakeItem } from './manager-admission.js';
import { createEmptyManagerOutput } from './manager-output.js';
import {
  createInterpretationCases,
  validateInterpretationCaseDecision,
} from './interpretation-case-model.js';
import {
  selectInterpretationCaseProofFastPath,
  type InterpretationCaseDirectPlan,
  type InterpretationCaseProofFastPathPlan,
} from './interpretation-case-coordinator.js';
import {
  canonicalRawIntegrityDigestOf,
  computeProvisionalStableKey,
} from './raw-canonicalization.js';
import { findingMatchesMutationPrecondition } from './finding-preconditions.js';
import {
  resolveInterpretationCommit,
  type InterpretationCommitResolution,
} from './interpretation-commit-resolution.js';
import {
  createInterpretationOriginBindings,
  createInterpretationOriginSettlement,
  originSnapshotDigestsByRawFindingId,
} from './interpretation-origin-binding.js';
import { planInterpretationOriginAttachments } from './interpretation-origin-attachment.js';
import {
  appendRawFindingsWithCanonicalSnapshots,
} from './raw-canonical-snapshot.js';
import { captureFindingLifecycleHead } from './lifecycle-mutation.js';
import type { ProvisionalFindingSpec } from './reconciler.js';
import type {
  DeterministicSameProof,
  FindingLedger,
  FindingManagerOutput,
  FindingObservation,
  InterpretationAttempt,
  InterpretationCase,
  InterpretationDecision,
  InterpretationPolicyClass,
  RawInterpretationOutcome,
} from './types.js';

export type PreparedInterpretationCaseAction =
  | {
      kind: 'create_independent';
      newFinding: FindingManagerOutput['newFindings'][number];
    }
  | {
      kind: 'match_with_proof';
      match: FindingManagerOutput['matches'][number];
      targetFindingId: string;
      proofs: DeterministicSameProof[];
    }
  | {
      kind: 'open_conflict';
      conflict: FindingManagerOutput['conflicts'][number];
      provisionalFinding: ProvisionalFindingSpec;
    }
  | {
      kind: 'provisional';
      provisionalFindings: ProvisionalFindingSpec[];
    };

export interface PreparedInterpretationCase {
  caseId: string;
  lineageKey: string;
  semanticProjectionDigest: string;
  rawFindingIds: string[];
  attemptId: string | null;
  decision: InterpretationDecision | { kind: 'same_with_proof' };
  action: PreparedInterpretationCaseAction;
  commitResolution?: InterpretationCommitResolution;
  directSnapshot?: {
    roundIdentity: string;
    policyClass: InterpretationPolicyClass;
  };
  directItems?: CanonicalIntakeItem[];
  invalidRawFindingIds?: string[];
}

export interface PreparedInterpretationCasePlan {
  cases: PreparedInterpretationCase[];
  managerOutput: FindingManagerOutput;
  provisionalFindings: ProvisionalFindingSpec[];
}

interface CurrentCaseResolution {
  items: CanonicalIntakeItem[];
  plannedCase: InterpretationCase | null;
  driftReason: string | null;
}

type ExpectedInterpretationCase = Pick<
  InterpretationCase,
  'caseId' | 'lineageKey' | 'semanticProjectionDigest' | 'members'
>;

interface CompletedAttemptCoverage {
  attempt: Extract<InterpretationAttempt, { stage: 'completed' }>;
  items: CanonicalIntakeItem[];
  expected: ExpectedInterpretationCase;
}

function sortedRawFindingIds(items: readonly CanonicalIntakeItem[]): string[] {
  return items
    .map((item) => item.canonical.rawFindingId)
    .sort(compareBinaryStrings);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...left].sort(compareBinaryStrings))
    === canonicalJson([...right].sort(compareBinaryStrings));
}

function itemsForRawFindingIds(
  itemsByRawFindingId: ReadonlyMap<string, CanonicalIntakeItem>,
  rawFindingIds: readonly string[],
): CanonicalIntakeItem[] {
  return rawFindingIds.map((rawFindingId) => {
    const item = itemsByRawFindingId.get(rawFindingId);
    if (item === undefined) {
      throw new Error(`Interpretation finalization is missing canonical member "${rawFindingId}"`);
    }
    return item;
  });
}

function completedAttemptCoverage(input: {
  ledger: FindingLedger;
  attempt: InterpretationAttempt;
  itemsByRawFindingId: ReadonlyMap<string, CanonicalIntakeItem>;
}): CompletedAttemptCoverage {
  if (input.attempt.stage !== 'completed') {
    throw new Error(`Interpretation attempt "${input.attempt.attemptId}" must be completed before preparation`);
  }
  const items = itemsForRawFindingIds(input.itemsByRawFindingId, input.attempt.rawFindingIds);
  const expectedCohortId = computeInterpretationCohortId(
    input.attempt.caseId,
    input.attempt.semanticProjectionDigest,
    input.attempt.rawFindingIds,
  );
  if (input.attempt.cohortId !== expectedCohortId) {
    throw new Error(`Completed interpretation attempt "${input.attempt.attemptId}" has drifted cohort identity`);
  }
  const observations = input.attempt.rawFindingIds.map((rawFindingId) => {
    const matches = input.ledger.interpretationRawObservations.filter(
      (observation) => observation.rawFindingId === rawFindingId,
    );
    if (matches.length !== 1) {
      throw new Error(`Completed interpretation attempt "${input.attempt.attemptId}" requires exactly one observation for "${rawFindingId}"`);
    }
    return matches[0]!;
  });
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index]!;
    const item = items[index]!;
    if (
      observation.caseId !== input.attempt.caseId
      || observation.cohortId !== input.attempt.cohortId
      || observation.lineageKey !== input.attempt.lineageKey
      || observation.semanticProjectionDigest !== input.attempt.semanticProjectionDigest
      || input.ledger.rawCanonicalSnapshots.find(
        (snapshot) => snapshot.rawCanonicalSnapshotId === observation.rawCanonicalSnapshotId,
      )?.canonicalIntegrityDigest !== canonicalRawIntegrityDigestOf(item.canonical)
    ) {
      throw new Error(`Completed interpretation attempt "${input.attempt.attemptId}" observation drifted for "${observation.rawFindingId}"`);
    }
  }
  return {
    attempt: input.attempt,
    items,
    expected: {
      caseId: input.attempt.caseId,
      lineageKey: input.attempt.lineageKey,
      semanticProjectionDigest: input.attempt.semanticProjectionDigest,
      members: observations.map((observation) => ({
        rawFindingId: observation.rawFindingId,
        canonicalIntegrityDigest: input.ledger.rawCanonicalSnapshots.find(
          (snapshot) => snapshot.rawCanonicalSnapshotId === observation.rawCanonicalSnapshotId,
        )!.canonicalIntegrityDigest,
      })),
    },
  };
}

function isTerminalInterpretationOutcome(
  outcome: RawInterpretationOutcome | undefined,
): boolean {
  return outcome !== undefined
    && outcome.kind !== 'pending_attempt';
}

function assertExactPreparationCoverage(input: {
  ledger: FindingLedger;
  itemRawFindingIds: ReadonlySet<string>;
  completedAttempts: readonly InterpretationAttempt[];
  directPlans: readonly InterpretationCaseDirectPlan[];
  proofFastPathPlans: readonly InterpretationCaseProofFastPathPlan[];
}): void {
  const ownersByRawFindingId = new Map<string, Array<{
    kind: 'completed_attempt' | 'direct_plan' | 'proof_plan';
    id: string;
  }>>();
  const addOwner = (
    rawFindingId: string,
    owner: { kind: 'completed_attempt' | 'direct_plan' | 'proof_plan'; id: string },
  ): void => {
    if (!input.itemRawFindingIds.has(rawFindingId)) {
      throw new Error(`Interpretation preparation plan "${owner.id}" owns unexpected raw finding "${rawFindingId}"`);
    }
    ownersByRawFindingId.set(rawFindingId, [
      ...(ownersByRawFindingId.get(rawFindingId) ?? []),
      owner,
    ]);
  };
  for (const attempt of input.completedAttempts) {
    for (const rawFindingId of attempt.rawFindingIds) {
      addOwner(rawFindingId, { kind: 'completed_attempt', id: attempt.attemptId });
    }
  }
  for (const plan of input.directPlans) {
    for (const member of plan.plannedCase.members) {
      addOwner(member.rawFindingId, { kind: 'direct_plan', id: plan.plannedCase.caseId });
    }
  }
  for (const plan of input.proofFastPathPlans) {
    for (const item of plan.items) {
      addOwner(item.canonical.rawFindingId, { kind: 'proof_plan', id: plan.caseId });
    }
  }
  for (const rawFindingId of input.itemRawFindingIds) {
    const outcome = input.ledger.rawInterpretationOutcomes.find(
      (candidate) => candidate.rawFindingId === rawFindingId,
    );
    const owners = ownersByRawFindingId.get(rawFindingId) ?? [];
    if (isTerminalInterpretationOutcome(outcome)) {
      if (owners.length !== 0) {
        throw new Error(`Terminal interpretation raw finding "${rawFindingId}" must not be prepared again`);
      }
      continue;
    }
    if (owners.length !== 1) {
      throw new Error(`Interpretation raw finding "${rawFindingId}" requires exact-one preparation owner; found ${owners.length}`);
    }
    if (outcome?.kind === 'pending_attempt') {
      const owner = owners[0]!;
      if (owner.kind !== 'completed_attempt' || owner.id !== outcome.attemptId) {
        throw new Error(`Pending interpretation raw finding "${rawFindingId}" is not owned by its completed attempt`);
      }
    }
  }
}

function resolveCurrentCase(input: {
  ledger: FindingLedger;
  items: CanonicalIntakeItem[];
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
  expected: ExpectedInterpretationCase;
}): CurrentCaseResolution {
  const cases = createInterpretationCases({
    items: input.items,
    ledger: input.ledger,
    provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
  });
  if (cases.length !== 1) {
    return {
      items: input.items,
      plannedCase: null,
      driftReason: 'Interpretation case membership changed before finalization',
    };
  }
  const plannedCase = cases[0]!;
  const memberDigestsMatch = plannedCase.members.every((member) => {
    const expectedMember = input.expected.members.find(
      (candidate) => candidate.rawFindingId === member.rawFindingId,
    );
    return expectedMember?.canonicalIntegrityDigest === member.canonicalIntegrityDigest;
  });
  const compatible = plannedCase.caseId === input.expected.caseId
    && plannedCase.lineageKey === input.expected.lineageKey
    && plannedCase.semanticProjectionDigest === input.expected.semanticProjectionDigest
    && sameStringSet(
      plannedCase.members.map((member) => member.rawFindingId),
      input.expected.members.map((member) => member.rawFindingId),
    )
    && memberDigestsMatch;
  return {
    items: input.items,
    plannedCase,
    driftReason: compatible
      ? null
      : 'Interpretation case identity or semantics changed before finalization',
  };
}

function provisionalSpec(input: {
  caseId: string;
  lineageKey: string;
  items: readonly CanonicalIntakeItem[];
  reason: string;
  stableKey?: string;
  kind?: ProvisionalFindingSpec['kind'];
}): ProvisionalFindingSpec {
  const first = input.items[0];
  if (first === undefined) {
    throw new Error(`Interpretation case "${input.caseId}" has no canonical members`);
  }
  const canonical = first.canonical;
  const kind = input.kind ?? 'raw-meaning-ambiguous';
  return {
    kind,
    stableKey: input.stableKey ?? computeProvisionalStableKey({
      reviewerStableKey: canonical.reviewerStableKey,
      lineageKey: input.lineageKey,
      provisionalKind: kind,
    }),
    lineageKey: input.lineageKey,
    sourceRawFindingIds: sortedRawFindingIds(input.items),
    reason: input.reason,
    title: canonical.title ?? null,
    severity: canonical.severity ?? null,
    ...(canonical.description === undefined ? {} : { description: canonical.description }),
    ...(canonical.suggestion === undefined ? {} : { suggestion: canonical.suggestion }),
    reviewers: [...new Set(input.items.map((item) => item.canonical.reviewer))]
      .sort(compareBinaryStrings),
    target: structuredClone(canonical.target),
    targetIdentityHash: canonical.targetIdentityHash,
    claimIdentityHash: canonical.claimIdentityHash,
    semanticClaimIdentityHash: canonical.semanticClaimIdentityHash,
    recoveryReviewerStableKey: canonical.reviewerStableKey,
  };
}

function provisionalPreparedCase(input: {
  expected: Pick<InterpretationCase, 'caseId' | 'lineageKey' | 'semanticProjectionDigest'>;
  items: CanonicalIntakeItem[];
  attemptId: string | null;
  decision: InterpretationDecision | { kind: 'same_with_proof' };
  reason: string;
}): PreparedInterpretationCase {
  const spec = provisionalSpec({
    caseId: input.expected.caseId,
    lineageKey: input.expected.lineageKey,
    items: input.items,
    reason: input.reason,
  });
  return {
    caseId: input.expected.caseId,
    lineageKey: input.expected.lineageKey,
    semanticProjectionDigest: input.expected.semanticProjectionDigest,
    rawFindingIds: spec.sourceRawFindingIds,
    attemptId: input.attemptId,
    decision: input.decision,
    action: { kind: 'provisional', provisionalFindings: [spec] },
  };
}

function prepareDecisionCase(input: {
  ledger: FindingLedger;
  resolution: CurrentCaseResolution;
  expected: Pick<InterpretationCase, 'caseId' | 'lineageKey' | 'semanticProjectionDigest'>;
  attemptId: string | null;
  decision: InterpretationDecision;
}): PreparedInterpretationCase {
  const base = {
    caseId: input.expected.caseId,
    lineageKey: input.expected.lineageKey,
    semanticProjectionDigest: input.expected.semanticProjectionDigest,
    rawFindingIds: sortedRawFindingIds(input.resolution.items),
    attemptId: input.attemptId,
    decision: input.decision,
  };
  if (input.resolution.driftReason !== null || input.resolution.plannedCase === null) {
    return provisionalPreparedCase({
      expected: input.expected,
      items: input.resolution.items,
      attemptId: input.attemptId,
      decision: input.decision,
      reason: input.resolution.driftReason ?? 'Interpretation case is unavailable',
    });
  }
  const validated = validateInterpretationCaseDecision({
    plannedCase: input.resolution.plannedCase,
    decision: input.decision,
    ledger: input.ledger,
  });
  if (validated.kind === 'provisional') {
    return provisionalPreparedCase({
      expected: input.expected,
      items: input.resolution.items,
      attemptId: input.attemptId,
      decision: input.decision,
      reason: validated.reason,
    });
  }
  if (input.resolution.items.some((item) => item.wire.target.kind === 'absence')) {
    return provisionalPreparedCase({
      expected: input.expected,
      items: input.resolution.items,
      attemptId: input.attemptId,
      decision: input.decision,
      reason: 'Absence claims require an explicit manager anchor-relevance adjudication',
    });
  }
  if (validated.kind === 'create_independent') {
    const claim = input.resolution.plannedCase.decisionContext?.claim;
    if (claim?.title === null || claim?.title === undefined || claim.severity === null) {
      return provisionalPreparedCase({
        expected: input.expected,
        items: input.resolution.items,
        attemptId: input.attemptId,
        decision: input.decision,
        reason: 'Independent finding creation requires complete product identity',
      });
    }
    return {
      ...base,
      action: {
        kind: 'create_independent',
        newFinding: {
          rawFindingIds: base.rawFindingIds,
          title: claim.title,
          severity: claim.severity,
        },
      },
    };
  }
  const conflictPreconditionsAreFresh = input.resolution.items.every((item) => (
    item.canonical.targetPrecondition?.targetFindingId === validated.targetFindingId
    && findingMatchesMutationPrecondition(
      input.ledger,
      item.canonical.targetPrecondition,
    )
  ));
  if (!conflictPreconditionsAreFresh) {
    return provisionalPreparedCase({
      expected: input.expected,
      items: input.resolution.items,
      attemptId: input.attemptId,
      decision: input.decision,
      reason: 'Conflict target changed after interpretation completion',
    });
  }
  const conflict = {
    findingIds: [validated.targetFindingId],
    rawFindingIds: base.rawFindingIds,
    description: `Interpretation case conflicts with finding "${validated.targetFindingId}".`,
  };
  const conflictId = formatConflictId(conflict);
  const rawClaimLandingIds = base.rawFindingIds.map((rawFindingId) => {
    const snapshot = exactlyOne(
      input.ledger.rawCanonicalSnapshots.filter(
        (candidate) => candidate.rawFindingId === rawFindingId,
      ),
      `raw canonical snapshot for conflict member "${rawFindingId}"`,
    );
    return computeConflictRawClaimLandingId({
      conflictId,
      rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      rawPayloadDigest: snapshot.rawPayloadDigest,
      claimSnapshotDigest: computeConflictRawClaimSnapshotDigest(snapshot),
    });
  });
  const holdingAllocationId = computeConflictHoldingAllocationId(
    conflictId,
    rawClaimLandingIds,
  );
  return {
    ...base,
    action: {
      kind: 'open_conflict',
      conflict,
      provisionalFinding: provisionalSpec({
        caseId: input.expected.caseId,
        lineageKey: input.expected.lineageKey,
        items: input.resolution.items,
        reason: conflict.description,
        kind: 'raw-adjudication-unresolved',
        stableKey: computeConflictHoldingStableKey({
          conflictId,
          holdingAllocationId,
          provisionalKind: 'raw-adjudication-unresolved',
        }),
      }),
    },
  };
}

function prepareSameProofCase(input: {
  ledger: FindingLedger;
  resolution: CurrentCaseResolution;
  expected: InterpretationCaseProofFastPathPlan;
}): PreparedInterpretationCase {
  const decision = { kind: 'same_with_proof' as const };
  if (input.resolution.items.some((item) => item.wire.target.kind === 'absence')) {
    return provisionalPreparedCase({
      expected: input.expected,
      items: input.resolution.items,
      attemptId: null,
      decision,
      reason: 'Absence claims require an explicit manager anchor-relevance adjudication',
    });
  }
  if (input.resolution.driftReason !== null || input.resolution.plannedCase === null) {
    return provisionalPreparedCase({
      expected: input.expected,
      items: input.resolution.items,
      attemptId: null,
      decision,
      reason: input.resolution.driftReason ?? 'SameProof case is unavailable',
    });
  }
  const fresh = selectInterpretationCaseProofFastPath({
    plannedCase: input.resolution.plannedCase,
    ledger: input.ledger,
  });
  if (
    fresh === null
    || fresh.targetFindingId !== input.expected.targetFindingId
    || fresh.targetRevision !== input.expected.targetRevision
  ) {
    return provisionalPreparedCase({
      expected: input.expected,
      items: input.resolution.items,
      attemptId: null,
      decision,
      reason: 'SameProof is stale, ambiguous, or no longer uniquely targets one product finding',
    });
  }
  const rawFindingIds = sortedRawFindingIds(input.resolution.items);
  return {
    caseId: input.expected.caseId,
    lineageKey: input.expected.lineageKey,
    semanticProjectionDigest: input.expected.semanticProjectionDigest,
    rawFindingIds,
    attemptId: null,
    decision,
    action: {
      kind: 'match_with_proof',
      match: {
        findingId: fresh.targetFindingId,
        rawFindingIds,
        evidence: `Engine-issued SameProof ${fresh.proofs.map((proof) => proof.proofId).join(', ')}`,
      },
      targetFindingId: fresh.targetFindingId,
      proofs: fresh.proofs,
    },
  };
}

function assertDisjointPreparedCases(cases: readonly PreparedInterpretationCase[]): void {
  const ownerByRawFindingId = new Map<string, string>();
  for (const prepared of cases) {
    for (const rawFindingId of prepared.rawFindingIds) {
      const owner = ownerByRawFindingId.get(rawFindingId);
      if (owner !== undefined) {
        throw new Error(`Interpretation raw finding "${rawFindingId}" is owned by both "${owner}" and "${prepared.caseId}"`);
      }
      ownerByRawFindingId.set(rawFindingId, prepared.caseId);
    }
  }
}

function actionProjection(cases: readonly PreparedInterpretationCase[]): {
  managerOutput: FindingManagerOutput;
  provisionalFindings: ProvisionalFindingSpec[];
} {
  const managerOutput = createEmptyManagerOutput();
  const provisionalFindings: ProvisionalFindingSpec[] = [];
  for (const prepared of cases) {
    switch (prepared.action.kind) {
      case 'create_independent':
        managerOutput.newFindings.push(prepared.action.newFinding);
        break;
      case 'match_with_proof':
        managerOutput.matches.push(prepared.action.match);
        break;
      case 'open_conflict':
        managerOutput.conflicts.push(prepared.action.conflict);
        provisionalFindings.push(prepared.action.provisionalFinding);
        break;
      case 'provisional':
        provisionalFindings.push(...prepared.action.provisionalFindings);
        break;
    }
  }
  return { managerOutput, provisionalFindings };
}

export function prepareInterpretationCaseActions(input: {
  ledger: FindingLedger;
  items: readonly CanonicalIntakeItem[];
  completedAttemptIds: readonly string[];
  directPlans: readonly InterpretationCaseDirectPlan[];
  proofFastPathPlans: readonly InterpretationCaseProofFastPathPlan[];
  provisionalOnlyRawFindingIds: ReadonlySet<string>;
  invalidRawFindingIds?: ReadonlySet<string>;
}): PreparedInterpretationCasePlan {
  const itemsByRawFindingId = new Map(
    input.items.map((item) => [item.canonical.rawFindingId, item]),
  );
  if (itemsByRawFindingId.size !== input.items.length) {
    throw new Error('Interpretation finalization contains duplicate canonical raw finding ids');
  }
  if (new Set(input.completedAttemptIds).size !== input.completedAttemptIds.length) {
    throw new Error('Interpretation finalization contains duplicate completed attempt ids');
  }
  const completedAttempts = input.completedAttemptIds.map((attemptId) => {
    const attempt = input.ledger.interpretationAttempts.find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (attempt === undefined) {
      throw new Error(`Interpretation finalization references unknown attempt "${attemptId}"`);
    }
    if (attempt.stage !== 'completed') {
      throw new Error(`Interpretation attempt "${attemptId}" must be completed before preparation`);
    }
    return attempt;
  });
  assertExactPreparationCoverage({
    ledger: input.ledger,
    itemRawFindingIds: new Set(itemsByRawFindingId.keys()),
    completedAttempts,
    directPlans: input.directPlans,
    proofFastPathPlans: input.proofFastPathPlans,
  });
  const prepared: PreparedInterpretationCase[] = [];
  for (const attempt of completedAttempts) {
    const coverage = completedAttemptCoverage({
      ledger: input.ledger,
      attempt,
      itemsByRawFindingId,
    });
    const resolution = resolveCurrentCase({
      ledger: input.ledger,
      items: coverage.items,
      provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
      expected: coverage.expected,
    });
    const commitResolution = resolveInterpretationCommit({
      ledger: input.ledger,
      caseSnapshotId: attempt.caseSnapshotId,
      items: coverage.items,
      invalidRawFindingIds: input.invalidRawFindingIds,
    });
    const preparedCase = commitResolution.application.classification === 'decision_applied'
      ? prepareDecisionCase({
          ledger: input.ledger,
          resolution,
          expected: coverage.expected,
          attemptId: attempt.attemptId,
          decision: attempt.decision,
        })
      : (() => {
          const invalidRawFindingIds = commitResolution.application.classification === 'decision_rejected_raw_invalid'
            ? new Set(commitResolution.application.invalidRawFindingIds)
            : new Set<string>();
          const validItems = coverage.items.filter(
            (item) => !invalidRawFindingIds.has(item.canonical.rawFindingId),
          );
          const rejected = provisionalPreparedCase({
            expected: coverage.expected,
            items: validItems.length === 0 ? coverage.items : validItems,
            attemptId: attempt.attemptId,
            decision: attempt.decision,
            reason: commitResolution.application.classification === 'decision_rejected_stale'
              ? 'Interpretation case was rejected because an origin or semantic target became stale'
              : 'Interpretation case was rejected because a raw member became invalid',
          });
          if (commitResolution.application.classification !== 'decision_rejected_stale') {
            return {
              ...rejected,
              rawFindingIds: coverage.items.map((item) => item.canonical.rawFindingId),
              invalidRawFindingIds: [...invalidRawFindingIds].sort(compareBinaryStrings),
              action: {
                kind: 'provisional' as const,
                provisionalFindings: validItems.length === 0
                  ? []
                  : rejected.action.kind === 'provisional'
                    ? rejected.action.provisionalFindings
                    : [],
              },
            };
          }
          return {
            ...rejected,
            action: {
              kind: 'provisional' as const,
              provisionalFindings: coverage.items.map((item) => {
                const causes = commitResolution.staleCauses.filter(
                  (cause) => cause.rawFindingId === item.canonical.rawFindingId,
                );
                const kind: ProvisionalFindingSpec['kind'] = causes.some(
                  (cause) => cause.kind === 'origin_head_changed',
                )
                  ? 'recovery-origin-stale'
                  : causes.some((cause) => cause.kind === 'semantic_target_head_changed')
                    ? 'stale-precondition'
                    : 'raw-adjudication-unresolved';
                return provisionalSpec({
                  caseId: coverage.expected.caseId,
                  lineageKey: coverage.expected.lineageKey,
                  items: [item],
                  kind,
                  reason: causes.length > 0
                    ? 'This interpretation member became stale before commit'
                    : 'A peer in this interpretation case became stale before commit',
                });
              }),
            },
          };
        })();
    prepared.push({
      ...preparedCase,
      commitResolution,
    });
  }
  for (const direct of input.directPlans) {
    const rawFindingIds = direct.plannedCase.members.map((member) => member.rawFindingId);
    const items = itemsForRawFindingIds(itemsByRawFindingId, rawFindingIds);
    const resolution = resolveCurrentCase({
      ledger: input.ledger,
      items,
      provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
      expected: direct.plannedCase,
    });
    const preparedDirect = prepareDecisionCase({
      ledger: input.ledger,
      resolution,
      expected: direct.plannedCase,
      attemptId: null,
      decision: direct.decision,
    });
    const authorizedDirect = direct.unreservedAuthority === undefined
      || preparedDirect.action.kind !== 'provisional'
      ? preparedDirect
      : {
          ...preparedDirect,
          action: {
            kind: 'provisional' as const,
            provisionalFindings: [provisionalSpec({
              caseId: direct.plannedCase.caseId,
              lineageKey: direct.plannedCase.lineageKey,
              items,
              kind: direct.unreservedAuthority.reason,
              reason: direct.decision.kind === 'provisional'
                ? direct.decision.reason
                : 'Interpretation provider call was not reserved',
            })].map((spec) => ({
              ...spec,
              landingAuthority: structuredClone(direct.unreservedAuthority!),
            })),
          },
        };
    prepared.push({
      ...authorizedDirect,
      directSnapshot: {
        roundIdentity: direct.roundIdentity,
        policyClass: direct.plannedCase.policyClass,
      },
      directItems: items,
    });
  }
  for (const proof of input.proofFastPathPlans) {
    const rawFindingIds = proof.items.map((item) => item.canonical.rawFindingId);
    const items = itemsForRawFindingIds(itemsByRawFindingId, rawFindingIds);
    const expected = {
      caseId: proof.caseId,
      lineageKey: proof.lineageKey,
      semanticProjectionDigest: proof.semanticProjectionDigest,
      members: proof.items.map((item) => ({
        rawFindingId: item.canonical.rawFindingId,
        canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(item.canonical),
      })),
    };
    const resolution = resolveCurrentCase({
      ledger: input.ledger,
      items,
      provisionalOnlyRawFindingIds: input.provisionalOnlyRawFindingIds,
      expected,
    });
    prepared.push({
      ...prepareSameProofCase({ ledger: input.ledger, resolution, expected: proof }),
      directSnapshot: {
        roundIdentity: proof.roundIdentity,
        policyClass: proof.plannedCase.policyClass,
      },
      directItems: items,
    });
  }
  prepared.sort((left, right) => compareBinaryStrings(left.caseId, right.caseId));
  assertDisjointPreparedCases(prepared);
  return { cases: prepared, ...actionProjection(prepared) };
}

function exactlyOne<Value>(values: readonly Value[], description: string): Value {
  if (values.length !== 1) {
    throw new Error(`Interpretation finalization requires exactly one ${description}; found ${values.length}`);
  }
  return values[0]!;
}

function landingEventId(input: {
  ledger: FindingLedger;
  entityKind: 'finding' | 'conflict';
  entityId: string;
  rawFindingId: string;
  caseId: string;
}): string {
  const events = input.ledger.lifecycleEvents.filter((event) => (
    event.transitions.some((transition) => (
      transition.after.entityKind === input.entityKind
      && transition.after.entityId === input.entityId
    ))
    && event.evidenceBindingIds.some((bindingId) => {
      const binding = input.ledger.evidenceBindings.find(
        (candidate) => candidate.bindingId === bindingId,
      );
      return binding?.sourceRawFindingId === input.rawFindingId
        && binding.target.entityKind === input.entityKind
        && binding.target.entityId === input.entityId
        && binding.contributionOrigin.kind === 'interpretation_case'
        && binding.contributionOrigin.caseId === input.caseId;
    })
  ));
  if (events.length !== 1) {
    throw new Error(
      `Interpretation landing event for raw finding "${input.rawFindingId}" is not exact; found ${events.length}`,
    );
  }
  return events[0]!.eventId;
}

function conflictLandingRecords(input: {
  ledger: FindingLedger;
  prepared: PreparedInterpretationCase;
  conflictId: string;
  holdingFindingId: string;
  observation: FindingObservation;
}): ConflictRawClaimLanding[] {
  const holdingHead = captureFindingLifecycleHead(
    input.ledger,
    'finding',
    input.holdingFindingId,
  );
  if (holdingHead === undefined) {
    throw new Error(`Conflict holding "${input.holdingFindingId}" has no lifecycle head`);
  }
  const identities = input.prepared.rawFindingIds.map((rawFindingId) => {
    const snapshot = exactlyOne(
      input.ledger.rawCanonicalSnapshots.filter(
        (candidate) => candidate.rawFindingId === rawFindingId,
      ),
      `raw canonical snapshot for "${rawFindingId}"`,
    );
    const claimSnapshotDigest = computeConflictRawClaimSnapshotDigest(snapshot);
    const identity = {
      conflictId: input.conflictId,
      rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      rawPayloadDigest: snapshot.rawPayloadDigest,
      claimSnapshotDigest,
    };
    return {
      ...identity,
      rawClaimLandingId: computeConflictRawClaimLandingId(identity),
    };
  });
  const holdingAllocationId = computeConflictHoldingAllocationId(
    input.conflictId,
    identities.map(({ rawClaimLandingId }) => rawClaimLandingId),
  );
  return identities.map((identity) => {
    const eventId = landingEventId({
      ledger: input.ledger,
      entityKind: 'finding',
      entityId: input.holdingFindingId,
      rawFindingId: identity.rawFindingId,
      caseId: input.prepared.caseId,
    });
    return {
      ...identity,
      holdingAllocationId,
      holdingFindingId: input.holdingFindingId,
      holdingHeadAfterLanding: structuredClone(holdingHead),
      landingEventId: eventId,
      landedAt: structuredClone(input.observation),
    };
  });
}

function outcomesAndLandingsForCase(input: {
  ledger: FindingLedger;
  prepared: PreparedInterpretationCase;
  observation: FindingObservation;
}): { outcomes: RawInterpretationOutcome[]; landings: ConflictRawClaimLanding[] } {
  const { ledger, prepared } = input;
  const action = prepared.action;
  const invalidRawFindingIds = new Set(prepared.invalidRawFindingIds ?? []);
  const substantiveRawFindingIds = prepared.rawFindingIds.filter(
    (rawFindingId) => !invalidRawFindingIds.has(rawFindingId),
  );
  const productFindings = ledger.findings.filter((finding) => (
    finding.provisional === undefined
    && prepared.rawFindingIds.every((rawFindingId) => finding.rawFindingIds.includes(rawFindingId))
  ));
  const provisionalFindings = ledger.findings.filter((finding) => (
    finding.status === 'open'
    && finding.provisional !== undefined
    && substantiveRawFindingIds.every((rawFindingId) => (
      finding.rawFindingIds.includes(rawFindingId)
      && finding.provisional!.sourceRawFindingIds.includes(rawFindingId)
    ))
  ));
  const conflicts = ledger.conflicts.filter((conflict) => (
    conflict.status === 'active'
    && prepared.rawFindingIds.every((rawFindingId) => conflict.rawFindingIds.includes(rawFindingId))
  ));
  switch (action.kind) {
    case 'create_independent': {
      if (provisionalFindings.length > 0 || conflicts.length > 0) {
        throw new Error(`Interpretation case "${prepared.caseId}" has an ambiguous created landing`);
      }
      const finding = exactlyOne(productFindings, `created product landing for case "${prepared.caseId}"`);
      return {
        outcomes: prepared.rawFindingIds.map((rawFindingId) => ({
          rawFindingId,
          kind: 'finding' as const,
          findingId: finding.id,
          outcome: 'created' as const,
          landingEventId: landingEventId({
            ledger,
            entityKind: 'finding',
            entityId: finding.id,
            rawFindingId,
            caseId: prepared.caseId,
          }),
        })),
        landings: [],
      };
    }
    case 'match_with_proof': {
      const target = ledger.findings.find((finding) => finding.id === action.targetFindingId);
      if (
        target === undefined
        || target.provisional !== undefined
        || !prepared.rawFindingIds.every((rawFindingId) => target.rawFindingIds.includes(rawFindingId))
        || productFindings.some((finding) => finding.id !== target.id)
        || provisionalFindings.length > 0
        || conflicts.length > 0
      ) {
        throw new Error(`Interpretation case "${prepared.caseId}" has no unique SameProof landing`);
      }
      for (const rawFindingId of prepared.rawFindingIds) {
        const bound = ledger.evidenceBindings.some((binding) => (
          binding.target.entityKind === 'finding'
          && binding.target.entityId === target.id
          && binding.sourceRawFindingId === rawFindingId
          && binding.contributionOrigin.kind === 'interpretation_case'
          && binding.contributionOrigin.caseId === prepared.caseId
        ));
        if (!bound) {
          throw new Error(`SameProof landing for raw finding "${rawFindingId}" has no interpretation evidence binding`);
        }
      }
      return {
        outcomes: prepared.rawFindingIds.map((rawFindingId) => ({
          rawFindingId,
          kind: 'finding' as const,
          findingId: target.id,
          outcome: 'matched_with_proof' as const,
          landingEventId: landingEventId({
            ledger,
            entityKind: 'finding',
            entityId: target.id,
            rawFindingId,
            caseId: prepared.caseId,
          }),
        })),
        landings: [],
      };
    }
    case 'open_conflict': {
      if (productFindings.length > 0) {
        throw new Error(`Interpretation case "${prepared.caseId}" has an ambiguous conflict landing`);
      }
      const conflict = exactlyOne(
        conflicts.filter((candidate) => sameStringSet(
          candidate.findingIds,
          action.conflict.findingIds,
        )),
        `active conflict landing for case "${prepared.caseId}"`,
      );
      const provisional = exactlyOne(
        provisionalFindings.filter((finding) => (
          finding.provisional?.stableKey === action.provisionalFinding.stableKey
        )),
        `holding provisional landing for case "${prepared.caseId}"`,
      );
      const landings = conflictLandingRecords({
        ledger,
        prepared,
        conflictId: conflict.id,
        holdingFindingId: provisional.id,
        observation: input.observation,
      });
      const landingByRawFindingId = new Map(
        landings.map((landing) => [landing.rawFindingId, landing]),
      );
      return {
        outcomes: prepared.rawFindingIds.map((rawFindingId) => {
          const landing = landingByRawFindingId.get(rawFindingId)!;
          return {
            rawFindingId,
            kind: 'conflict' as const,
            conflictId: conflict.id,
            rawClaimLandingId: landing.rawClaimLandingId,
            provisionalFindingId: provisional.id,
            conflictLandingEventId: landingEventId({
              ledger,
              entityKind: 'conflict',
              entityId: conflict.id,
              rawFindingId,
              caseId: prepared.caseId,
            }),
            provisionalLandingEventId: landing.landingEventId,
          };
        }),
        landings,
      };
    }
    case 'provisional': {
      if (productFindings.length > 0 || conflicts.length > 0) {
        throw new Error(`Interpretation case "${prepared.caseId}" has an ambiguous provisional landing`);
      }
      return {
        outcomes: prepared.rawFindingIds.map((rawFindingId) => {
          if (invalidRawFindingIds.has(rawFindingId)) {
            const anomalies = (ledger.reviewerAnomalies ?? []).filter(
              (anomaly) => anomaly.sourceRawFindingIds.includes(rawFindingId),
            );
            const anomaly = exactlyOne(
              anomalies,
              `reviewer anomaly landing for raw finding "${rawFindingId}"`,
            );
            return {
              rawFindingId,
              kind: 'reviewer_anomaly' as const,
              anomalyId: anomaly.id,
            };
          }
          const spec = exactlyOne(
            action.provisionalFindings.filter(
              (candidate) => candidate.sourceRawFindingIds.includes(rawFindingId),
            ),
            `provisional spec for raw finding "${rawFindingId}"`,
          );
          const provisional = exactlyOne(
            ledger.findings.filter((finding) => (
              finding.status === 'open'
              && finding.provisional?.stableKey === spec.stableKey
              && finding.rawFindingIds.includes(rawFindingId)
            )),
            `provisional landing for raw finding "${rawFindingId}"`,
          );
          return {
            rawFindingId,
            kind: 'provisional' as const,
            provisionalFindingId: provisional.id,
            landingEventId: landingEventId({
              ledger,
              entityKind: 'finding',
              entityId: provisional.id,
              rawFindingId,
              caseId: prepared.caseId,
            }),
          };
        }),
        landings: [],
      };
    }
  }
}

function applyTerminalOutcome(input: {
  existing: RawInterpretationOutcome | undefined;
  terminal: RawInterpretationOutcome;
  prepared: PreparedInterpretationCase;
}): RawInterpretationOutcome {
  if (input.existing === undefined) {
    if (input.prepared.attemptId !== null) {
      throw new Error(`Attempted raw finding "${input.terminal.rawFindingId}" has no pending outcome`);
    }
    return input.terminal;
  }
  if (input.existing.kind === 'pending_attempt') {
    if (input.prepared.attemptId === null || input.existing.attemptId !== input.prepared.attemptId) {
      throw new Error(`Raw finding "${input.terminal.rawFindingId}" is pending under another attempt`);
    }
    return input.terminal;
  }
  if (canonicalJson(input.existing) !== canonicalJson(input.terminal)) {
    throw new Error(`Terminal interpretation outcome for "${input.terminal.rawFindingId}" cannot be changed`);
  }
  return input.existing;
}

function applyAttemptStage(input: {
  attempt: InterpretationAttempt;
  prepared: PreparedInterpretationCase;
  observation: FindingObservation;
  ledger: FindingLedger;
}): InterpretationAttempt {
  if (
    input.attempt.caseId !== input.prepared.caseId
    || !sameStringSet(input.attempt.rawFindingIds, input.prepared.rawFindingIds)
  ) {
    throw new Error(`Interpretation attempt "${input.attempt.attemptId}" does not own the prepared case`);
  }
  if (input.attempt.stage === 'applied') {
    return input.attempt;
  }
  if (input.attempt.stage !== 'completed') {
    throw new Error(`Interpretation attempt "${input.attempt.attemptId}" must be completed before application`);
  }
  const application: InterpretationAttemptApplication = input.prepared.commitResolution === undefined
    ? { classification: 'decision_applied', originSettlementIds: [] }
    : {
        ...input.prepared.commitResolution.application,
        originSettlementIds: input.ledger.interpretationRecoveryOriginSettlements
          .filter((settlement) => settlement.caseSnapshotId === input.attempt.caseSnapshotId)
          .map(({ settlementId }) => settlementId)
          .sort(compareBinaryStrings),
      };
  return {
    ...input.attempt,
    stage: 'applied',
    appliedAt: { ...input.observation },
    application,
  };
}

function appendOriginSettlements(input: {
  ledger: FindingLedger;
  prepared: PreparedInterpretationCase;
  observation: FindingObservation;
}): FindingLedger {
  const resolution = input.prepared.commitResolution;
  if (resolution === undefined) {
    return input.ledger;
  }
  const existingBindingIds = new Set(
    input.ledger.interpretationRecoveryOriginSettlements.map(({ bindingId }) => bindingId),
  );
  const settlements = [
    ...resolution.staleOriginBindings.map((binding) => createInterpretationOriginSettlement({
      binding,
      recordedAt: input.observation,
      result: { outcome: 'stale', reason: 'origin lifecycle head changed before commit' },
    })),
    ...resolution.freshOriginBindings.map((binding) => createInterpretationOriginSettlement({
      binding,
      recordedAt: input.observation,
      result: {
        outcome: 'retained',
        reason: resolution.application.classification === 'decision_rejected_raw_invalid'
          ? 'case_decision_rejected_raw_invalid'
          : resolution.application.classification === 'decision_rejected_stale'
            ? 'case_decision_rejected_stale'
            : input.prepared.action.kind === 'provisional'
              ? 'case_decision_provisional'
              : 'origin_not_targeted',
      },
    })),
  ].filter((settlement) => !existingBindingIds.has(settlement.bindingId));
  return {
    ...input.ledger,
    interpretationRecoveryOriginSettlements: [
      ...input.ledger.interpretationRecoveryOriginSettlements,
      ...settlements,
    ],
  };
}

function materializeDirectCaseRecords(input: {
  ledger: FindingLedger;
  prepared: PreparedInterpretationCase;
  observation: FindingObservation;
}): FindingLedger {
  if (input.prepared.attemptId !== null) {
    return input.ledger;
  }
  const directSnapshot = input.prepared.directSnapshot;
  const items = input.prepared.directItems;
  if (directSnapshot === undefined || items === undefined) {
    throw new Error(`Direct interpretation case "${input.prepared.caseId}" has no snapshot source`);
  }
  const existingObservations = input.ledger.interpretationRawObservations.filter(
    (candidate) => candidate.caseId === input.prepared.caseId,
  );
  if (existingObservations.length > 0) {
    if (!sameStringSet(
      existingObservations.map(({ rawFindingId }) => rawFindingId),
      input.prepared.rawFindingIds,
    )) {
      throw new Error(`Direct interpretation case "${input.prepared.caseId}" changed membership`);
    }
    return input.ledger;
  }
  const originPlans = planInterpretationOriginAttachments({
    ledger: input.ledger,
    freshItems: items,
    currentRound: (input.ledger.stopBudget?.roundMarkers.length ?? 0) + 1,
  });
  const originDigestsByRawFindingId = originSnapshotDigestsByRawFindingId(originPlans);
  const withRawSnapshots = appendRawFindingsWithCanonicalSnapshots({
    ledger: input.ledger,
    items,
    capturedAt: input.observation,
  });
  const cohortId = computeInterpretationCohortId(
    input.prepared.caseId,
    input.prepared.semanticProjectionDigest,
    input.prepared.rawFindingIds,
  );
  const observations = items.map((item) => {
    const snapshot = withRawSnapshots.rawCanonicalSnapshots.find(
      (snapshot) => snapshot.rawFindingId === item.canonical.rawFindingId,
    );
    if (snapshot === undefined) {
      throw new Error(`Direct interpretation raw finding "${item.canonical.rawFindingId}" has no canonical snapshot`);
    }
    const originSnapshotDigests = originDigestsByRawFindingId.get(
      item.canonical.rawFindingId,
    );
    if (originSnapshotDigests === undefined) {
      throw new Error(`Direct interpretation origin plan is missing "${item.wire.rawFindingId}"`);
    }
    const observation = {
      rawFindingId: item.canonical.rawFindingId,
      rawCanonicalSnapshotId: snapshot.rawCanonicalSnapshotId,
      caseId: input.prepared.caseId,
      cohortId,
      caseSnapshotId: '',
      lineageKey: input.prepared.lineageKey,
      semanticProjectionDigest: input.prepared.semanticProjectionDigest,
      originSnapshotDigests,
      recoveryOriginBindingIds: [] as string[],
    };
    return {
      ...observation,
      observationDigest: computeInterpretationObservationDigest(observation),
    };
  }).sort((left, right) => compareBinaryStrings(left.rawFindingId, right.rawFindingId));
  const caseSnapshotWithoutId = {
    caseId: input.prepared.caseId,
    cohortId,
    roundIdentity: directSnapshot.roundIdentity,
    lineageKey: input.prepared.lineageKey,
    policyClass: directSnapshot.policyClass,
    semanticProjectionDigest: input.prepared.semanticProjectionDigest,
    memberRawFindingIds: observations.map(({ rawFindingId }) => rawFindingId),
    memberObservationDigests: observations.map(({ observationDigest }) => observationDigest),
    originSnapshotSetDigest: computeInterpretationOriginSnapshotSetDigest(observations),
  };
  const caseSnapshot = {
    caseSnapshotId: computeInterpretationCaseSnapshotId(caseSnapshotWithoutId),
    ...caseSnapshotWithoutId,
    createdAt: structuredClone(input.observation),
  };
  const bindings = createInterpretationOriginBindings({
    caseSnapshot,
    plans: originPlans,
    boundAt: input.observation,
  });
  const bindingIdsByRawFindingId = new Map<string, string[]>();
  for (const binding of bindings) {
    const ids = bindingIdsByRawFindingId.get(binding.observationRawFindingId) ?? [];
    bindingIdsByRawFindingId.set(
      binding.observationRawFindingId,
      [...ids, binding.bindingId].sort(compareBinaryStrings),
    );
  }
  return {
    ...withRawSnapshots,
    interpretationCaseSnapshots: [...input.ledger.interpretationCaseSnapshots, caseSnapshot],
    interpretationRawObservations: [
      ...input.ledger.interpretationRawObservations,
      ...observations.map((observation) => ({
        ...observation,
        caseSnapshotId: caseSnapshot.caseSnapshotId,
        recoveryOriginBindingIds:
          bindingIdsByRawFindingId.get(observation.rawFindingId) ?? [],
      })),
    ],
    interpretationRecoveryOriginBindings: [
      ...input.ledger.interpretationRecoveryOriginBindings,
      ...bindings,
    ],
  };
}

export function finalizeInterpretationCaseProjection(input: {
  ledger: FindingLedger;
  prepared: PreparedInterpretationCasePlan;
  observation: FindingObservation;
}): FindingLedger {
  if (input.prepared.cases.length === 0) {
    return input.ledger;
  }
  let materializedLedger = input.ledger;
  for (const prepared of input.prepared.cases) {
    materializedLedger = materializeDirectCaseRecords({
      ledger: materializedLedger,
      prepared,
      observation: input.observation,
    });
  }
  const terminalByRawFindingId = new Map<string, RawInterpretationOutcome>();
  const newLandings: ConflictRawClaimLanding[] = [];
  for (const prepared of input.prepared.cases) {
    const projected = outcomesAndLandingsForCase({
      ledger: materializedLedger,
      prepared,
      observation: input.observation,
    });
    for (const terminal of projected.outcomes) {
      if (terminalByRawFindingId.has(terminal.rawFindingId)) {
        throw new Error(`Interpretation finalization produced duplicate raw outcome "${terminal.rawFindingId}"`);
      }
      terminalByRawFindingId.set(terminal.rawFindingId, terminal);
    }
    newLandings.push(...projected.landings);
  }
  const existingByRawFindingId = new Map<string, RawInterpretationOutcome>();
  for (const outcome of materializedLedger.rawInterpretationOutcomes) {
    if (existingByRawFindingId.has(outcome.rawFindingId)) {
      throw new Error(`Interpretation ledger contains duplicate raw outcome "${outcome.rawFindingId}"`);
    }
    existingByRawFindingId.set(outcome.rawFindingId, outcome);
  }
  for (const prepared of input.prepared.cases) {
    for (const rawFindingId of prepared.rawFindingIds) {
      const terminal = terminalByRawFindingId.get(rawFindingId)!;
      existingByRawFindingId.set(rawFindingId, applyTerminalOutcome({
        existing: existingByRawFindingId.get(rawFindingId),
        terminal,
        prepared,
      }));
    }
  }
  const preparedByAttemptId = new Map(
    input.prepared.cases.flatMap((prepared) => (
      prepared.attemptId === null ? [] : [[prepared.attemptId, prepared] as const]
    )),
  );
  for (const attemptId of preparedByAttemptId.keys()) {
    if (!materializedLedger.interpretationAttempts.some((attempt) => attempt.attemptId === attemptId)) {
      throw new Error(`Interpretation finalization references missing attempt "${attemptId}"`);
    }
  }
  let settledLedger = materializedLedger;
  for (const prepared of input.prepared.cases) {
    settledLedger = appendOriginSettlements({
      ledger: settledLedger,
      prepared,
      observation: input.observation,
    });
  }
  const landingsByRawFindingId = new Map(
    settledLedger.conflictRawClaimLandings.map((landing) => [landing.rawFindingId, landing]),
  );
  for (const landing of newLandings) {
    const existing = landingsByRawFindingId.get(landing.rawFindingId);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(landing)) {
      throw new Error(`Conflict raw claim "${landing.rawFindingId}" already has another owner`);
    }
    if (existing === undefined) {
      landingsByRawFindingId.set(landing.rawFindingId, landing);
    }
  }
  return {
    ...settledLedger,
    updatedAt: input.observation.timestamp,
    conflictRawClaimLandings: [...landingsByRawFindingId.values()]
      .sort((left, right) => compareBinaryStrings(left.rawClaimLandingId, right.rawClaimLandingId)),
    rawInterpretationOutcomes: [...existingByRawFindingId.values()]
      .sort((left, right) => compareBinaryStrings(left.rawFindingId, right.rawFindingId)),
    interpretationAttempts: settledLedger.interpretationAttempts.map((attempt) => {
      const prepared = preparedByAttemptId.get(attempt.attemptId);
      return prepared === undefined
        ? attempt
        : applyAttemptStage({
            attempt,
            prepared,
            observation: input.observation,
            ledger: settledLedger,
          });
    }),
  };
}

export function stagePreparedInterpretationCaseOwnership(input: {
  ledger: FindingLedger;
  prepared: PreparedInterpretationCasePlan;
  items: readonly CanonicalIntakeItem[];
  observation: FindingObservation;
}): FindingLedger {
  const itemsByRawFindingId = new Map(
    input.items.map((item) => [item.canonical.rawFindingId, item]),
  );
  const ownedItems: CanonicalIntakeItem[] = [];
  for (const preparedCase of input.prepared.cases) {
    for (const rawFindingId of preparedCase.rawFindingIds) {
      const item = itemsByRawFindingId.get(rawFindingId);
      if (item === undefined) {
        throw new Error(`Interpretation ownership is missing raw finding "${rawFindingId}"`);
      }
      ownedItems.push(item);
    }
    if (preparedCase.attemptId === null) {
      continue;
    }
    for (const rawFindingId of preparedCase.rawFindingIds) {
      const existingObservation = input.ledger.interpretationRawObservations.find(
        (observation) => observation.rawFindingId === rawFindingId,
      );
      const existingOutcome = input.ledger.rawInterpretationOutcomes.find(
        (outcome) => outcome.rawFindingId === rawFindingId,
      );
      if (
        existingObservation?.caseId !== preparedCase.caseId
        || existingOutcome?.kind !== 'pending_attempt'
        || existingOutcome.attemptId !== preparedCase.attemptId
      ) {
        throw new Error(`Interpretation attempt ownership is missing for "${rawFindingId}"`);
      }
    }
  }
  return appendRawFindingsWithCanonicalSnapshots({
    ledger: input.ledger,
    items: ownedItems,
    capturedAt: input.observation,
  });
}
