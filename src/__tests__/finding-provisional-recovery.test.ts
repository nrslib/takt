import { describe, expect, it, vi } from 'vitest';
import type { FindingLedger, FindingLedgerEntry, FindingManagerOutput, RawFinding } from '../core/workflow/findings/types.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
} from './helpers/finding-lifecycle-fixture.js';
import {
  applyRejectedObservationAttachments,
  applyProvisionalSettlement,
  settleProvisionalsWithCleanEvidence,
} from '../core/workflow/findings/manager-provisional-settlement.js';
import { classifyProvisionalRecovery } from '../core/workflow/findings/provisional-recovery.js';
import {
  computeBaseInterpretationKey,
  computeInterpretationAttemptKey,
  computeLineageKey,
  candidateFromStoredRawFinding,
  canonicalRawIntegrityDigestOf,
  canonicalizeReviewerRawFinding,
  toLedgerRawFinding,
} from '../core/workflow/findings/raw-canonicalization.js';
import {
  beginInterpretations,
  completeInterpretations,
  countInterpretationEpochs,
  markInterpretationsApplied,
  releaseInterpretationReservations,
  resolveInterpretationAttempt,
  syncProvisionalInterpretationEpochs,
} from '../core/workflow/findings/interpretation-wal.js';
import type { FindingManagerStore } from '../core/workflow/findings/store.js';
import type { InterpretationLiveClaimRegistry } from '../core/workflow/findings/interpretation-live-claims.js';
import {
  applyManagerActionRecoveryLifecycleCommands,
  applyManagerActionRecovery,
  collectManagerActionRecoveryCandidates,
  planManagerActionRecovery,
} from '../core/workflow/findings/manager-action-recovery.js';
import { issueManagerLifecycleAuthority } from '../core/workflow/findings/manager-lifecycle-authority.js';
import { assembleAndApplyManagerLifecycleTransactions } from '../core/workflow/findings/manager-lifecycle-assembly.js';
import { reconcileFindingLedger } from '../core/workflow/findings/reconciler.js';
import { applyRawAdjudicationRecovery } from '../core/workflow/findings/raw-adjudication-commit.js';
import {
  captureFindingPreconditions,
  checkFindingPrecondition,
} from '../core/workflow/findings/finding-preconditions.js';
import type { LadderResult, RunFindingManagerForStepInput } from '../core/workflow/findings/manager-contracts.js';
import {
  applyInterpretationRecoveryFailures,
  attachInterpretationRecoveryOrigins,
  collectInterpretationRecoveryPlan,
  collectInterpretationRecoveryItems,
} from '../core/workflow/findings/interpretation-recovery.js';
import { classifyInitialLadderTargets } from '../core/workflow/findings/manager-interpretation-plan.js';
import {
  releaseRawAdjudicationReservations,
  reserveRawAdjudicationRecovery,
} from '../core/workflow/findings/raw-adjudication-reservation.js';
import {
  buildLadderCommitPlan,
  selectCommittableLadder,
} from '../core/workflow/findings/manager-ladder-commit-plan.js';
import {
  buildFindingManagerCommitMutation,
  type FindingManagerCommitPlanInput,
} from '../core/workflow/findings/manager-commit-plan.js';
import {
  matchesProvisionalRecoveryOrigin,
  snapshotProvisionalRecoveryOrigin,
} from '../core/workflow/findings/provisional-recovery-origin.js';
import { resolveReviewIntegrityLimits } from '../core/workflow/findings/review-integrity.js';
import { resolveStopBudgetLimits } from '../core/workflow/findings/stop-budget.js';
import { verifiedSourceQuoteFields } from './helpers/finding-evidence.js';
import { createRawRecoveryAttempt } from '../core/models/finding-raw-recovery.js';
import { computeRawFindingIntegrityDigest } from '../core/models/finding-raw-integrity.js';
import { captureFindingLifecycleHead } from '../core/workflow/findings/lifecycle-mutation.js';
import { buildManagerCommitReport } from '../core/workflow/findings/manager-report.js';
import {
  assertCanonicalIntakeRecoveryState,
  evaluateRawAdmission,
} from '../core/workflow/findings/manager-admission.js';
import {
  computeClaimIdentityHash,
  deduplicateRawEvidence,
} from '../core/workflow/findings/evidence-domain.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import { createAnchorAdjudication } from '../core/models/finding-anchor-relevance.js';
import { computeConflictEvidenceHash } from '../core/workflow/findings/adjudication-evidence.js';
import * as reviewScopeSnapshot from '../core/workflow/findings/snapshot.js';
import { canonicalJson } from '../shared/utils/canonical-json.js';
import {
  createEngineDerivedWaiverConflict,
  createEngineDerivedWaiverDisputeNote,
  isEngineDerivedWaiverConflict,
} from '../core/workflow/findings/waiver-conflict.js';

const observation = {
  runId: 'run-1',
  stepName: 'reviewers',
  timestamp: '2026-07-20T00:00:00.000Z',
};
const stopBudgetRoundMarker = 'test-round-marker';
const TEST_INTEGRITY_DIGEST = 'a'.repeat(64);

function completedWalFields(rawFindingId: string) {
  return {
    reservationToken: `reservation-${rawFindingId}`,
    completedAt: observation,
    validatedDecision: {
      decision: 'provisional' as const,
      rawFindingId,
      reason: 'Recorded test interpretation.',
    },
  };
}

function emptyOutput(): FindingManagerOutput {
  return {
    anchorAdjudications: [],
    matches: [],
    newFindings: [],
    resolvedFindings: [],
    reopenedFindings: [],
    conflicts: [],
    resolvedConflicts: [],
    waivedFindings: [],
    disputeNotes: [],
    invalidatedFindings: [],
    duplicateFindings: [],
    dismissedFindings: [],
  };
}

function emptyReviewScopeSnapshot(reviewScopeSnapshotId: string) {
  return {
    reviewScopeSnapshotId,
    trackedDiff: undefined,
    untrackedEvidence: [],
    queryInventory: [],
  };
}

function raw(
  rawFindingId: string,
  targetPath = 'fixtures/state-transition.ts',
): RawFinding {
  return canonicalRawFindingFixture({
    rawFindingId,
    stepName: 'reviewer-a',
    reviewer: 'reviewer-a',
    familyTag: 'bug',
    severity: 'high',
    title: 'Incorrect state transition',
    description: 'The transition leaves the state inconsistent.',
    suggestion: null,
    relation: 'new',
    targetFindingId: null,
    target: {
      kind: 'code',
      paths: [targetPath],
    },
    evidence: [],
  });
}

function provisional(
  id: string,
  kind: NonNullable<FindingLedgerEntry['provisional']>['kind'],
  targetPath?: string,
): FindingLedgerEntry {
  const source = raw('source-1', targetPath);
  return {
    id,
    status: 'open',
    lifecycle: 'new',
    target: source.target,
    targetIdentityHash: source.targetIdentityHash,
    claimIdentityHash: source.claimIdentityHash,
    semanticClaimIdentityHash: source.semanticClaimIdentityHash,
    severity: 'high',
    title: 'Incorrect state transition',
    evidenceIds: [],
    description: 'The transition leaves the state inconsistent.',
    reviewers: ['reviewer-a'],
    rawFindingIds: ['source-1'],
    firstSeen: observation,
    lastSeen: observation,
    revision: 1,
    provisional: {
      kind,
      stableKey: `stable-${id}`,
      lineageKey: `lineage-${id}`,
      sourceRawFindingIds: ['source-1'],
      reason: 'pending recovery',
      firstObservedAt: observation,
      lastObservedAt: observation,
      interpretationEpochs: 0,
      gateEffect: 'block',
      firstObservedRound: 1,
      recoveryReviewerStableKey: 'reviewer-stable-a',
    },
  };
}

function alignRecoveryLineageWithStoredRaw(
  finding: FindingLedgerEntry,
  source: RawFinding,
): void {
  if (finding.provisional === undefined) {
    throw new Error('Test recovery finding must be provisional');
  }
  finding.provisional.lineageKey = computeLineageKey({
    claimIdentityHash: computeClaimIdentityHash(source),
    ...(source.targetFindingId !== null
      ? { targetFindingId: source.targetFindingId }
      : {}),
  });
}

function ledger(findings: FindingLedgerEntry[], rawFindings: RawFinding[] = []): FindingLedger {
  const authorized = authorizeFindingLedgerFixture({
    workflowName: 'peer-review',
    nextId: 20,
    updatedAt: observation.timestamp,
    findings,
    evidenceRecords: [],
    rawFindings,
    conflicts: [],
    interpretations: [],
  });
  findings.forEach((finding, index) => {
    Object.assign(finding, authorized.findings[index]);
  });
  return authorized;
}

function testInterpretationLiveClaims(
  initiallyClaimed: readonly string[] = [],
): InterpretationLiveClaimRegistry {
  const claimed = new Set(initiallyClaimed);
  return {
    isClaimed: (_ledgerIdentity, reservationToken) => claimed.has(reservationToken),
    acquire: (_ledgerIdentity, reservationToken) => {
      if (claimed.has(reservationToken)) {
        throw new Error(`Interpretation reservation "${reservationToken}" is already live`);
      }
      claimed.add(reservationToken);
    },
    release: (_ledgerIdentity, reservationToken) => {
      claimed.delete(reservationToken);
    },
  };
}

function rawRecoveryOrigin(
  current: FindingLedger,
  finding: FindingLedgerEntry,
  sourceRawFindingId: string,
  attempt = 1,
) {
  const expectedHead = captureFindingLifecycleHead(
    current,
    'finding',
    finding.id,
  );
  if (expectedHead === undefined) {
    throw new Error(`Missing lifecycle head for ${finding.id}`);
  }
  const sourceRawFinding = current.rawFindings.find(
    (rawFinding) => rawFinding.rawFindingId === sourceRawFindingId,
  );
  const sourceRawIntegrityDigest = sourceRawFinding === undefined
    ? null
    : computeRawFindingIntegrityDigest(sourceRawFinding);
  const durableAttempt = createRawRecoveryAttempt({
    provisionalFindingId: finding.id,
    expectedHead,
    sourceRawFindingId,
    sourceRawIntegrityDigest,
    promptSnapshotDigest: '1'.repeat(64),
    attempt,
    startedAt: observation,
  });
  current.rawRecoveryAttempts.push(durableAttempt);
  return {
    attemptId: durableAttempt.attemptId,
    provisionalFindingId: finding.id,
    sourceRawFindingId,
    sourceRawIntegrityDigest,
    expectedHead,
    expectedProvisionalRevision: expectedHead.revision,
    expectedTargetIdentityHash: finding.targetIdentityHash,
    attempt,
    recoveryOrigin: snapshotProvisionalRecoveryOrigin(finding),
  };
}

function stampTargetPrecondition(
  finding: RawFinding,
  snapshot: FindingLedger,
): RawFinding {
  if (finding.targetFindingId === null) {
    throw new Error('Test target raw finding must set targetFindingId');
  }
  const targetPrecondition = captureFindingPreconditions(snapshot)
    .get(finding.targetFindingId)?.precondition;
  if (targetPrecondition === undefined) {
    throw new Error(`Test target "${finding.targetFindingId}" must exist in the observation snapshot`);
  }
  return { ...finding, targetPrecondition };
}

function emptyCommitPlanInput(
  overrides: Partial<FindingManagerCommitPlanInput> = {},
): FindingManagerCommitPlanInput {
  const previousLedger = ledger([]);
  return {
    input: {
      contract: {},
      cwd: process.cwd(),
      ledgerStore: { runId: observation.runId, ledgerIdentity: 'test-ledger' },
      optionsBuilder: {},
      stepExecutor: {},
      parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
      stepIteration: 1,
      subResults: [],
      workflowName: previousLedger.workflowName,
      workflowTask: 'Review the supplied implementation.',
      runId: observation.runId,
      callNamespace: '',
      timestamp: observation.timestamp,
      managerAuthority: 'standard',
    } as RunFindingManagerForStepInput,
    previousLedger,
    intake: {
      entityBindings: new Map(),
      items: [],
    overflowRawFindingIds: new Set(),
    intakeProvisionalSpecs: [],
    intakeAnomalySpecs: [],
      overflowReports: [],
      clarifications: [],
      rawNormalizations: [],
      healthyReviewerStableKeys: new Set(),
    },
    interpretationRecoveryFailures: [],
    admission: {
      admissionRejections: [],
      admissionAnomalySpecs: [],
      admissionProvisionalSpecs: [],
      admissionRejectedItems: [],
      pendingRejectedObservations: [],
      cleanAdmitted: [],
      tainted: [],
      taintedAdmitted: [],
      ladderAnomalySpecs: [],
      verifiedEvidenceCandidates: [],
      provisionalOnlyLadderRawIds: new Set(),
      cleanWire: [],
      verifiedEvidenceRecordsByRawFindingId: new Map(),
    },
    managerDecision: {
      managerOutput: emptyOutput(),
      invalidAttempts: [],
      cleanProvisionalSpecs: [],
      unsupportedRawFindingReports: [],
      cleanWireById: new Map(),
      cleanCanonicalById: new Map(),
      ladder: {
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
        stats: {} as LadderResult['stats'],
      },
      rawRecovery: {
        intake: {
          entityBindings: new Map(),
          items: [],
          overflowRawFindingIds: new Set(),
          intakeProvisionalSpecs: [],
          intakeAnomalySpecs: [],
          overflowReports: [],
          clarifications: [],
          rawNormalizations: [],
          healthyReviewerStableKeys: new Set(),
        },
        output: emptyOutput(),
        origins: new Map(),
        failures: new Map(),
        capturedPreconditions: new Map(),
        invalidAttempts: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        reservationTokens: new Set(),
      },
    },
    observation,
    stopBudgetLimits: resolveStopBudgetLimits(undefined),
    stopBudgetRoundMarker: 'round-empty',
    reviewIntegrityLimits: resolveReviewIntegrityLimits(undefined),
    reviewScopeSnapshotId: 'snapshot-empty',
    reviewScopeSnapshot: {
      reviewScopeSnapshotId: 'snapshot-empty',
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [],
    },
    ...overrides,
  };
}

type MixedManagerEntryKind =
  | 'matches'
  | 'newFindings'
  | 'resolvedFindings'
  | 'reopenedFindings'
  | 'conflicts';

function mixedManagerOutput(
  kind: MixedManagerEntryKind,
  findingId: string,
  rawFindingIds: string[],
  title: string,
): FindingManagerOutput {
  const output = emptyOutput();
  switch (kind) {
    case 'matches':
      return {
        ...output,
        matches: [{ findingId, rawFindingIds, evidence: 'Manager grouped both raw findings.' }],
      };
    case 'newFindings':
      return {
        ...output,
        newFindings: [{ rawFindingIds, title, severity: 'high' }],
      };
    case 'resolvedFindings':
      return {
        ...output,
        resolvedFindings: [{ findingId, rawFindingIds, evidence: 'Manager grouped both raw findings.' }],
      };
    case 'reopenedFindings':
      return {
        ...output,
        reopenedFindings: [{ findingId, rawFindingIds, evidence: 'Manager grouped both raw findings.' }],
      };
    case 'conflicts':
      return {
        ...output,
        conflicts: [{
          findingIds: [findingId],
          rawFindingIds,
          description: 'Manager grouped both raw findings.',
        }],
      };
  }
}

describe('provisional recovery', () => {
  it('does not recapture the review scope when there is no conflict resolve candidate', () => {
    const capture = vi.spyOn(
      reviewScopeSnapshot,
      'captureReviewScopeSnapshot',
    );
    const previousLedger = ledger([]);

    buildFindingManagerCommitMutation(
      emptyCommitPlanInput({ previousLedger }),
      previousLedger,
    );

    expect(capture).not.toHaveBeenCalled();
    capture.mockRestore();
  });

  it('preserves unsupported, stale, and audit-only replay outcomes in the final manager report', () => {
    const rawFindingDispositions = [
      { rawFindingId: 'replay-unsupported', outcome: 'unsupported' as const, reason: 'Unsupported.' },
      { rawFindingId: 'replay-stale', outcome: 'stale' as const, reason: 'Precondition changed.' },
      { rawFindingId: 'replay-audit', outcome: 'audit_only' as const, reason: 'Source is missing.' },
    ];

    const report = buildManagerCommitReport({
      runId: observation.runId,
      stepName: observation.stepName,
      managerOutput: emptyOutput(),
      invalidAttempts: [],
      staleRejections: [],
      admissionRejections: [],
      unsupportedRawFindingReports: [],
      overflowReports: [],
      provisionalLandings: [],
      reviewerAnomalyLandings: [],
      rawNormalizations: [],
      clarifications: [],
      interpretationStats: {
        ambiguousRawCount: 0,
        managerCalls: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        reusedCompletedDecisions: 0,
        interruptedInterpretations: 0,
        budgetExhaustedLineages: 0,
      },
      rawFindingDispositions,
      interpretationRecoverySettlements: [],
      managerTaskAudits: [],
    });

    expect(report).toEqual(expect.objectContaining({
      version: 1,
      rawFindingDispositions,
    }));
  });

  it('returns the complete fresh ledger unchanged when the manager round marker was already applied', () => {
    const baseFinding = provisional('F-0001', 'raw-adjudication-unresolved');
    const finding: FindingLedgerEntry = {
      ...baseFinding,
      revision: 2,
      provisional: {
        ...baseFinding.provisional!,
        interpretationEpochs: 1,
      },
    };
    const freshLedger: FindingLedger = {
      ...ledger([finding], [raw('source-1')]),
      reviewerAnomalies: [{
        id: 'A-0001',
        kind: 'quote-mismatch',
        stableKey: 'anomaly-1',
        lineageKey: 'anomaly-lineage-1',
        sourceRawFindingIds: ['source-1'],
        sourceIntakeIds: [],
        reviewers: ['reviewer-a'],
        title: 'Existing reviewer anomaly',
        mismatchReason: 'Existing audit record.',
        firstObserved: observation,
        lastObserved: observation,
        occurrences: 1,
      }],
      stopBudget: {
        roundMarkers: ['round-repeat'],
        firstRoundAt: observation.timestamp,
        exhausted: false,
      },
      reviewIntegrity: {
        roundMarkers: ['round-repeat'],
        firstRoundAt: observation.timestamp,
        exhausted: false,
      },
      interpretations: [{
        interpretationKey: 'interpretation-existing',
        baseInterpretationKey: 'interpretation-base-existing',
        attemptOrdinal: 1,
        reviewerStableKey: 'reviewer-stable-a',
        lineageKey: finding.provisional!.lineageKey,
        candidateEvidenceHash: 'evidence-existing',
        canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
        stage: 'ledger_applied',
        startedAt: observation,
        ...completedWalFields('raw-existing'),
        promptPreconditions: [],
        appliedAt: observation,
        applicationResult: 'provisional_created',
      }],
    };
    const params = emptyCommitPlanInput({
      previousLedger: freshLedger,
      stopBudgetRoundMarker: 'round-repeat',
    });

    const mutation = buildFindingManagerCommitMutation(params, freshLedger);

    expect(mutation.ledger).toBe(freshLedger);
    expect(mutation.ledger).toEqual(freshLedger);
  });

  it('matches a reserved origin only when the complete provisional identity is unchanged', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    const origin = snapshotProvisionalRecoveryOrigin({
      ...process,
      provisional: process.provisional!,
    });
    const changes: FindingLedgerEntry[] = [
      { ...process, revision: 2 },
      { ...process, status: 'resolved' },
      {
        ...process,
        provisional: { ...process.provisional!, stableKey: 'replacement-stable' },
      },
      {
        ...process,
        provisional: { ...process.provisional!, lineageKey: 'replacement-lineage' },
      },
      {
        ...process,
        provisional: {
          ...process.provisional!,
          recoveryReviewerStableKey: 'replacement-reviewer',
        },
      },
    ];

    expect(matchesProvisionalRecoveryOrigin(process, origin)).toBe(true);
    expect(changes.every((finding) => !matchesProvisionalRecoveryOrigin(finding, origin))).toBe(true);
  });

  it('increments revision only when WAL epoch normalization changes a provisional and rejects the old recovery origin', () => {
    const process = provisional('F-0001', 'interpretation-interrupted');
    const origin = snapshotProvisionalRecoveryOrigin({
      ...process,
      provisional: process.provisional!,
    });
    const current: FindingLedger = {
      ...ledger([process]),
      interpretations: [{
        interpretationKey: 'interpretation-1',
        baseInterpretationKey: 'interpretation-base-1',
        attemptOrdinal: 1,
        reviewerStableKey: 'reviewer-stable-a',
        lineageKey: process.provisional!.lineageKey,
        candidateEvidenceHash: 'evidence-1',
        canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
        stage: 'ledger_applied',
        startedAt: observation,
        ...completedWalFields('raw-1'),
        promptPreconditions: [],
        appliedAt: observation,
        applicationResult: 'provisional_created',
      }],
    };

    const normalized = syncProvisionalInterpretationEpochs(current, observation);
    const unchanged = syncProvisionalInterpretationEpochs(normalized, observation);

    expect(normalized.findings[0]?.provisional?.interpretationEpochs).toBe(1);
    expect(normalized.findings[0]?.revision).toBe(2);
    expect(matchesProvisionalRecoveryOrigin(normalized.findings[0]!, origin)).toBe(false);
    expect(unchanged).toBe(normalized);
    expect(unchanged.findings[0]).toBe(normalized.findings[0]);
  });

  it('does not consume an interpretation epoch or revision for stale_precondition WAL records', () => {
    const process = provisional('F-0001', 'interpretation-interrupted');
    const current: FindingLedger = {
      ...ledger([process]),
      interpretations: [{
        interpretationKey: 'interpretation-stale',
        baseInterpretationKey: 'interpretation-base-stale',
        attemptOrdinal: 1,
        reviewerStableKey: 'reviewer-stable-a',
        lineageKey: process.provisional!.lineageKey,
        candidateEvidenceHash: 'evidence-stale',
        canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
        stage: 'ledger_applied',
        startedAt: observation,
        ...completedWalFields('raw-stale'),
        promptPreconditions: [],
        appliedAt: observation,
        applicationResult: 'stale_precondition',
      }],
    };

    const normalized = syncProvisionalInterpretationEpochs(current, observation);

    expect(normalized).toBe(current);
    expect(normalized.findings[0]).toBe(current.findings[0]);
    expect(normalized.findings[0]?.provisional?.interpretationEpochs).toBe(0);
    expect(normalized.findings[0]?.revision).toBe(1);
  });

  it('consumes epochs only for the explicit successful ledger application results', () => {
    const base = {
      baseInterpretationKey: 'base',
      attemptOrdinal: 1,
      reviewerStableKey: 'reviewer',
      lineageKey: 'lineage',
      candidateEvidenceHash: 'evidence',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      startedAt: observation,
      reservationToken: 'reservation',
      promptPreconditions: [],
    };
    const validatedDecision = {
      decision: 'provisional' as const,
      rawFindingId: 'raw-1',
      reason: 'Still ambiguous.',
    };
    const records: FindingLedger['interpretations'] = [
      { ...base, interpretationKey: 'started', stage: 'interpretation_started' },
      {
        ...base,
        interpretationKey: 'interrupted',
        stage: 'interpretation_interrupted',
        interruptedAt: observation,
      },
      {
        ...base,
        interpretationKey: 'completed',
        stage: 'interpretation_completed',
        completedAt: observation,
        validatedDecision,
      },
      {
        ...base,
        interpretationKey: 'stale',
        stage: 'ledger_applied',
        completedAt: observation,
        validatedDecision,
        appliedAt: observation,
        applicationResult: 'stale_precondition',
      },
    ];
    for (const applicationResult of [
      'created',
      'matched_with_proof',
      'conflict_created',
      'provisional_created',
      'provisional_updated',
    ] as const) {
      records.push({
        ...base,
        interpretationKey: applicationResult,
        stage: 'ledger_applied',
        completedAt: observation,
        validatedDecision,
        appliedAt: observation,
        applicationResult,
      });
    }

    const current = { ...ledger([]), interpretations: records };
    expect(countInterpretationEpochs({
      ...current,
      interpretations: records.slice(0, 4),
    }, 'lineage')).toBe(0);
    expect(countInterpretationEpochs(current, 'lineage')).toBe(5);
  });

  it('increments revision for a rejected observation attachment and rejects a pre-attachment precondition', () => {
    const process = provisional('F-0001', 'raw-meaning-ambiguous');
    const current = ledger([process], [raw('rejected-raw-1')]);
    const captured = captureFindingPreconditions(current).get(process.id)!;

    const attached = applyRejectedObservationAttachments(
      current,
      [{
        targetFindingId: process.id,
        rawFindingId: 'rejected-raw-1',
        reason: 'source quote did not match',
        rejectionCode: 'evidence_admission_failed',
      }],
      observation,
    );

    expect(attached.findings[0]?.revision).toBe(2);
    expect(checkFindingPrecondition({
      captured,
      freshLedger: attached,
      expectedStatuses: ['open'],
    })).toMatchObject({
      outcome: 'stale',
      detail: expect.stringContaining('revision changed from 1 to 2'),
    });
  });

  it('treats absent reviewer provenance becoming the provisional stable key as an origin identity change', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    const {
      recoveryReviewerStableKey: _recoveryReviewerStableKey,
      ...withoutReviewerProvenance
    } = process.provisional!;
    const withoutReviewer = {
      ...process,
      provisional: withoutReviewerProvenance,
    };
    const origin = snapshotProvisionalRecoveryOrigin(withoutReviewer);
    const explicitReviewer = {
      ...withoutReviewer,
      provisional: {
        ...withoutReviewer.provisional,
        recoveryReviewerStableKey: withoutReviewer.provisional.stableKey,
      },
    };

    expect(origin.expectedRecoveryReviewerStableKey).toBeUndefined();
    expect(origin).not.toHaveProperty('expectedRecoveryReviewerStableKey');
    expect(() => canonicalJson(origin)).not.toThrow();
    expect(matchesProvisionalRecoveryOrigin(withoutReviewer, origin)).toBe(true);
    expect(matchesProvisionalRecoveryOrigin(explicitReviewer, origin)).toBe(false);
  });

  it('does not synthesize interpretation reviewer provenance from the provisional stable key', () => {
    const process = provisional('F-0001', 'manager-budget-exhausted');
    const {
      recoveryReviewerStableKey: _recoveryReviewerStableKey,
      ...withoutReviewerProvenance
    } = process.provisional!;
    process.provisional = {
      ...withoutReviewerProvenance,
      interpretationEpochs: 1,
    };

    const previousLedger = ledger([process], [raw('source-1')]);
    const plan = collectInterpretationRecoveryPlan({
      ledger: previousLedger,
      currentItems: [],
      roundsCompleted: 1,
    });

    expect(plan.items).toEqual([]);
    expect(plan.failures).toEqual([
      expect.objectContaining({
        kind: 'reviewer_provenance_missing',
        outcome: 'audit_only',
        sourceRawFindingId: 'source-1',
      }),
    ]);
    const mutation = buildFindingManagerCommitMutation(emptyCommitPlanInput({
      previousLedger,
      interpretationRecoveryFailures: plan.failures,
    }), previousLedger);
    expect(mutation.result.rawFindingDispositions).toEqual([{
      rawFindingId: 'source-1',
      outcome: 'audit_only',
      reason: expect.stringContaining('reviewer provenance'),
    }]);
    expect(mutation.result.interpretationRecoverySettlements).toEqual([{
      provisionalFindingId: 'F-0001',
      sourceRawFindingId: 'source-1',
      outcome: 'audit_only',
      failureKind: 'reviewer_provenance_missing',
      reason: expect.stringContaining('reviewer provenance'),
    }]);
  });

  it('records a source-missing interpretation recovery as one report-only finite outcome', () => {
    const process = provisional('F-0001', 'interpretation-interrupted');
    process.provisional = {
      ...process.provisional!,
      sourceRawFindingIds: ['missing-source'],
      interpretationEpochs: 1,
    };
    const previousLedger = ledger([process]);
    const plan = collectInterpretationRecoveryPlan({
      ledger: previousLedger,
      currentItems: [],
      roundsCompleted: 1,
    });

    expect(plan.items).toEqual([]);
    expect(plan.failures).toEqual([
      expect.objectContaining({
        kind: 'source_missing',
        outcome: 'audit_only',
        sourceRawFindingId: 'missing-source',
      }),
    ]);

    const mutation = buildFindingManagerCommitMutation(emptyCommitPlanInput({
      previousLedger,
      interpretationRecoveryFailures: plan.failures,
    }), previousLedger);

    expect(mutation.ledger.rawFindings).toEqual([]);
    expect(mutation.result.rawFindingDispositions).toEqual([{
      rawFindingId: 'missing-source',
      outcome: 'audit_only',
      reason: expect.stringContaining('missing raw finding'),
    }]);
    expect(mutation.result.interpretationRecoverySettlements).toEqual([{
      provisionalFindingId: 'F-0001',
      sourceRawFindingId: 'missing-source',
      outcome: 'audit_only',
      failureKind: 'source_missing',
      reason: expect.stringContaining('missing raw finding'),
    }]);
  });

  it('fans one missing source payload out to every provisional recovery origin exactly once', () => {
    const first = provisional('F-0001', 'interpretation-interrupted');
    const second = provisional('F-0002', 'interpretation-interrupted');
    first.provisional = {
      ...first.provisional!,
      sourceRawFindingIds: ['shared-missing-source'],
      interpretationEpochs: 1,
    };
    second.provisional = {
      ...second.provisional!,
      sourceRawFindingIds: ['shared-missing-source'],
      interpretationEpochs: 1,
    };
    const previousLedger = ledger([first, second]);
    const plan = collectInterpretationRecoveryPlan({
      ledger: previousLedger,
      currentItems: [],
      roundsCompleted: 1,
    });

    expect(plan.failures).toHaveLength(2);
    const mutation = buildFindingManagerCommitMutation(emptyCommitPlanInput({
      previousLedger,
      interpretationRecoveryFailures: plan.failures,
    }), previousLedger);

    expect(mutation.ledger.interpretations.filter((record) => (
      record.stage === 'interpretation_retryable_failure'
      || record.stage === 'interpretation_terminal_failure'
    )).map((record) => ({
      id: record.stage === 'interpretation_retryable_failure'
        || record.stage === 'interpretation_terminal_failure'
        ? record.provisionalFindingId
        : '',
      sourceRawFindingId: record.stage === 'interpretation_retryable_failure'
        || record.stage === 'interpretation_terminal_failure'
        ? record.sourceRawFindingId
        : '',
      reason: record.stage === 'interpretation_retryable_failure'
        || record.stage === 'interpretation_terminal_failure'
        ? record.failureReason
        : '',
    }))).toEqual([
      {
        id: 'F-0001',
        sourceRawFindingId: 'shared-missing-source',
        reason: expect.stringContaining('missing raw finding'),
      },
      {
        id: 'F-0002',
        sourceRawFindingId: 'shared-missing-source',
        reason: expect.stringContaining('missing raw finding'),
      },
    ]);
    expect(mutation.result.rawFindingDispositions).toEqual([{
      rawFindingId: 'shared-missing-source',
      outcome: 'audit_only',
      reason: expect.stringContaining('missing raw finding'),
    }]);
    expect(mutation.result.interpretationRecoverySettlements).toEqual([
      {
        provisionalFindingId: 'F-0001',
        sourceRawFindingId: 'shared-missing-source',
        outcome: 'audit_only',
        failureKind: 'source_missing',
        reason: expect.stringContaining('missing raw finding'),
      },
      {
        provisionalFindingId: 'F-0002',
        sourceRawFindingId: 'shared-missing-source',
        outcome: 'audit_only',
        failureKind: 'source_missing',
        reason: expect.stringContaining('missing raw finding'),
      },
    ]);
  });

  it('processes one stored raw payload once and carries every provisional recovery origin', () => {
    const cwd = process.cwd();
    const quote = verifiedSourceQuoteFields(
      cwd,
      'src/core/workflow/findings/interpretation-recovery.ts',
      1,
    );
    const first = provisional('F-0001', 'interpretation-interrupted', quote.path);
    const second = provisional('F-0002', 'interpretation-interrupted', quote.path);
    first.provisional = {
      ...first.provisional!,
      interpretationEpochs: 1,
    };
    second.provisional = {
      ...second.provisional!,
      interpretationEpochs: 1,
    };

    const sourceWithoutEvidence = stampTargetPrecondition({
      ...raw('source-1', quote.path),
      relation: 'persists' as const,
      targetFindingId: first.id,
    }, ledger([first, second]));
    const sharedSource: RawFinding = {
      ...sourceWithoutEvidence,
      evidence: deduplicateRawEvidence([quote]),
    };
    alignRecoveryLineageWithStoredRaw(first, sharedSource);
    alignRecoveryLineageWithStoredRaw(second, sharedSource);
    const lineageAlignedLedger = ledger([first, second], [sharedSource]);
    const refreshedSharedSource = stampTargetPrecondition(
      sharedSource,
      lineageAlignedLedger,
    );
    const authorizedPreviousLedger = ledger([first, second], [refreshedSharedSource]);
    const previousLedger = authorizedPreviousLedger;
    const plan = collectInterpretationRecoveryPlan({
      ledger: previousLedger,
      currentItems: [],
      roundsCompleted: 1,
    });

    expect(plan.failures).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      wire: { rawFindingId: 'source-1' },
      interpretationRecoveryAttempt: true,
      recoveryOrigins: [
        { provisionalFindingId: 'F-0001' },
        { provisionalFindingId: 'F-0002' },
      ],
    });

    const ladderAfterOneDecision: LadderResult = {
      interpretationReservations: new Map(),
      interpretationIntegrityDigests: new Map(),
      integrityStaleInterpretationKeys: new Set(),
      deferredRawFindingIds: new Set(),
      pendingSameWithProof: [],
      pendingIndependentNew: [{
        wire: plan.items[0]!.wire,
        canonical: plan.items[0]!.canonical,
        recoveryOrigins: plan.items[0]!.recoveryOrigins,
        interpretationRecoveryAttempt: true,
      }],
      pendingConflicts: [],
      provisionalSpecs: [],
      provisionalByInterpretationKey: new Map(),
      pendingAppliedReattach: [],
      recoveryProvisionalOrigins: new Map(),
      stats: {} as LadderResult['stats'],
    };

    const commitPlan = buildLadderCommitPlan(
      ladderAfterOneDecision,
      previousLedger,
      new Set(),
    );
    expect(commitPlan.output.matches).toEqual([]);
    expect(commitPlan.recoveryPromotions).toEqual(new Set());
    expect(commitPlan.recoverySettlements).toEqual(new Map());

    const baseCommitInput = emptyCommitPlanInput({
      previousLedger,
      intake: {
        ...emptyCommitPlanInput().intake,
        items: plan.items,
      },
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot: emptyReviewScopeSnapshot(quote.snapshotId),
    });
    const mutation = buildFindingManagerCommitMutation({
      ...baseCommitInput,
      input: {
        ...baseCommitInput.input,
        cwd,
      },
      managerDecision: {
        ...baseCommitInput.managerDecision,
        ladder: ladderAfterOneDecision,
      },
    }, previousLedger);
    expect(mutation.ledger.findings.map((finding) => ({
      id: finding.id,
      status: finding.status,
      provisional: finding.provisional?.kind,
      resolvedEvidence: finding.resolvedEvidence,
    }))).toEqual([
      {
        id: 'F-0001',
        status: 'open',
        provisional: 'interpretation-interrupted',
        resolvedEvidence: undefined,
      },
      {
        id: 'F-0002',
        status: 'open',
        provisional: 'interpretation-interrupted',
        resolvedEvidence: undefined,
      },
      {
        id: 'F-0020',
        status: 'open',
        provisional: undefined,
        resolvedEvidence: undefined,
      },
    ]);
    const retained = mutation.ledger.findings.find((finding) => finding.id === 'F-0001');
    expect(retained?.provisional).toBeDefined();
    expect(mutation.ledger.evidenceRecords.map((record) => record.evidenceId).sort())
      .toEqual([...new Set(
        mutation.ledger.findings.flatMap((finding) => finding.evidenceIds),
      )].sort());
    expect(mutation.ledger.evidenceRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file_quote', path: quote.path }),
    ]));
  });

  it('adjudicates a shared raw once while settling a provenance failure and a valid origin independently', () => {
    const missingProvenance = provisional('F-0001', 'interpretation-interrupted');
    const validOrigin = provisional('F-0002', 'interpretation-interrupted');
    missingProvenance.provisional = {
      ...missingProvenance.provisional!,
      interpretationEpochs: 1,
      recoveryReviewerStableKey: undefined,
    };
    validOrigin.provisional = {
      ...validOrigin.provisional!,
      interpretationEpochs: 1,
    };
    const sharedSource = raw('shared-provenance-source');
    missingProvenance.provisional.sourceRawFindingIds = [sharedSource.rawFindingId];
    validOrigin.provisional.sourceRawFindingIds = [sharedSource.rawFindingId];
    alignRecoveryLineageWithStoredRaw(validOrigin, sharedSource);
    const previousLedger = ledger([missingProvenance, validOrigin], [sharedSource]);
    const recovery = collectInterpretationRecoveryPlan({
      ledger: previousLedger,
      currentItems: [],
      roundsCompleted: 1,
    });
    const item = recovery.items[0]!;
    const params = emptyCommitPlanInput({
      previousLedger,
      intake: {
        ...emptyCommitPlanInput().intake,
        items: recovery.items,
      },
      interpretationRecoveryFailures: recovery.failures,
      managerDecision: {
        ...emptyCommitPlanInput().managerDecision,
        cleanWireById: new Map([[item.wire.rawFindingId, item.wire]]),
        cleanCanonicalById: new Map([[item.canonical.rawFindingId, item.canonical]]),
        ladder: {
          ...emptyCommitPlanInput().managerDecision.ladder,
          pendingIndependentNew: [{
            wire: item.wire,
            recoveryOrigins: item.recoveryOrigins,
            interpretationRecoveryAttempt: true,
          }],
        },
      },
      stopBudgetRoundMarker: 'round-mixed-provenance',
    });

    const mutation = buildFindingManagerCommitMutation(params, previousLedger);

    expect(mutation.result.applied).toBe(true);
    expect(mutation.ledger.interpretations).toContainEqual(expect.objectContaining({
      provisionalFindingId: missingProvenance.id,
      sourceRawFindingId: sharedSource.rawFindingId,
      stage: expect.stringMatching(/^interpretation_(?:retryable|terminal)_failure$/u),
    }));
    expect(mutation.ledger.rawFindings.filter(
      (rawFinding) => rawFinding.rawFindingId === sharedSource.rawFindingId,
    )).toHaveLength(1);
    expect(mutation.result.rawFindingDispositions).not.toContainEqual(
      expect.objectContaining({ rawFindingId: sharedSource.rawFindingId }),
    );
    expect(mutation.result.interpretationRecoverySettlements).toEqual([
      expect.objectContaining({
        provisionalFindingId: missingProvenance.id,
        outcome: 'audit_only',
        failureKind: 'reviewer_provenance_missing',
      }),
      expect.objectContaining({
        provisionalFindingId: validOrigin.id,
        outcome: 'retained',
      }),
    ]);
  });

  it('partitions stale and fresh origins under one raw without promoting a relation=new recovery', () => {
    const staleOriginFinding = provisional('F-0001', 'interpretation-interrupted');
    const freshOriginFinding = provisional('F-0002', 'interpretation-interrupted');
    staleOriginFinding.provisional = {
      ...staleOriginFinding.provisional!,
      interpretationEpochs: 1,
    };
    freshOriginFinding.provisional = {
      ...freshOriginFinding.provisional!,
      interpretationEpochs: 1,
    };
    const sharedSource = raw('shared-stale-source');
    staleOriginFinding.provisional.sourceRawFindingIds = [sharedSource.rawFindingId];
    freshOriginFinding.provisional.sourceRawFindingIds = [sharedSource.rawFindingId];
    alignRecoveryLineageWithStoredRaw(staleOriginFinding, sharedSource);
    alignRecoveryLineageWithStoredRaw(freshOriginFinding, sharedSource);
    const previousLedger = ledger([staleOriginFinding, freshOriginFinding], [sharedSource]);
    const recovery = collectInterpretationRecoveryPlan({
      ledger: previousLedger,
      currentItems: [],
      roundsCompleted: 1,
    });
    const item = recovery.items[0]!;
    const freshLedger = {
      ...previousLedger,
      findings: previousLedger.findings.map((finding) => (
        finding.id === staleOriginFinding.id
          ? { ...finding, revision: finding.revision + 1 }
          : finding
      )),
    };
    const params = emptyCommitPlanInput({
      previousLedger,
      intake: {
        ...emptyCommitPlanInput().intake,
        items: recovery.items,
      },
      managerDecision: {
        ...emptyCommitPlanInput().managerDecision,
        cleanWireById: new Map([[item.wire.rawFindingId, item.wire]]),
        cleanCanonicalById: new Map([[item.canonical.rawFindingId, item.canonical]]),
        ladder: {
          ...emptyCommitPlanInput().managerDecision.ladder,
          pendingIndependentNew: [{
            wire: item.wire,
            recoveryOrigins: item.recoveryOrigins,
            interpretationRecoveryAttempt: true,
          }],
        },
      },
      stopBudgetRoundMarker: 'round-partial-stale-origin',
    });

    const mutation = buildFindingManagerCommitMutation(params, freshLedger);

    expect(mutation.ledger.rawFindings.filter(
      (rawFinding) => rawFinding.rawFindingId === sharedSource.rawFindingId,
    )).toHaveLength(1);
    expect(mutation.ledger.findings.find((finding) => finding.id === freshOriginFinding.id)?.provisional)
      .toBeDefined();
    expect(mutation.ledger.findings.find((finding) => finding.id === staleOriginFinding.id)?.provisional)
      .toBeDefined();
    expect(mutation.result.interpretationRecoverySettlements).toEqual([
      expect.objectContaining({
        provisionalFindingId: staleOriginFinding.id,
        outcome: 'stale',
      }),
      expect.objectContaining({
        provisionalFindingId: freshOriginFinding.id,
        outcome: 'retained',
      }),
    ]);
  });

  it('isolates shared raw recovery origins with different reviewer provenance', () => {
    const first = provisional('F-0001', 'interpretation-interrupted');
    const second = provisional('F-0002', 'interpretation-interrupted');
    first.provisional = {
      ...first.provisional!,
      interpretationEpochs: 1,
      recoveryReviewerStableKey: 'reviewer-stable-a',
    };
    second.provisional = {
      ...second.provisional!,
      interpretationEpochs: 1,
      recoveryReviewerStableKey: 'reviewer-stable-b',
    };
    const sharedSource = raw('shared-reviewer-source');
    first.provisional.sourceRawFindingIds = [sharedSource.rawFindingId];
    second.provisional.sourceRawFindingIds = [sharedSource.rawFindingId];
    alignRecoveryLineageWithStoredRaw(first, sharedSource);
    alignRecoveryLineageWithStoredRaw(second, sharedSource);

    const recovery = collectInterpretationRecoveryPlan({
      ledger: ledger([first, second], [sharedSource]),
      currentItems: [],
      roundsCompleted: 1,
    });

    expect(recovery.items).toEqual([]);
    expect(recovery.failures).toEqual([
      expect.objectContaining({
        kind: 'recovery_contract_mismatch',
        recoveryOrigin: expect.objectContaining({ provisionalFindingId: first.id }),
      }),
      expect.objectContaining({
        kind: 'recovery_contract_mismatch',
        recoveryOrigin: expect.objectContaining({ provisionalFindingId: second.id }),
      }),
    ]);
  });

  it('records a changed interpretation recovery origin as one stale outcome without applying the old failure', () => {
    const process = provisional('F-0001', 'interpretation-interrupted');
    process.provisional = {
      ...process.provisional!,
      sourceRawFindingIds: ['missing-source'],
      interpretationEpochs: 1,
    };
    const previousLedger = ledger([process]);
    const plan = collectInterpretationRecoveryPlan({
      ledger: previousLedger,
      currentItems: [],
      roundsCompleted: 1,
    });
    const freshLedger = ledger([{
      ...process,
      revision: process.revision + 1,
    }]);

    const mutation = buildFindingManagerCommitMutation(emptyCommitPlanInput({
      previousLedger,
      interpretationRecoveryFailures: plan.failures,
    }), freshLedger);

    expect(mutation.ledger.rawRecoveryAttempts).toEqual(freshLedger.rawRecoveryAttempts);
    expect(mutation.result.rawFindingDispositions).toEqual([{
      rawFindingId: 'missing-source',
      outcome: 'stale',
      reason: expect.stringContaining('origin changed'),
    }]);
    expect(mutation.result.interpretationRecoverySettlements).toEqual([{
      provisionalFindingId: 'F-0001',
      sourceRawFindingId: 'missing-source',
      outcome: 'stale',
      reason: expect.stringContaining('origin changed'),
    }]);
  });

  it('does not apply an interpretation recovery failure after provisional identity changes at the same revision', () => {
    const process = provisional('F-0001', 'interpretation-interrupted');
    process.provisional = {
      ...process.provisional!,
      sourceRawFindingIds: ['missing-source'],
      interpretationEpochs: 1,
    };
    const plan = collectInterpretationRecoveryPlan({
      ledger: ledger([process]),
      currentItems: [],
      roundsCompleted: 1,
    });
    expect(plan.failures).toHaveLength(1);

    const replaced: FindingLedgerEntry = {
      ...process,
      provisional: {
        ...process.provisional,
        stableKey: 'replacement-stable',
        lineageKey: 'replacement-lineage',
        recoveryReviewerStableKey: 'replacement-reviewer',
      },
    };
    const fresh = ledger([replaced]);
    const applied = applyInterpretationRecoveryFailures({
      ledger: fresh,
      failures: plan.failures,
      observation,
    });

    expect(applied.findings).toEqual(fresh.findings);
    expect(applied.interpretations).toEqual([
      ...fresh.interpretations,
      expect.objectContaining({
        provisionalFindingId: process.id,
        sourceRawFindingId: 'missing-source',
        stage: 'interpretation_retryable_failure',
      }),
    ]);
  });

  it('promotes a relation=new replay through its verified provisional origin', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    const source = raw('source-1');
    const freshLedger = ledger([process], [source]);
    const replay = { ...source, rawFindingId: 'replay-1' };
    const origin = rawRecoveryOrigin(
      freshLedger,
      process,
      source.rawFindingId,
    );
    const settlement = settleProvisionalsWithCleanEvidence({
      output: {
        ...emptyOutput(),
        newFindings: [{
          rawFindingIds: [replay.rawFindingId],
          title: replay.title,
          severity: replay.severity,
        }],
      },
      cleanRawIds: new Set([replay.rawFindingId]),
      wireById: new Map([[replay.rawFindingId, replay]]),
      freshLedger,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map([[replay.rawFindingId, {
        replayRawFindingId: replay.rawFindingId,
        attemptId: origin.attemptId,
        sourceRawFindingId: origin.sourceRawFindingId,
        sourceRawIntegrityDigest: origin.sourceRawIntegrityDigest!,
        expectedHead: origin.expectedHead,
        attempt: origin.attempt,
        recoveryOrigin: origin.recoveryOrigin,
      }]]),
    });

    expect(settlement.output.newFindings).toEqual([]);
    expect(settlement.output.matches).toEqual([
      expect.objectContaining({
        findingId: process.id,
        rawFindingIds: [replay.rawFindingId],
      }),
    ]);
    expect(settlement.promotedFindingIds).toEqual(new Set([process.id]));
    expect(settlement.settledReplayRawIds).toEqual(
      new Set([replay.rawFindingId]),
    );
  });

  it('merges compatible replay origins into the canonical provisional target', () => {
    const firstSource = raw('source-p1');
    const secondSource = raw('source-p2');
    const first = provisional('F-0001', 'raw-adjudication-unresolved');
    const second = provisional('F-0002', 'raw-adjudication-unresolved');
    first.rawFindingIds = [firstSource.rawFindingId];
    first.provisional!.sourceRawFindingIds = [firstSource.rawFindingId];
    second.rawFindingIds = [secondSource.rawFindingId];
    second.provisional!.sourceRawFindingIds = [secondSource.rawFindingId];
    const freshLedger = ledger([first, second], [firstSource, secondSource]);
    const firstReplay = { ...firstSource, rawFindingId: 'replay-p1' };
    const secondReplay = { ...secondSource, rawFindingId: 'replay-p2' };
    const firstOrigin = rawRecoveryOrigin(
      freshLedger,
      first,
      firstSource.rawFindingId,
    );
    const secondOrigin = rawRecoveryOrigin(
      freshLedger,
      second,
      secondSource.rawFindingId,
    );
    const settlement = settleProvisionalsWithCleanEvidence({
      output: {
        ...emptyOutput(),
        newFindings: [{
          rawFindingIds: [firstReplay.rawFindingId, secondReplay.rawFindingId],
          title: firstReplay.title,
          severity: firstReplay.severity,
        }],
      },
      cleanRawIds: new Set([firstReplay.rawFindingId, secondReplay.rawFindingId]),
      wireById: new Map([
        [firstReplay.rawFindingId, firstReplay],
        [secondReplay.rawFindingId, secondReplay],
      ]),
      freshLedger,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map([
        [firstReplay.rawFindingId, {
          replayRawFindingId: firstReplay.rawFindingId,
          attemptId: firstOrigin.attemptId,
          sourceRawFindingId: firstOrigin.sourceRawFindingId,
          sourceRawIntegrityDigest: firstOrigin.sourceRawIntegrityDigest!,
          expectedHead: firstOrigin.expectedHead,
          attempt: firstOrigin.attempt,
          recoveryOrigin: firstOrigin.recoveryOrigin,
        }],
        [secondReplay.rawFindingId, {
          replayRawFindingId: secondReplay.rawFindingId,
          attemptId: secondOrigin.attemptId,
          sourceRawFindingId: secondOrigin.sourceRawFindingId,
          sourceRawIntegrityDigest: secondOrigin.sourceRawIntegrityDigest!,
          expectedHead: secondOrigin.expectedHead,
          attempt: secondOrigin.attempt,
          recoveryOrigin: secondOrigin.recoveryOrigin,
        }],
      ]),
    });

    expect(settlement.output.newFindings).toEqual([]);
    expect(settlement.output.matches).toEqual([
      expect.objectContaining({
        findingId: first.id,
        rawFindingIds: [firstReplay.rawFindingId, secondReplay.rawFindingId],
      }),
    ]);
    expect(settlement.promotedFindingIds).toEqual(new Set([first.id]));
    expect(settlement.resolvedByMapping).toEqual(new Map([[second.id, first.id]]));
    expect(settlement.settledReplayRawIds).toEqual(
      new Set([firstReplay.rawFindingId, secondReplay.rawFindingId]),
    );
    expect(settlement.rejectedObservationAttachments).toEqual([]);
  });

  it('does not let a replay origin for one provisional authorize a different provisional match', () => {
    const originFinding = provisional('F-0001', 'raw-adjudication-unresolved');
    const otherFinding = provisional('F-0002', 'raw-adjudication-unresolved');
    const source = raw('source-1');
    const freshLedger = ledger([originFinding, otherFinding], [source]);
    const replay = { ...source, rawFindingId: 'replay-for-origin-only' };
    const origin = rawRecoveryOrigin(
      freshLedger,
      originFinding,
      source.rawFindingId,
    );
    const settlement = settleProvisionalsWithCleanEvidence({
      output: {
        ...emptyOutput(),
        matches: [{
          findingId: otherFinding.id,
          rawFindingIds: [replay.rawFindingId],
          evidence: 'The manager associated the replay with another provisional.',
        }],
      },
      cleanRawIds: new Set([replay.rawFindingId]),
      wireById: new Map([[replay.rawFindingId, replay]]),
      freshLedger,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map([[replay.rawFindingId, {
        replayRawFindingId: replay.rawFindingId,
        attemptId: origin.attemptId,
        sourceRawFindingId: origin.sourceRawFindingId,
        sourceRawIntegrityDigest: origin.sourceRawIntegrityDigest!,
        expectedHead: origin.expectedHead,
        attempt: origin.attempt,
        recoveryOrigin: origin.recoveryOrigin,
      }]]),
    });

    expect(settlement.output.matches).toEqual([]);
    expect(settlement.promotedFindingIds).toEqual(new Set());
    expect(settlement.resolvedByMapping).toEqual(new Map());
    expect(settlement.settledReplayRawIds).toEqual(new Set());
    expect(settlement.rejectedObservationAttachments).toEqual([
      expect.objectContaining({
        targetFindingId: otherFinding.id,
        rawFindingId: replay.rawFindingId,
        rejectionCode: 'evidence_admission_failed',
      }),
    ]);

    const applied = applyProvisionalSettlement({
      ...freshLedger,
      rawFindings: [...freshLedger.rawFindings, replay],
    }, settlement, observation.timestamp);
    expect(applied.findings.find((finding) => finding.id === originFinding.id))
      .toEqual(freshLedger.findings.find((finding) => finding.id === originFinding.id));
    expect(applied.findings.find((finding) => finding.id === otherFinding.id))
      .toEqual(freshLedger.findings.find((finding) => finding.id === otherFinding.id));
  });

  it('recognizes a clean resolution confirmation as direct provisional settlement', () => {
    const processFinding = provisional('F-0001', 'raw-adjudication-unresolved');
    const freshLedger = ledger([processFinding], [raw('source-1')]);
    const confirmation = canonicalRawFindingFixture({
      rawFindingId: 'confirmation-1',
      stepName: 'reviewer-a',
      reviewer: 'reviewer-a',
      familyTag: null,
      severity: null,
      title: null,
      description: null,
      suggestion: null,
      relation: 'resolution_confirmation',
      targetFindingId: processFinding.id,
      targetPrecondition: captureFindingPreconditions(freshLedger)
        .get(processFinding.id)!.precondition,
      target: processFinding.target!,
      evidence: [],
    });
    const output = {
      ...emptyOutput(),
      resolvedFindings: [{
        findingId: processFinding.id,
        rawFindingIds: [confirmation.rawFindingId],
        evidence: 'Verified resolution confirmation',
      }],
    };
    const settlement = settleProvisionalsWithCleanEvidence({
      output,
      cleanRawIds: new Set([confirmation.rawFindingId]),
      wireById: new Map([[confirmation.rawFindingId, confirmation]]),
      freshLedger,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map(),
    });

    expect(settlement.resolvedByEvidence).toEqual(new Map([
      [processFinding.id, 'Verified resolution confirmation'],
    ]));
    expect(settlement.output.resolvedFindings).toEqual(output.resolvedFindings);
  });

  it('keeps normal targeted persists promotion authority unchanged', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    process.severity = null;
    process.title = null;
    delete process.description;
    const source = canonicalRawFindingFixture({
      ...raw('source-1'),
      familyTag: null,
      severity: null,
      title: null,
      description: null,
      suggestion: null,
      target: process.target!,
    });
    const freshLedger = ledger([process], [source]);
    delete freshLedger.findings[0]!.description;
    const targetPrecondition = captureFindingPreconditions(freshLedger)
      .get(process.id)!.precondition;
    const replay = canonicalRawFindingFixture({
      rawFindingId: 'replay-targeted',
      stepName: 'reviewer-a',
      reviewer: 'reviewer-a',
      familyTag: 'bug',
      severity: 'high',
      title: 'Confirmed state transition defect',
      description: 'The clean replay establishes the complete product claim.',
      suggestion: null,
      relation: 'persists',
      targetFindingId: process.id,
      targetPrecondition,
      target: process.target!,
      evidence: [],
    });
    const settlement = settleProvisionalsWithCleanEvidence({
      output: {
        ...emptyOutput(),
        matches: [{
          findingId: process.id,
          rawFindingIds: [replay.rawFindingId],
          evidence: 'The clean observation confirms the provisional target.',
        }],
      },
      cleanRawIds: new Set([replay.rawFindingId]),
      wireById: new Map([[replay.rawFindingId, replay]]),
      freshLedger,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map(),
    });

    expect(settlement.output.newFindings).toEqual([]);
    expect(settlement.output.matches).toEqual([
      expect.objectContaining({ findingId: process.id, rawFindingIds: [replay.rawFindingId] }),
    ]);
    expect(settlement.promotedFindingIds).toEqual(new Set([process.id]));
    expect(settlement.promotionSourceRawFindingIds).toEqual(new Map([
      [process.id, [replay.rawFindingId]],
    ]));
    expect(settlement.settledReplayRawIds).toEqual(new Set());

    const applied = applyProvisionalSettlement({
      ...freshLedger,
      rawFindings: [...freshLedger.rawFindings, replay],
    }, settlement, observation.timestamp);
    expect(applied.findings[0]).toMatchObject({
      id: process.id,
      severity: 'high',
      title: 'Confirmed state transition defect',
      description: 'The clean replay establishes the complete product claim.',
      targetIdentityHash: replay.targetIdentityHash,
      claimIdentityHash: replay.claimIdentityHash,
      semanticClaimIdentityHash: replay.semanticClaimIdentityHash,
      revision: 2,
    });
    expect(applied.findings[0]?.provisional).toBeUndefined();
  });

  it('keeps a provisional when multiple clean promotion sources disagree on the claim identity', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    process.severity = null;
    process.title = null;
    delete process.description;
    const freshLedger = ledger([process], [raw('source-1')]);
    const targetPrecondition = captureFindingPreconditions(freshLedger)
      .get(process.id)!.precondition;
    const first = canonicalRawFindingFixture({
      rawFindingId: 'replay-first-claim',
      stepName: 'reviewer-a',
      reviewer: 'reviewer-a',
      familyTag: 'bug',
      severity: 'high',
      title: 'First complete claim',
      description: 'The first clean replay describes one product defect.',
      suggestion: null,
      relation: 'persists',
      targetFindingId: process.id,
      targetPrecondition,
      target: process.target!,
      evidence: [],
    });
    const second = canonicalRawFindingFixture({
      rawFindingId: 'replay-second-claim',
      stepName: 'reviewer-b',
      reviewer: 'reviewer-b',
      familyTag: 'bug',
      severity: 'medium',
      title: 'Second complete claim',
      description: 'The second clean replay describes a different product defect.',
      suggestion: null,
      relation: 'persists',
      targetFindingId: process.id,
      targetPrecondition,
      target: process.target!,
      evidence: [],
    });

    const settlement = settleProvisionalsWithCleanEvidence({
      output: emptyOutput(),
      cleanRawIds: new Set([first.rawFindingId, second.rawFindingId]),
      wireById: new Map([
        [first.rawFindingId, first],
        [second.rawFindingId, second],
      ]),
      freshLedger,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set([process.id]),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map(),
    });

    expect(settlement.promotedFindingIds).toEqual(new Set());
    expect(settlement.promotionSourceRawFindingIds).toEqual(new Map());
    const applied = applyProvisionalSettlement({
      ...freshLedger,
      rawFindings: [...freshLedger.rawFindings, first, second],
    }, settlement, observation.timestamp);
    expect(applied.findings[0]).toMatchObject({
      id: process.id,
      severity: null,
      title: null,
      provisional: {
        gateEffect: 'block',
      },
      revision: 1,
    });
  });

  it('keeps a provisional when its only clean promotion source has an incomplete claim', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    process.severity = null;
    process.title = null;
    const freshLedger = ledger([process], [raw('source-1')]);
    const incomplete = canonicalRawFindingFixture({
      rawFindingId: 'replay-incomplete-claim',
      stepName: 'reviewer-a',
      reviewer: 'reviewer-a',
      familyTag: null,
      severity: null,
      title: null,
      description: 'The replay still lacks the fields required for a product claim.',
      suggestion: null,
      relation: 'persists',
      targetFindingId: process.id,
      targetPrecondition: captureFindingPreconditions(freshLedger)
        .get(process.id)!.precondition,
      target: process.target!,
      evidence: [],
    });
    const settlement = settleProvisionalsWithCleanEvidence({
      output: emptyOutput(),
      cleanRawIds: new Set([incomplete.rawFindingId]),
      wireById: new Map([[incomplete.rawFindingId, incomplete]]),
      freshLedger,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set([process.id]),
      healthyReviewerStableKeys: new Set(),
      replayOrigins: new Map(),
    });

    expect(settlement.promotedFindingIds).toEqual(new Set());
    expect(settlement.promotionSourceRawFindingIds).toEqual(new Map());
  });

  it('commits a targeted persists replay promotion through the lifecycle transaction', () => {
    const cwd = process.cwd();
    const quote = verifiedSourceQuoteFields(
      cwd,
      'src/core/workflow/findings/manager-replay-settlement.ts',
      1,
    );
    const processFinding = provisional(
      'F-0001',
      'raw-adjudication-unresolved',
      quote.path,
    );
    const source = raw('source-1', quote.path);
    const initialLedger = ledger([processFinding], [source]);
    const replayDraft = canonicalRawFindingFixture({
      rawFindingId: 'replay-targeted-commit',
      stepName: 'reviewer-a',
      reviewer: 'reviewer-a',
      familyTag: 'bug',
      severity: 'high',
      title: processFinding.title,
      description: processFinding.description!,
      suggestion: null,
      relation: 'persists',
      targetFindingId: processFinding.id,
      targetPrecondition: captureFindingPreconditions(initialLedger)
        .get(processFinding.id)!.precondition,
      target: processFinding.target!,
      evidence: [quote],
    });
    alignRecoveryLineageWithStoredRaw(processFinding, replayDraft);
    const previousLedger = ledger([processFinding], [source]);
    const replay = {
      ...replayDraft,
      targetPrecondition: captureFindingPreconditions(previousLedger)
        .get(processFinding.id)!.precondition,
    };
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(replay, 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const wire = toLedgerRawFinding(canonical);
    const origin = rawRecoveryOrigin(
      previousLedger,
      processFinding,
      source.rawFindingId,
    );
    const rawRecovery = {
      intake: {
        entityBindings: new Map(),
        items: [{
          canonical,
          wire,
          recoveryOrigins: [origin.recoveryOrigin],
          interpretationRecoveryAttempt: true as const,
        }],
        overflowRawFindingIds: new Set<string>(),
        intakeProvisionalSpecs: [],
        intakeAnomalySpecs: [],
        overflowReports: [],
        clarifications: [],
        rawNormalizations: [],
        healthyReviewerStableKeys: new Set<string>(),
      },
      output: {
        ...emptyOutput(),
        anchorAdjudications: [createAnchorAdjudication({
          rawFindingId: wire.rawFindingId,
          decision: 'same',
          findingId: processFinding.id,
          anchorRelevance: 'not_applicable',
          evidence: 'The replay carries direct source evidence for the persisted target.',
        })],
        matches: [{
          findingId: processFinding.id,
          rawFindingIds: [wire.rawFindingId],
          evidence: 'The clean replay confirms that the provisional finding persists.',
        }],
      },
      origins: new Map([[wire.rawFindingId, origin]]),
      failures: new Map(),
      capturedPreconditions: captureFindingPreconditions(previousLedger),
      invalidAttempts: [],
      unsupportedRawFindingReports: [],
      cleanWireById: new Map([[wire.rawFindingId, wire]]),
      cleanCanonicalById: new Map([[canonical.rawFindingId, canonical]]),
      reservationTokens: new Set<string>(),
    };
    const base = emptyCommitPlanInput({
      previousLedger,
      managerDecision: {
        ...emptyCommitPlanInput().managerDecision,
        rawRecovery,
      },
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot: emptyReviewScopeSnapshot(quote.snapshotId),
      stopBudgetRoundMarker: 'round-targeted-replay-commit',
    });
    const mutation = buildFindingManagerCommitMutation({
      ...base,
      input: {
        ...base.input,
        cwd,
      },
    }, previousLedger);
    const proofed = issueManagerLifecycleAuthority({
      current: mutation.result.rawRecoveryLedger,
      rawRecoveryCurrent: previousLedger,
      rawRecoveryManagerDecisionProposed:
        mutation.result.rawRecoveryManagerDecisionLedger,
      rawRecoveryManagerDecisionCommands:
        mutation.result.rawRecoveryManagerDecisionCommands,
      rawRecoverySettlementCommands:
        mutation.result.rawRecoverySettlementCommands,
      managerDecisionProposed: mutation.result.managerDecisionLedger,
      proposed: mutation.ledger,
      managerDecisionCommands: mutation.result.managerDecisionCommands,
      settlementCommands: mutation.result.settlementCommands,
      managerOutput: {
        ...mutation.result.lifecycleManagerOutput,
        invalidatedFindings: [
          ...mutation.result.lifecycleManagerOutput.invalidatedFindings,
          ...(mutation.result.actionRecoveryPlan?.output.invalidatedFindings ?? []),
        ],
      },
      cwd,
      workflowName: previousLedger.workflowName,
      runId: observation.runId,
      scopeIdentity: 'targeted-replay-commit-test',
      reviewScopeSnapshotId: quote.snapshotId,
      observation,
    });
    const committed = assembleAndApplyManagerLifecycleTransactions({
      current: previousLedger,
      rawRecoveryManagerDecisionProposed: mutation.result.rawRecoveryManagerDecisionLedger,
      rawRecoveryManagerDecisionCommands: mutation.result.rawRecoveryManagerDecisionCommands,
      rawRecoveryProposed: mutation.result.rawRecoveryLedger,
      rawRecoverySettlementCommands: mutation.result.rawRecoverySettlementCommands,
      managerDecisionProposed: {
        ...proofed.ledger,
        findings: mutation.result.managerDecisionLedger.findings,
        conflicts: mutation.result.managerDecisionLedger.conflicts,
      },
      managerDecisionCommands: mutation.result.managerDecisionCommands,
      proposed: proofed.ledger,
      managerOutput: mutation.result.lifecycleManagerOutput,
      provisionalProofIdsByFinding: proofed.provisionalProofIdsByFinding,
      rawRecoveryProvisionalProofIdsByFinding:
        proofed.rawRecoveryProvisionalProofIdsByFinding,
      invalidationProofIdsByFinding: proofed.invalidationProofIdsByFinding,
      duplicateProofIdsByCommandKey: proofed.duplicateProofIdsByCommandKey,
      managerDecisionProvisionalTransitionProofIdsByCommandKey:
        proofed.managerDecisionProvisionalTransitionProofIdsByCommandKey,
      provisionalTransitionProofIdsByCommandKey:
        proofed.provisionalTransitionProofIdsByCommandKey,
      rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey:
        proofed.rawRecoveryManagerDecisionProvisionalTransitionProofIdsByCommandKey,
      rawRecoveryProvisionalTransitionProofIdsByCommandKey:
        proofed.rawRecoveryProvisionalTransitionProofIdsByCommandKey,
      invalidationReasonsByFinding: proofed.invalidationReasonsByFinding,
      resolutionRenotifications: mutation.result.resolutionRenotifications,
      settlementCommands: mutation.result.settlementCommands,
      actionRecoveryPlan: mutation.result.actionRecoveryPlan,
      occurredAt: observation,
    });

    expect(mutation.result.applied).toBe(true);
    expect(committed.findings).toContainEqual(expect.objectContaining({
      id: processFinding.id,
      status: 'open',
    }));
    expect(committed.findings.find((finding) => finding.id === processFinding.id)?.provisional)
      .toBeUndefined();
    expect(committed.rawFindings.map(({ rawFindingId }) => rawFindingId))
      .toContain(wire.rawFindingId);
    expect(committed.lifecycleEvents).toContainEqual(expect.objectContaining({
      operation: 'promote_provisional',
    }));
  });

  it('commits downstream action recovery while dropping the stale conflict resolve', () => {
    const targetSource = {
      ...raw('target-source', '/outside-workflow.ts'),
      evidence: [{
        kind: 'file_quote' as const,
        path: '/outside-workflow.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'outside workflow',
        snapshotId: 'scope-action-recovery',
      }],
    };
    const evidencePayload = {
      kind: 'file_quote' as const,
      path: '/outside-workflow.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'outside workflow',
      snapshotId: 'scope-action-recovery',
      claimIdentityHash: targetSource.claimIdentityHash,
      fileHash: 'b'.repeat(64),
    };
    const evidenceRecord = {
      evidenceId: computeFileQuoteEvidenceRecordId(evidencePayload),
      ...evidencePayload,
    };
    const target: FindingLedgerEntry = {
      ...provisional('F-0001', 'raw-adjudication-unresolved', targetSource.target.paths[0]),
      provisional: undefined,
      rawFindingIds: [targetSource.rawFindingId],
      evidenceIds: [evidenceRecord.evidenceId],
    };
    const observedTargetLedger = {
      ...ledger([target], [targetSource]),
      evidenceRecords: [evidenceRecord],
    };
    const targetPrecondition = captureFindingPreconditions(observedTargetLedger)
      .get(target.id)!.precondition;
    const processFinding = provisional('F-0002', 'stale-precondition');
    processFinding.rawFindingIds = [];
    processFinding.provisional = {
      ...processFinding.provisional!,
      sourceRawFindingIds: [],
      actionRecovery: {
        action: 'invalidate',
        findingId: target.id,
        evidence: 'The location is outside the workflow root.',
        targetPreconditions: [targetPrecondition],
      },
    };
    const baseLedger = {
      ...ledger([target, processFinding], [targetSource]),
      evidenceRecords: [evidenceRecord],
      stopBudget: {
        roundMarkers: ['prior-round'],
        firstRoundAt: observation.timestamp,
        exhausted: false,
      },
    };
    const conflict = {
      id: 'C-FA2947446963',
      status: 'active' as const,
      findingIds: [target.id],
      rawFindingIds: [targetSource.rawFindingId],
      description: 'The target finding remains disputed.',
      firstSeen: observation,
      lastSeen: observation,
      revision: 1,
    };
    const previousLedger = authorizeFindingLedgerFixture({
      ...baseLedger,
      conflicts: [conflict],
    });
    const reviewScopeSnapshotId = reviewScopeSnapshot.captureReviewScopeSnapshot(
      process.cwd(),
    ).reviewScopeSnapshotId;
    const base = emptyCommitPlanInput({
      previousLedger,
      reviewScopeSnapshotId,
      reviewScopeSnapshot: emptyReviewScopeSnapshot(reviewScopeSnapshotId),
    });
    const capturedConflictHead = {
      lifecycleHead:
        captureFindingLifecycleHead(previousLedger, 'conflict', conflict.id) ?? null,
      evidenceSetHash: computeConflictEvidenceHash(
        previousLedger.conflicts[0]!,
        previousLedger,
        reviewScopeSnapshotId,
      ),
      reviewScopeSnapshotId,
    };
    const params: FindingManagerCommitPlanInput = {
      ...base,
      managerDecision: {
        ...base.managerDecision,
        managerOutput: {
          ...emptyOutput(),
          resolvedConflicts: [{
            conflictId: conflict.id,
            evidence: 'Resolve using prompt-time dependencies.',
          }],
        },
        conflictTargetHeads: new Map([[conflict.id, capturedConflictHead]]),
        taskAudits: [],
      },
    };

    const mutation = buildFindingManagerCommitMutation(params, previousLedger);

    expect(mutation.result.staleRejections).toContain(
      'conflictDecisions: conflict "C-FA2947446963" (resolve) rejected at commit: the same plan changes its adjudication evidence dependencies',
    );
    expect(mutation.result.lifecycleManagerOutput.resolvedConflicts).toEqual([]);
    expect(mutation.result.managerDecisionCommands).not.toContainEqual(
      expect.objectContaining({ operation: 'resolve_conflict' }),
    );
    expect(mutation.result.actionRecoveryPlan?.output.invalidatedFindings)
      .toEqual([expect.objectContaining({
        action: 'invalidate',
        findingId: target.id,
      })]);
    expect(mutation.result.actionRecoveryPlan?.appliedLedger.findings.find(
      (finding) => finding.id === target.id,
    )).toMatchObject({ status: 'invalidated' });
    expect(mutation.ledger.findings.find((finding) => finding.id === target.id))
      .toMatchObject({ status: 'invalidated' });
    expect(mutation.ledger.conflicts.find((candidate) => candidate.id === conflict.id))
      .toMatchObject({ status: 'active' });
  });

  it('makes failed replay recovery terminal after the bounded attempts are exhausted', () => {
    const process = provisional('F-0001', 'raw-adjudication-unresolved');
    expect(classifyProvisionalRecovery(process.provisional!, 2, 2)).toBe('terminal-adjudication');
  });

  it('applies the replay attempt limit to raw ambiguity recovery with and without a WAL epoch', () => {
    for (const interpretationEpochs of [0, 1]) {
      const process = provisional(`F-000${interpretationEpochs + 1}`, 'raw-meaning-ambiguous');
      process.provisional!.interpretationEpochs = interpretationEpochs;
      expect(classifyProvisionalRecovery(process.provisional!, 2, 2)).toBe('terminal-adjudication');
    }
  });

  it('records a replay admission failure inside the commit mutation', () => {
    const processFinding = provisional('F-0001', 'raw-adjudication-unresolved');
    const source = raw('source-1');
    const current = ledger([processFinding], [source]);
    const replaySource = { ...source, rawFindingId: 'replay-1' };
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(replaySource, 'reviewer-stable-a'),
      { ledger: current },
    ).canonical;
    const wire = toLedgerRawFinding(canonical);
    const recovered = applyRawAdjudicationRecovery({
      freshLedger: current,
      recovery: {
        intake: {
          entityBindings: new Map(),
          items: [{ canonical, wire }],
          overflowRawFindingIds: new Set(),
          intakeProvisionalSpecs: [],
          intakeAnomalySpecs: [],
          overflowReports: [],
          clarifications: [],
          rawNormalizations: [],
          healthyReviewerStableKeys: new Set(),
        },
        output: emptyOutput(),
        origins: new Map([[wire.rawFindingId, rawRecoveryOrigin(
          current,
          processFinding,
          source.rawFindingId,
        )]]),
        failures: new Map(),
        capturedPreconditions: captureFindingPreconditions(current),
        invalidAttempts: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        reservationTokens: new Set(),
      },
      runInput: {
        cwd: process.cwd(),
        ledgerStore: { runId: observation.runId, ledgerIdentity: 'test-ledger' },
        workflowName: current.workflowName,
        workflowTask: 'Review the supplied implementation.',
        parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
        runId: observation.runId,
        timestamp: observation.timestamp,
      } as RunFindingManagerForStepInput,
      observation,
      reviewScopeSnapshotId: 'snapshot',
      reviewScopeSnapshot: emptyReviewScopeSnapshot('snapshot'),
    });

    expect(recovered.rawFindingDispositions).toEqual([{
      rawFindingId: wire.rawFindingId,
      outcome: 'audit_only',
      reason: 'replay source evidence did not pass admission at commit time',
    }]);
    expect(recovered.ledger.rawRecoveryAttempts).toEqual(current.rawRecoveryAttempts);
    expect(captureFindingLifecycleHead(recovered.ledger, 'finding', processFinding.id))
      .toEqual(captureFindingLifecycleHead(current, 'finding', processFinding.id));
  });

  it('does not attach a replay from a different reviewer provenance to the reserved provisional', () => {
    const processFinding = provisional('F-0001', 'raw-adjudication-unresolved');
    const source = raw('source-1');
    const current = ledger([processFinding], [source]);
    const replaySource = { ...source, rawFindingId: 'replay-wrong-reviewer' };
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(replaySource, 'reviewer-stable-b'),
      { ledger: current },
    ).canonical;
    const wire = toLedgerRawFinding(canonical);
    const recovered = applyRawAdjudicationRecovery({
      freshLedger: current,
      recovery: {
        intake: {
          entityBindings: new Map(),
          items: [{ canonical, wire }],
          overflowRawFindingIds: new Set(),
          intakeProvisionalSpecs: [],
          intakeAnomalySpecs: [],
          overflowReports: [],
          clarifications: [],
          rawNormalizations: [],
          healthyReviewerStableKeys: new Set(),
        },
        output: emptyOutput(),
        origins: new Map([[wire.rawFindingId, rawRecoveryOrigin(
          current,
          processFinding,
          source.rawFindingId,
        )]]),
        failures: new Map(),
        capturedPreconditions: captureFindingPreconditions(current),
        invalidAttempts: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        reservationTokens: new Set(),
      },
      runInput: {
        cwd: process.cwd(),
        ledgerStore: { runId: observation.runId, ledgerIdentity: 'test-ledger' },
        workflowName: current.workflowName,
        workflowTask: 'Review the supplied implementation.',
        parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
        runId: observation.runId,
        timestamp: observation.timestamp,
      } as RunFindingManagerForStepInput,
      observation,
      reviewScopeSnapshotId: 'snapshot',
      reviewScopeSnapshot: emptyReviewScopeSnapshot('snapshot'),
    });

    expect(recovered.ledger).toEqual(current);
    expect(recovered.rawFindingDispositions).toEqual([{
      rawFindingId: wire.rawFindingId,
      outcome: 'stale',
      reason: expect.stringContaining('reviewer provenance'),
    }]);
  });

  it('records an explicit replay-manager unsupported decision as an unsupported finite outcome', () => {
    const processFinding = provisional('F-0001', 'raw-adjudication-unresolved');
    const targetFinding: FindingLedgerEntry = {
      ...provisional('F-0002', 'raw-adjudication-unresolved'),
      provisional: undefined,
      rawFindingIds: ['target-source'],
    };
    const source = stampTargetPrecondition({
      ...raw('source-1'),
      relation: 'persists',
      targetFindingId: targetFinding.id,
    }, ledger([processFinding, targetFinding]));
    const current = ledger([processFinding, targetFinding], [source]);
    const replaySource = { ...source, rawFindingId: 'replay-unsupported' };
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(replaySource, 'reviewer-stable-a'),
      { ledger: current },
    ).canonical;
    const wire = toLedgerRawFinding(canonical);
    const evidence = 'The replay does not support the referenced target.';
    const recovered = applyRawAdjudicationRecovery({
      freshLedger: current,
      recovery: {
        intake: {
          entityBindings: new Map(),
          items: [{ canonical, wire }],
          overflowRawFindingIds: new Set(),
          intakeProvisionalSpecs: [],
          intakeAnomalySpecs: [],
          overflowReports: [],
          clarifications: [],
          rawNormalizations: [],
          healthyReviewerStableKeys: new Set(),
        },
        output: emptyOutput(),
        origins: new Map([[wire.rawFindingId, rawRecoveryOrigin(
          current,
          processFinding,
          source.rawFindingId,
        )]]),
        failures: new Map([[wire.rawFindingId, {
          kind: 'manager_unsupported',
          outcome: 'unsupported',
          reason: evidence,
        }]]),
        capturedPreconditions: captureFindingPreconditions(current),
        invalidAttempts: [],
        unsupportedRawFindingReports: [{
          rawFindingId: wire.rawFindingId,
          targetFindingId: targetFinding.id,
          evidence,
        }],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        reservationTokens: new Set(),
      },
      runInput: {
        cwd: process.cwd(),
        ledgerStore: { runId: observation.runId, ledgerIdentity: 'test-ledger' },
        workflowName: current.workflowName,
        workflowTask: 'Review the supplied implementation.',
        parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
        runId: observation.runId,
        timestamp: observation.timestamp,
      } as RunFindingManagerForStepInput,
      observation,
      reviewScopeSnapshotId: 'snapshot',
      reviewScopeSnapshot: emptyReviewScopeSnapshot('snapshot'),
    });

    expect(recovered.rawFindingDispositions).toEqual([{
      rawFindingId: wire.rawFindingId,
      outcome: 'unsupported',
      reason: evidence,
    }]);
  });

  it('defers a durable started WAL record owned by the same run', async () => {
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
    });
    let current: FindingLedger = {
      ...ledger([]),
      interpretations: [{
        interpretationKey: computeInterpretationAttemptKey(baseInterpretationKey, 1),
        baseInterpretationKey,
        attemptOrdinal: 1,
        reviewerStableKey: 'reviewer-stable-a',
        lineageKey: 'lineage-a',
        candidateEvidenceHash: 'evidence-a',
        canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
        stage: 'interpretation_started' as const,
        startedAt: observation,
        reservationToken: 'interrupted-owner',
        promptPreconditions: [],
      }],
    };
    const attempt = resolveInterpretationAttempt({
      ledger: current,
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
    });
    const claimed = new Set<string>();
    const store: FindingManagerStore = {
      ledgerIdentity: '/test/finding-provisional-recovery/reservation-ledger.json',
      interpretationLiveClaims: testInterpretationLiveClaims(['interrupted-owner']),
      workflowName: current.workflowName,
      loadLedger: () => current,
      updateLedger: async (mutator) => {
        const mutation = mutator(current);
        current = mutation.ledger;
        return mutation;
      },
      claimAdjudicationReservation: (token) => {
        if (claimed.has(token)) {
          return false;
        }
        claimed.add(token);
        return true;
      },
      releaseAdjudicationReservation: (token) => { claimed.delete(token); },
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
    };

    expect(attempt.attemptOrdinal).toBe(2);
    expect(attempt.interpretationKey).not.toBe(current.interpretations![0]!.interpretationKey);
    const begun = await beginInterpretations(store, [{
      ...attempt,
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      promptPreconditions: [],
    }], observation, stopBudgetRoundMarker);

    expect(begun.interruptedPriorKeys).toEqual(new Set());
    expect(begun.deferredKeys).toEqual(new Set([
      computeInterpretationAttemptKey(baseInterpretationKey, 1),
    ]));
    expect(begun.ownedByKey).toEqual(new Map());
    expect(begun.attemptByBaseKey.get(baseInterpretationKey)).toEqual({
      interpretationKey: computeInterpretationAttemptKey(baseInterpretationKey, 1),
      attemptOrdinal: 1,
    });
    expect(current.interpretations?.map((record) => record.stage)).toEqual([
      'interpretation_started',
    ]);
  });

  it('atomically interrupts a started attempt owned by another run and starts a new attempt', async () => {
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
    });
    const priorKey = computeInterpretationAttemptKey(baseInterpretationKey, 1);
    let current: FindingLedger = {
      ...ledger([]),
      interpretations: [{
        interpretationKey: priorKey,
        baseInterpretationKey,
        attemptOrdinal: 1,
        reviewerStableKey: 'reviewer-stable-a',
        lineageKey: 'lineage-a',
        candidateEvidenceHash: 'evidence-a',
        canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
        stage: 'interpretation_started',
        startedAt: {
          ...observation,
          runId: 'crashed-run',
        },
        reservationToken: 'crashed-owner',
        promptPreconditions: [],
      }],
    };
    const claimed = new Set(['crashed-owner']);
    const store: FindingManagerStore = {
      ledgerIdentity: '/test/finding-provisional-recovery/cross-run-resume.json',
      interpretationLiveClaims: testInterpretationLiveClaims(),
      workflowName: current.workflowName,
      loadLedger: () => current,
      updateLedger: async (mutator) => {
        const mutation = mutator(current);
        current = mutation.ledger;
        return mutation;
      },
      claimAdjudicationReservation: (token) => {
        if (claimed.has(token)) {
          return false;
        }
        claimed.add(token);
        return true;
      },
      releaseAdjudicationReservation: (token) => { claimed.delete(token); },
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
    };

    const begun = await beginInterpretations(store, [{
      baseInterpretationKey,
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      promptPreconditions: [],
    }], observation, stopBudgetRoundMarker);
    const nextKey = computeInterpretationAttemptKey(baseInterpretationKey, 2);

    expect(begun.interruptedPriorKeys).toEqual(new Set([priorKey]));
    expect(begun.deferredKeys).toEqual(new Set());
    expect(begun.ownedByKey).toEqual(new Map([[nextKey, nextKey]]));
    expect(current.interpretations.map((record) => record.stage)).toEqual([
      'interpretation_interrupted',
      'interpretation_started',
    ]);
    expect(current.interpretations[1]?.startedAt.runId).toBe(observation.runId);

    await releaseInterpretationReservations(store, begun.ownedByKey, observation);
    expect(current.interpretations[1]?.stage).toBe('interpretation_interrupted');
    const retried = await beginInterpretations(store, [{
      baseInterpretationKey,
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      promptPreconditions: [],
    }], observation, stopBudgetRoundMarker);
    const retryKey = computeInterpretationAttemptKey(baseInterpretationKey, 3);
    expect(retried.ownedByKey).toEqual(new Map([[retryKey, retryKey]]));
  });

  it('defers a concurrent interpretation while a live owner holds the attempt', async () => {
    let current = ledger([]);
    const claimed = new Set<string>();
    const store: FindingManagerStore = {
      ledgerIdentity: '/test/finding-provisional-recovery/concurrent-ledger.json',
      interpretationLiveClaims: testInterpretationLiveClaims(),
      workflowName: current.workflowName,
      loadLedger: () => current,
      updateLedger: async (mutator) => {
        const mutation = mutator(current);
        current = mutation.ledger;
        return mutation;
      },
      claimAdjudicationReservation: (token) => {
        if (claimed.has(token)) {
          return false;
        }
        claimed.add(token);
        return true;
      },
      releaseAdjudicationReservation: (token) => { claimed.delete(token); },
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
    };
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
    });
    const input = {
      baseInterpretationKey,
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      promptPreconditions: [],
    };

    const [first, second] = await Promise.all([
      beginInterpretations(store, [input], observation, stopBudgetRoundMarker),
      beginInterpretations(store, [input], observation, stopBudgetRoundMarker),
    ]);
    const owner = first.ownedByKey.size === 1 ? first : second;
    const deferred = first.ownedByKey.size === 0 ? first : second;
    const interpretationKey = owner.attemptByBaseKey.get(baseInterpretationKey)!.interpretationKey;

    expect(current.interpretations).toHaveLength(1);
    expect(owner.ownedByKey.size).toBe(1);
    expect(deferred.deferredKeys).toEqual(new Set([interpretationKey]));

    const decision = {
      decision: 'provisional' as const,
      rawFindingId: 'raw-1',
      reason: 'Still ambiguous.',
    };
    const ignored = await completeInterpretations(
      store,
      new Map([[interpretationKey, decision]]),
      deferred.ownedByKey,
      new Map([[interpretationKey, TEST_INTEGRITY_DIGEST]]),
      observation,
      stopBudgetRoundMarker,
    );
    const completed = await completeInterpretations(
      store,
      new Map([[interpretationKey, decision]]),
      owner.ownedByKey,
      new Map([[interpretationKey, TEST_INTEGRITY_DIGEST]]),
      observation,
      stopBudgetRoundMarker,
    );

    expect(ignored).toEqual(new Map());
    expect(completed).toEqual(new Map([[interpretationKey, decision]]));
    expect(current.interpretations?.[0]?.stage).toBe('interpretation_completed');

    const liveContender = await beginInterpretations(
      store,
      [input],
      observation,
      stopBudgetRoundMarker,
    );
    expect(liveContender.deferredKeys).toEqual(new Set([interpretationKey]));
    expect(liveContender.completedByKey).toEqual(new Map());

    const reservationToken = owner.ownedByKey.get(interpretationKey)!;
    store.interpretationLiveClaims.release(store.ledgerIdentity, reservationToken);
    const recovered = await beginInterpretations(
      store,
      [input],
      observation,
      stopBudgetRoundMarker,
    );
    expect(recovered.completedByKey).toEqual(new Map([[interpretationKey, decision]]));
    expect(recovered.ownedByKey).toEqual(new Map([[interpretationKey, reservationToken]]));
    await releaseInterpretationReservations(store, recovered.ownedByKey, observation);
  });

  it('does not persist begin or complete WAL mutations after the round marker is applied', async () => {
    const current = {
      ...ledger([]),
      stopBudget: {
        roundMarkers: [stopBudgetRoundMarker],
        firstRoundAt: observation.timestamp,
        exhausted: false,
      },
    };
    let updateCalls = 0;
    const store: FindingManagerStore = {
      ledgerIdentity: '/test/finding-provisional-recovery/marker-ledger.json',
      interpretationLiveClaims: testInterpretationLiveClaims(),
      workflowName: current.workflowName,
      loadLedger: () => current,
      updateLedger: async () => {
        updateCalls += 1;
        throw new Error('updateLedger must not be called');
      },
      claimAdjudicationReservation: () => {
        throw new Error('reservation must not be claimed');
      },
      releaseAdjudicationReservation: () => {},
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
    };
    const input = {
      baseInterpretationKey: 'base',
      reviewerStableKey: 'reviewer',
      lineageKey: 'lineage',
      candidateEvidenceHash: 'evidence',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      promptPreconditions: [],
    };

    const begun = await beginInterpretations(
      store,
      [input],
      observation,
      stopBudgetRoundMarker,
    );
    const completed = await completeInterpretations(
      store,
      new Map([['attempt', {
        decision: 'provisional',
        rawFindingId: 'raw-1',
        reason: 'Still ambiguous.',
      }]]),
      new Map([['attempt', 'reservation']]),
      new Map([['attempt', TEST_INTEGRITY_DIGEST]]),
      observation,
      stopBudgetRoundMarker,
    );

    expect(begun.roundAlreadyApplied).toBe(true);
    expect(completed).toEqual(new Map());
    expect(updateCalls).toBe(0);
    expect(current.interpretations).toEqual([]);
  });

  it('marks only completed interpretation records as applied', () => {
    const base = computeBaseInterpretationKey({
      reviewerStableKey: 'reviewer-stable-a',
      lineageKey: 'lineage-a',
      candidateEvidenceHash: 'evidence-a',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
    });
    const interpretationKey = computeInterpretationAttemptKey(base, 1);
    const current: FindingLedger = {
      ...ledger([]),
      interpretations: [{
        interpretationKey,
        baseInterpretationKey: base,
        attemptOrdinal: 1,
        reviewerStableKey: 'reviewer-stable-a',
        lineageKey: 'lineage-a',
        candidateEvidenceHash: 'evidence-a',
        canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
        stage: 'interpretation_started',
        startedAt: observation,
        reservationToken: 'owner-1',
        promptPreconditions: [],
      }],
    };

    const applied = markInterpretationsApplied(
      current,
      new Map([[interpretationKey, 'provisional_created']]),
      new Map([[interpretationKey, 'owner-1']]),
      new Map([[interpretationKey, TEST_INTEGRITY_DIGEST]]),
      observation,
    );

    expect(applied.interpretations?.[0]?.stage).toBe('interpretation_started');
  });

  it('excludes a completed decision from finding mutation when the commit token does not match', () => {
    const wire = raw('raw-1');
    const current = ledger([]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(wire, 'reviewer-stable-a'),
      { ledger: current },
    ).canonical;
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: canonical.reviewerStableKey,
      lineageKey: canonical.lineageKey,
      candidateEvidenceHash: canonical.evidenceSetHash,
    });
    const interpretationKey = computeInterpretationAttemptKey(baseInterpretationKey, 1);
    current.interpretations = [{
      interpretationKey,
      baseInterpretationKey,
      attemptOrdinal: 1,
      reviewerStableKey: canonical.reviewerStableKey,
      lineageKey: canonical.lineageKey,
      candidateEvidenceHash: canonical.evidenceSetHash,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
      stage: 'interpretation_completed',
      startedAt: observation,
      completedAt: observation,
      reservationToken: 'actual-owner',
      promptPreconditions: [],
      validatedDecision: { decision: 'create_independent', rawFindingId: wire.rawFindingId },
    }];
    const ladder: LadderResult = {
      interpretationReservations: new Map([[interpretationKey, 'stale-owner']]),
      interpretationIntegrityDigests: new Map([[
        interpretationKey,
        canonicalRawIntegrityDigestOf(canonical),
      ]]),
      integrityStaleInterpretationKeys: new Set(),
      deferredRawFindingIds: new Set(),
      pendingSameWithProof: [],
      pendingIndependentNew: [{ wire, canonical, viaInterpretationKey: interpretationKey }],
      pendingConflicts: [],
      provisionalSpecs: [],
      provisionalByInterpretationKey: new Map(),
      pendingAppliedReattach: [],
      recoveryProvisionalOrigins: new Map(),
      stats: {} as LadderResult['stats'],
    };

    const rejected = buildLadderCommitPlan(selectCommittableLadder(ladder, current), current, new Set());
    const accepted = buildLadderCommitPlan(selectCommittableLadder({
      ...ladder,
      interpretationReservations: new Map([[interpretationKey, 'actual-owner']]),
    }, current), current, new Set());

    expect(rejected.output.newFindings).toEqual([]);
    expect(accepted.output.newFindings).toHaveLength(1);
  });

  it('isolates a stale interpretation recovery raw from the complete commit reconciliation', () => {
    const processFinding = provisional('F-0001', 'manager-budget-exhausted');
    processFinding.provisional!.interpretationEpochs = 1;
    const source = raw('source-1');
    alignRecoveryLineageWithStoredRaw(processFinding, source);
    const previousLedger = ledger([processFinding], [source]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(source, 'reviewer-stable-a'),
      {
        ledger: previousLedger,
        preserveAmbiguityOrigin: true,
      },
    ).canonical;
    const wire = toLedgerRawFinding(canonical);
    const recoveryOrigin = snapshotProvisionalRecoveryOrigin({
      ...processFinding,
      provisional: processFinding.provisional!,
    });
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: canonical.reviewerStableKey,
      lineageKey: canonical.lineageKey,
      candidateEvidenceHash: canonical.evidenceSetHash,
    });
    const priorInterpretationKey = computeInterpretationAttemptKey(baseInterpretationKey, 1);
    const interpretationKey = computeInterpretationAttemptKey(baseInterpretationKey, 2);
    const replacement = {
      ...processFinding,
      revision: processFinding.revision + 1,
      provisional: {
        ...processFinding.provisional!,
        stableKey: 'replacement-stable-key',
        lineageKey: canonical.lineageKey,
      },
    };
    const freshLedger: FindingLedger = {
      ...authorizeFindingLedgerFixture({
        ...previousLedger,
        findings: [replacement],
      }),
      interpretations: [
        {
          interpretationKey: priorInterpretationKey,
          baseInterpretationKey,
          attemptOrdinal: 1,
          reviewerStableKey: canonical.reviewerStableKey,
          lineageKey: canonical.lineageKey,
          candidateEvidenceHash: canonical.evidenceSetHash,
          canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
          stage: 'ledger_applied',
          startedAt: observation,
          ...completedWalFields(wire.rawFindingId),
          promptPreconditions: [],
          appliedAt: observation,
          applicationResult: 'provisional_created',
        },
        {
          interpretationKey,
          baseInterpretationKey,
          attemptOrdinal: 2,
          reviewerStableKey: canonical.reviewerStableKey,
          lineageKey: canonical.lineageKey,
          candidateEvidenceHash: canonical.evidenceSetHash,
          canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
          stage: 'interpretation_completed',
          startedAt: observation,
          completedAt: observation,
          reservationToken: 'owner-1',
          promptPreconditions: [],
          validatedDecision: {
            decision: 'create_independent',
            rawFindingId: wire.rawFindingId,
          },
        },
      ],
    };
    const intake = {
      entityBindings: new Map(),
      items: [{
        canonical,
        wire,
        recoveryOrigins: [recoveryOrigin],
        interpretationRecoveryAttempt: true as const,
      }],
      overflowRawFindingIds: new Set<string>(),
      intakeProvisionalSpecs: [],
      intakeAnomalySpecs: [],
      overflowReports: [],
      clarifications: [],
      rawNormalizations: [],
      healthyReviewerStableKeys: new Set<string>(),
    };
    const emptyAdmission = {
      admissionRejections: [],
      admissionAnomalySpecs: [],
      admissionProvisionalSpecs: [],
      admissionRejectedItems: [],
      pendingRejectedObservations: [],
      cleanAdmitted: [],
      tainted: [],
      taintedAdmitted: [],
      ladderAnomalySpecs: [],
      verifiedEvidenceCandidates: [],
      provisionalOnlyLadderRawIds: new Set<string>(),
      cleanWire: [],
      verifiedEvidenceRecordsByRawFindingId: new Map(),
    };
    const input = {
      contract: {},
      cwd: process.cwd(),
      ledgerStore: { runId: observation.runId, ledgerIdentity: 'test-ledger' },
      optionsBuilder: {},
      stepExecutor: {},
      parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
      stepIteration: 1,
      subResults: [],
      workflowName: previousLedger.workflowName,
      workflowTask: 'Review the supplied implementation.',
      runId: observation.runId,
      callNamespace: '',
      timestamp: observation.timestamp,
    } as RunFindingManagerForStepInput;

    const mutation = buildFindingManagerCommitMutation({
      input,
      previousLedger,
      intake,
      interpretationRecoveryFailures: [],
      admission: emptyAdmission,
      managerDecision: {
        managerOutput: emptyOutput(),
        invalidAttempts: [],
        cleanProvisionalSpecs: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        ladder: {
          interpretationReservations: new Map([[interpretationKey, 'owner-1']]),
          interpretationIntegrityDigests: new Map([[
            interpretationKey,
            canonicalRawIntegrityDigestOf(canonical),
          ]]),
          integrityStaleInterpretationKeys: new Set(),
          deferredRawFindingIds: new Set(),
          pendingSameWithProof: [],
          pendingIndependentNew: [{
            wire,
            canonical,
            viaInterpretationKey: interpretationKey,
            recoveryOrigins: [recoveryOrigin],
            interpretationRecoveryAttempt: true,
          }],
          pendingConflicts: [],
          provisionalSpecs: [],
          provisionalByInterpretationKey: new Map(),
          pendingAppliedReattach: [],
          recoveryProvisionalOrigins: new Map(),
          stats: {} as LadderResult['stats'],
        },
        rawRecovery: {
          intake: {
            entityBindings: new Map(),
            items: [],
            overflowRawFindingIds: new Set(),
            intakeProvisionalSpecs: [],
            intakeAnomalySpecs: [],
            overflowReports: [],
            clarifications: [],
            rawNormalizations: [],
            healthyReviewerStableKeys: new Set(),
          },
          output: emptyOutput(),
          origins: new Map(),
          failures: new Map(),
          capturedPreconditions: new Map(),
          invalidAttempts: [],
          unsupportedRawFindingReports: [],
          cleanWireById: new Map(),
          cleanCanonicalById: new Map(),
          reservationTokens: new Set(),
        },
      },
      observation,
      stopBudgetLimits: resolveStopBudgetLimits(undefined),
      stopBudgetRoundMarker: 'round-1',
      reviewIntegrityLimits: resolveReviewIntegrityLimits(undefined),
      reviewScopeSnapshotId: 'snapshot-1',
      reviewScopeSnapshot: emptyReviewScopeSnapshot('snapshot-1'),
    }, freshLedger);

    expect(mutation.ledger.findings).toEqual(freshLedger.findings);
    expect(mutation.ledger.rawFindings).toEqual(freshLedger.rawFindings);
  });

  it('isolates a stale recovery-origin raw that passed clean admission before any ladder outcome', () => {
    const quote = verifiedSourceQuoteFields(
      process.cwd(),
      'src/core/workflow/findings/provisional-recovery-origin.ts',
      1,
    );
    const cleanSource: RawFinding = {
      ...raw('current-clean', quote.path),
      evidence: [quote],
    };
    const processFinding = provisional(
      'F-0001',
      'manager-budget-exhausted',
      quote.path,
    );
    const previousLedger = ledger([processFinding], [raw('source-1')]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(cleanSource, 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    processFinding.provisional!.lineageKey = canonical.lineageKey;
    const recoveryOrigin = snapshotProvisionalRecoveryOrigin({
      ...processFinding,
      provisional: processFinding.provisional!,
    });
    const wire = toLedgerRawFinding(canonical);
    const freshLedger = ledger([{
      ...processFinding,
      revision: processFinding.revision + 1,
    }], [raw('source-1')]);
    const intake = {
      entityBindings: new Map(),
      items: [{
        canonical,
        wire,
        recoveryOrigins: [recoveryOrigin],
        interpretationRecoveryAttempt: true as const,
      }],
      overflowRawFindingIds: new Set<string>(),
      intakeProvisionalSpecs: [],
      intakeAnomalySpecs: [],
      overflowReports: [],
      clarifications: [],
      rawNormalizations: [],
      healthyReviewerStableKeys: new Set<string>(),
    };
    const input = {
      contract: {},
      cwd: process.cwd(),
      ledgerStore: { runId: observation.runId, ledgerIdentity: 'test-ledger' },
      optionsBuilder: {},
      stepExecutor: {},
      parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
      stepIteration: 1,
      subResults: [],
      workflowName: previousLedger.workflowName,
      workflowTask: 'Review the supplied implementation.',
      runId: observation.runId,
      callNamespace: '',
      timestamp: observation.timestamp,
    } as RunFindingManagerForStepInput;

    const mutation = buildFindingManagerCommitMutation({
      input,
      previousLedger,
      intake,
      interpretationRecoveryFailures: [],
      admission: {
        admissionRejections: [],
        admissionAnomalySpecs: [],
        admissionProvisionalSpecs: [],
        admissionRejectedItems: [],
        pendingRejectedObservations: [],
        cleanAdmitted: [{
          canonical,
          wire,
          recoveryOrigins: [recoveryOrigin],
          interpretationRecoveryAttempt: true,
        }],
        tainted: [],
        taintedAdmitted: [],
        ladderAnomalySpecs: [],
        verifiedEvidenceCandidates: [],
        provisionalOnlyLadderRawIds: new Set(),
        cleanWire: [wire],
        verifiedEvidenceRecordsByRawFindingId: new Map(),
      },
      managerDecision: {
        managerOutput: {
          ...emptyOutput(),
          newFindings: [{
            rawFindingIds: [wire.rawFindingId],
            title: wire.title,
            severity: wire.severity,
          }],
        },
        invalidAttempts: [],
        cleanProvisionalSpecs: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map([[wire.rawFindingId, wire]]),
        cleanCanonicalById: new Map([[canonical.rawFindingId, canonical]]),
        ladder: {
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
          stats: {} as LadderResult['stats'],
        },
        rawRecovery: {
          intake: {
            entityBindings: new Map(),
            items: [],
            overflowRawFindingIds: new Set(),
            intakeProvisionalSpecs: [],
            intakeAnomalySpecs: [],
            overflowReports: [],
            clarifications: [],
            rawNormalizations: [],
            healthyReviewerStableKeys: new Set(),
          },
          output: emptyOutput(),
          origins: new Map(),
          failures: new Map(),
          capturedPreconditions: new Map(),
          invalidAttempts: [],
          unsupportedRawFindingReports: [],
          cleanWireById: new Map(),
          cleanCanonicalById: new Map(),
          reservationTokens: new Set(),
        },
      },
      observation,
      stopBudgetLimits: resolveStopBudgetLimits(undefined),
      stopBudgetRoundMarker: 'round-clean',
      reviewIntegrityLimits: resolveReviewIntegrityLimits(undefined),
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot: emptyReviewScopeSnapshot(quote.snapshotId),
    }, freshLedger);

    expect(mutation.ledger.findings).toEqual(freshLedger.findings);
    expect(mutation.ledger.rawFindings).toEqual(freshLedger.rawFindings);
    expect(mutation.ledger.reviewerAnomalies).toBeUndefined();
  });

  it.each([
    'matches',
    'newFindings',
    'resolvedFindings',
    'reopenedFindings',
    'conflicts',
  ] as const)('drops a mixed %s entry atomically and lands its fresh raw as an explicit provisional', (kind) => {
    const quote = verifiedSourceQuoteFields(
      process.cwd(),
      'src/core/workflow/findings/provisional-recovery-origin.ts',
      1,
    );
    const staleSource: RawFinding = {
      ...raw(`stale-${kind}`, quote.path),
      evidence: [quote],
    };
    const freshSource: RawFinding = {
      ...raw(`fresh-${kind}`, quote.path),
      title: `Fresh ${kind} claim`,
      evidence: [quote],
    };
    const processFinding = provisional(
      'F-0001',
      'manager-budget-exhausted',
      quote.path,
    );
    const previousLedger = ledger([processFinding], [raw('source-1')]);
    const staleCanonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(staleSource, 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    processFinding.provisional!.lineageKey = staleCanonical.lineageKey;
    const recoveryOrigin = snapshotProvisionalRecoveryOrigin({
      ...processFinding,
      provisional: processFinding.provisional!,
    });
    const freshCanonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(freshSource, 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const staleWire = toLedgerRawFinding(staleCanonical);
    const freshWire = toLedgerRawFinding(freshCanonical);
    const freshLedger = ledger([{
      ...processFinding,
      revision: processFinding.revision + 1,
    }], [raw('source-1')]);
    const staleItem = {
      canonical: staleCanonical,
      wire: staleWire,
      recoveryOrigins: [recoveryOrigin],
      interpretationRecoveryAttempt: true as const,
    };
    const freshItem = { canonical: freshCanonical, wire: freshWire };
    const params = emptyCommitPlanInput({
      previousLedger,
      intake: {
        entityBindings: new Map(),
        items: [staleItem, freshItem],
        overflowRawFindingIds: new Set(),
        intakeProvisionalSpecs: [],
        intakeAnomalySpecs: [],
        overflowReports: [],
        clarifications: [],
        rawNormalizations: [],
        healthyReviewerStableKeys: new Set(),
      },
      managerDecision: {
        ...emptyCommitPlanInput().managerDecision,
        managerOutput: mixedManagerOutput(
          kind,
          processFinding.id,
          [staleWire.rawFindingId, freshWire.rawFindingId],
          freshWire.title,
        ),
        cleanWireById: new Map([
          [staleWire.rawFindingId, staleWire],
          [freshWire.rawFindingId, freshWire],
        ]),
        cleanCanonicalById: new Map([
          [staleCanonical.rawFindingId, staleCanonical],
          [freshCanonical.rawFindingId, freshCanonical],
        ]),
      },
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot: emptyReviewScopeSnapshot(quote.snapshotId),
      stopBudgetRoundMarker: `round-mixed-${kind}`,
    });

    const mutation = buildFindingManagerCommitMutation(params, freshLedger);

    expect(mutation.ledger.rawFindings.map((item) => item.rawFindingId))
      .not.toContain(staleWire.rawFindingId);
    expect(mutation.ledger.rawFindings.map((item) => item.rawFindingId))
      .toContain(freshWire.rawFindingId);
    expect(mutation.ledger.findings).toContainEqual(expect.objectContaining({
      status: 'open',
      rawFindingIds: expect.arrayContaining([freshWire.rawFindingId]),
      provisional: expect.objectContaining({
        kind: 'raw-adjudication-unresolved',
        reason: expect.stringContaining('mixed manager entry'),
      }),
    }));
  });

  it('restores a derived waiver conflict through commit isolation, revalidation, and final reconciliation', () => {
    const cwd = process.cwd();
    const quote = verifiedSourceQuoteFields(
      cwd,
      'src/core/workflow/findings/provisional-recovery-origin.ts',
      1,
    );
    const target: FindingLedgerEntry = {
      ...provisional('F-0001', 'manager-budget-exhausted', quote.path),
      provisional: undefined,
    };
    const recoveryProcess = provisional(
      'F-0002',
      'manager-budget-exhausted',
      quote.path,
    );
    const initialLedger = ledger([target, recoveryProcess], [raw('source-1', quote.path)]);
    const isolatedSource: RawFinding = {
      ...raw('raw-isolated-conflict', quote.path),
      evidence: [quote],
    };
    const isolatedCanonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(isolatedSource, 'reviewer-stable-a'),
      { ledger: initialLedger },
    ).canonical;
    recoveryProcess.provisional!.lineageKey = isolatedCanonical.lineageKey;
    const recoveryOrigin = snapshotProvisionalRecoveryOrigin(recoveryProcess);
    const previousLedger = ledger(
      [target, recoveryProcess],
      [raw('source-1', quote.path)],
    );
    const matchedSource = stampTargetPrecondition({
      ...raw('raw-current-match', quote.path),
      relation: 'persists',
      targetFindingId: target.id,
      evidence: [quote],
    }, previousLedger);
    const matchedCanonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(matchedSource, 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const matchedWire = toLedgerRawFinding(matchedCanonical);
    const isolatedWire = toLedgerRawFinding(isolatedCanonical);
    const freshLedger = authorizeFindingLedgerFixture({
      ...previousLedger,
      findings: previousLedger.findings.map((finding) => (
        finding.id === recoveryProcess.id
          ? { ...finding, revision: finding.revision + 1 }
          : finding
      )),
    });
    const base = emptyCommitPlanInput({
      previousLedger,
      intake: {
        ...emptyCommitPlanInput().intake,
        items: [
          { canonical: matchedCanonical, wire: matchedWire },
          {
            canonical: isolatedCanonical,
            wire: isolatedWire,
            recoveryOrigins: [recoveryOrigin],
            interpretationRecoveryAttempt: true,
          },
        ],
      },
      managerDecision: {
        ...emptyCommitPlanInput().managerDecision,
        managerOutput: {
          ...emptyOutput(),
          anchorAdjudications: [
            createAnchorAdjudication({
              rawFindingId: matchedWire.rawFindingId,
              decision: 'same',
              findingId: target.id,
              anchorRelevance: 'not_applicable',
              evidence: 'The current source evidence confirms the finding persists.',
            }),
            createAnchorAdjudication({
              rawFindingId: isolatedWire.rawFindingId,
              decision: 'conflict',
              findingId: target.id,
              anchorRelevance: 'not_applicable',
              evidence: 'The recovery observation conflicts with the target finding.',
            }),
          ],
          matches: [{
            findingId: target.id,
            rawFindingIds: [matchedWire.rawFindingId],
            evidence: 'The current source evidence confirms the finding persists.',
          }],
          conflicts: [{
            findingIds: [target.id],
            rawFindingIds: [isolatedWire.rawFindingId],
            description: 'The recovery observation conflicts with the target finding.',
          }],
          disputeNotes: [createEngineDerivedWaiverDisputeNote({
            findingId: target.id,
            reason: 'The implementation is constrained by a frozen contract.',
            evidence: `${quote.path}:1`,
          })],
        },
        cleanWireById: new Map([
          [matchedWire.rawFindingId, matchedWire],
          [isolatedWire.rawFindingId, isolatedWire],
        ]),
        cleanCanonicalById: new Map([
          [matchedCanonical.rawFindingId, matchedCanonical],
          [isolatedCanonical.rawFindingId, isolatedCanonical],
        ]),
      },
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot: emptyReviewScopeSnapshot(quote.snapshotId),
      stopBudgetRoundMarker: 'round-waiver-isolation-regression',
    });
    const mutation = buildFindingManagerCommitMutation({
      ...base,
      input: {
        ...base.input,
        cwd,
        priorStepResponseText: `## Disputed Findings\n- findingId: ${target.id}\n  reason: frozen contract\n  evidence: ${quote.path}:1`,
      },
    }, freshLedger);

    expect(mutation.result.lifecycleManagerOutput.anchorAdjudications).toEqual([
      expect.objectContaining({
        rawFindingId: matchedWire.rawFindingId,
        rawDecision: 'same',
        decision: 'not_applicable',
      }),
    ]);
    expect(mutation.result.lifecycleManagerOutput.conflicts).toHaveLength(1);
    expect(mutation.result.lifecycleManagerOutput.conflicts[0]?.rawFindingIds).toEqual([]);
    expect(isEngineDerivedWaiverConflict(
      mutation.result.lifecycleManagerOutput.conflicts[0]!,
    )).toBe(true);
    expect(mutation.result.lifecycleManagerOutput.disputeNotes).toEqual([
      expect.objectContaining({ findingId: target.id }),
    ]);
    expect(mutation.ledger.conflicts).toHaveLength(1);
    expect(mutation.ledger.conflicts[0]).toMatchObject({
      findingIds: [target.id],
      rawFindingIds: [matchedWire.rawFindingId],
    });
    expect(mutation.ledger.rawFindings.map((item) => item.rawFindingId))
      .not.toContain(isolatedWire.rawFindingId);
  });

  it('prefers a late ladder raw-backed multi-finding conflict over a base derived waiver conflict at final commit', () => {
    const cwd = process.cwd();
    const quote = verifiedSourceQuoteFields(
      cwd,
      'src/core/workflow/findings/provisional-recovery-origin.ts',
      1,
    );
    const target: FindingLedgerEntry = {
      ...provisional('F-0001', 'manager-budget-exhausted', quote.path),
      provisional: undefined,
    };
    const recoveryProcess = provisional(
      'F-0002',
      'manager-budget-exhausted',
      quote.path,
    );
    const seedLedger = ledger([target, recoveryProcess], [raw('source-1', quote.path)]);
    const lateSource: RawFinding = {
      ...raw('raw-late-ladder-conflict', quote.path),
      evidence: [quote],
    };
    const lateCanonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(lateSource, 'reviewer-stable-a'),
      { ledger: seedLedger },
    ).canonical;
    recoveryProcess.provisional!.lineageKey = lateCanonical.lineageKey;
    const previousLedger = ledger(
      [target, recoveryProcess],
      [raw('source-1', quote.path)],
    );
    const recoveryOrigin = snapshotProvisionalRecoveryOrigin(
      previousLedger.findings.find((finding) => finding.id === recoveryProcess.id)!,
    );
    const baseSource = stampTargetPrecondition({
      ...raw('raw-base-match', quote.path),
      relation: 'persists',
      targetFindingId: target.id,
      evidence: [quote],
    }, previousLedger);
    const baseCanonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(baseSource, 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const baseWire = toLedgerRawFinding(baseCanonical);
    const lateWire = toLedgerRawFinding(lateCanonical);
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: lateCanonical.reviewerStableKey,
      lineageKey: lateCanonical.lineageKey,
      candidateEvidenceHash: lateCanonical.evidenceSetHash,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(lateCanonical),
    });
    const interpretationKey = computeInterpretationAttemptKey(baseInterpretationKey, 1);
    const targetPrecondition = captureFindingPreconditions(previousLedger)
      .get(target.id)?.precondition;
    if (targetPrecondition === undefined) {
      throw new Error('Test target precondition is missing');
    }
    const freshLedger: FindingLedger = {
      ...previousLedger,
      interpretations: [{
        interpretationKey,
        baseInterpretationKey,
        attemptOrdinal: 1,
        reviewerStableKey: lateCanonical.reviewerStableKey,
        lineageKey: lateCanonical.lineageKey,
        candidateEvidenceHash: lateCanonical.evidenceSetHash,
        canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(lateCanonical),
        stage: 'interpretation_completed',
        startedAt: observation,
        completedAt: observation,
        reservationToken: 'owner-late-conflict',
        promptPreconditions: [targetPrecondition],
        validatedDecision: {
          decision: 'open_conflict',
          rawFindingId: lateWire.rawFindingId,
          targetFindingId: target.id,
        },
      }],
    };
    const base = emptyCommitPlanInput({
      previousLedger,
      intake: {
        ...emptyCommitPlanInput().intake,
        items: [
          { canonical: baseCanonical, wire: baseWire },
          {
            canonical: lateCanonical,
            wire: lateWire,
            recoveryOrigins: [recoveryOrigin],
            interpretationRecoveryAttempt: true,
          },
        ],
      },
      managerDecision: {
        ...emptyCommitPlanInput().managerDecision,
        managerOutput: {
          ...emptyOutput(),
          anchorAdjudications: [createAnchorAdjudication({
            rawFindingId: baseWire.rawFindingId,
            decision: 'same',
            findingId: target.id,
            anchorRelevance: 'not_applicable',
            evidence: 'The current source evidence confirms the finding persists.',
          })],
          matches: [{
            findingId: target.id,
            rawFindingIds: [baseWire.rawFindingId],
            evidence: 'The current source evidence confirms the finding persists.',
          }],
          conflicts: [createEngineDerivedWaiverConflict(target.id)],
          disputeNotes: [createEngineDerivedWaiverDisputeNote({
            findingId: target.id,
            reason: 'The implementation is constrained by a frozen contract.',
            evidence: `${quote.path}:1`,
          })],
        },
        cleanWireById: new Map([
          [baseWire.rawFindingId, baseWire],
          [lateWire.rawFindingId, lateWire],
        ]),
        cleanCanonicalById: new Map([
          [baseCanonical.rawFindingId, baseCanonical],
          [lateCanonical.rawFindingId, lateCanonical],
        ]),
        ladder: {
          ...emptyCommitPlanInput().managerDecision.ladder,
          interpretationReservations: new Map([[
            interpretationKey,
            'owner-late-conflict',
          ]]),
          interpretationIntegrityDigests: new Map([[
            interpretationKey,
            canonicalRawIntegrityDigestOf(lateCanonical),
          ]]),
          pendingConflicts: [{
            target: {
              canonical: lateCanonical,
              wire: lateWire,
              baseInterpretationKey,
              interpretationKey,
              attemptOrdinal: 1,
              interpretationRecoveryAttempt: true,
              recoveryOrigins: [recoveryOrigin],
            },
            targetFindingId: target.id,
            viaInterpretationKey: interpretationKey,
          }],
        },
      },
      reviewScopeSnapshotId: quote.snapshotId,
      reviewScopeSnapshot: emptyReviewScopeSnapshot(quote.snapshotId),
      stopBudgetRoundMarker: 'round-late-ladder-waiver-regression',
    });
    const mutation = buildFindingManagerCommitMutation({
      ...base,
      input: {
        ...base.input,
        cwd,
        priorStepResponseText: `## Disputed Findings\n- findingId: ${target.id}\n  reason: frozen contract\n  evidence: ${quote.path}:1`,
      },
    }, freshLedger);

    expect(mutation.result.lifecycleManagerOutput.conflicts).toHaveLength(1);
    expect(mutation.result.lifecycleManagerOutput.conflicts[0]).toMatchObject({
      findingIds: [target.id, recoveryProcess.id],
      rawFindingIds: [lateWire.rawFindingId],
    });
    expect(isEngineDerivedWaiverConflict(
      mutation.result.lifecycleManagerOutput.conflicts[0]!,
    )).toBe(false);
    expect(mutation.ledger.conflicts).toHaveLength(1);
    expect(mutation.ledger.conflicts[0]).toMatchObject({
      findingIds: [target.id, recoveryProcess.id],
      rawFindingIds: [lateWire.rawFindingId],
    });
    expect(mutation.ledger.findings.find((finding) => finding.id === target.id)?.status)
      .toBe('open');
  });

  it('marks a stale recovery provisional as stale_precondition without storing its raw observation', () => {
    const processFinding = provisional('F-0001', 'manager-budget-exhausted');
    const previousLedger = ledger([processFinding], [raw('source-1')]);
    const source = stampTargetPrecondition({
      ...raw('current-provisional'),
      relation: 'persists' as const,
      targetFindingId: processFinding.id,
    }, previousLedger);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(source, 'reviewer-stable-a'),
      { ledger: previousLedger, preserveAmbiguityOrigin: true },
    ).canonical;
    processFinding.provisional!.lineageKey = canonical.lineageKey;
    const recoveryOrigin = snapshotProvisionalRecoveryOrigin({
      ...processFinding,
      provisional: processFinding.provisional!,
    });
    const wire = toLedgerRawFinding(canonical);
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: canonical.reviewerStableKey,
      lineageKey: canonical.lineageKey,
      candidateEvidenceHash: canonical.evidenceSetHash,
    });
    const interpretationKey = computeInterpretationAttemptKey(baseInterpretationKey, 1);
    const freshLedger: FindingLedger = {
      ...ledger([{
        ...processFinding,
        revision: processFinding.revision + 1,
      }], [raw('source-1')]),
      interpretations: [{
        interpretationKey,
        baseInterpretationKey,
        attemptOrdinal: 1,
        reviewerStableKey: canonical.reviewerStableKey,
        lineageKey: canonical.lineageKey,
        candidateEvidenceHash: canonical.evidenceSetHash,
        canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
        stage: 'interpretation_completed',
        startedAt: observation,
        completedAt: observation,
        reservationToken: 'owner-provisional',
        promptPreconditions: [],
        validatedDecision: {
          decision: 'provisional',
          rawFindingId: wire.rawFindingId,
          reason: 'Meaning remains ambiguous.',
        },
      }],
    };
    const spec = {
      kind: 'raw-meaning-ambiguous' as const,
      stableKey: processFinding.provisional!.stableKey,
      lineageKey: canonical.lineageKey,
      sourceRawFindingIds: [wire.rawFindingId],
      reason: 'Meaning remains ambiguous.',
      title: wire.title,
      severity: wire.severity,
      description: wire.description,
      reviewers: [wire.reviewer],
      recoveryReviewerStableKey: canonical.reviewerStableKey,
    };
    const input = {
      contract: {},
      cwd: process.cwd(),
      ledgerStore: { runId: observation.runId, ledgerIdentity: 'test-ledger' },
      optionsBuilder: {},
      stepExecutor: {},
      parentStep: { kind: 'agent', name: observation.stepName, persona: 'reviewer', edit: false },
      stepIteration: 1,
      subResults: [],
      workflowName: previousLedger.workflowName,
      workflowTask: 'Review the supplied implementation.',
      runId: observation.runId,
      callNamespace: '',
      timestamp: observation.timestamp,
    } as RunFindingManagerForStepInput;

    const mutation = buildFindingManagerCommitMutation({
      input,
      previousLedger,
      intake: {
        entityBindings: new Map(),
        items: [{
          canonical,
          wire,
          recoveryOrigins: [recoveryOrigin],
          interpretationRecoveryAttempt: true,
        }],
        overflowRawFindingIds: new Set(),
        intakeProvisionalSpecs: [],
        intakeAnomalySpecs: [],
        overflowReports: [],
        clarifications: [],
        rawNormalizations: [],
        healthyReviewerStableKeys: new Set(),
      },
      interpretationRecoveryFailures: [],
      admission: {
        admissionRejections: [],
        admissionAnomalySpecs: [],
        admissionProvisionalSpecs: [],
        admissionRejectedItems: [],
        pendingRejectedObservations: [],
        cleanAdmitted: [],
        tainted: [{
          canonical,
          wire,
          recoveryOrigins: [recoveryOrigin],
          interpretationRecoveryAttempt: true,
        }],
        taintedAdmitted: [{
          canonical,
          wire,
          recoveryOrigins: [recoveryOrigin],
          interpretationRecoveryAttempt: true,
        }],
        ladderAnomalySpecs: [],
        verifiedEvidenceCandidates: [],
        provisionalOnlyLadderRawIds: new Set([wire.rawFindingId]),
        cleanWire: [],
        verifiedEvidenceRecordsByRawFindingId: new Map(),
      },
      managerDecision: {
        managerOutput: emptyOutput(),
        invalidAttempts: [],
        cleanProvisionalSpecs: [],
        unsupportedRawFindingReports: [],
        cleanWireById: new Map(),
        cleanCanonicalById: new Map(),
        ladder: {
          interpretationReservations: new Map([[interpretationKey, 'owner-provisional']]),
          interpretationIntegrityDigests: new Map([[
            interpretationKey,
            canonicalRawIntegrityDigestOf(canonical),
          ]]),
          integrityStaleInterpretationKeys: new Set(),
          deferredRawFindingIds: new Set(),
          pendingSameWithProof: [],
          pendingIndependentNew: [],
          pendingConflicts: [],
          provisionalSpecs: [],
          provisionalByInterpretationKey: new Map([[interpretationKey, spec]]),
          pendingAppliedReattach: [],
          recoveryProvisionalOrigins: new Map([[interpretationKey, [recoveryOrigin]]]),
          stats: {} as LadderResult['stats'],
        },
        rawRecovery: {
          intake: {
            entityBindings: new Map(),
            items: [],
            overflowRawFindingIds: new Set(),
            intakeProvisionalSpecs: [],
            intakeAnomalySpecs: [],
            overflowReports: [],
            clarifications: [],
            rawNormalizations: [],
            healthyReviewerStableKeys: new Set(),
          },
          output: emptyOutput(),
          origins: new Map(),
          failures: new Map(),
          capturedPreconditions: new Map(),
          invalidAttempts: [],
          unsupportedRawFindingReports: [],
          cleanWireById: new Map(),
          cleanCanonicalById: new Map(),
          reservationTokens: new Set(),
        },
      },
      observation,
      stopBudgetLimits: resolveStopBudgetLimits(undefined),
      stopBudgetRoundMarker: 'round-provisional',
      reviewIntegrityLimits: resolveReviewIntegrityLimits(undefined),
      reviewScopeSnapshotId: 'snapshot-provisional',
      reviewScopeSnapshot: emptyReviewScopeSnapshot('snapshot-provisional'),
    }, freshLedger);

    expect(mutation.ledger.rawFindings).toEqual(freshLedger.rawFindings);
    expect(mutation.ledger.findings).toEqual(freshLedger.findings);
    expect(mutation.ledger.findings[0]?.revision).toBe(freshLedger.findings[0]?.revision);
    expect(mutation.ledger.findings[0]?.provisional?.interpretationEpochs)
      .toBe(freshLedger.findings[0]?.provisional?.interpretationEpochs);
    expect(mutation.ledger.interpretations?.[0]).toMatchObject({
      stage: 'ledger_applied',
      applicationResult: 'stale_precondition',
    });
  });

  it('advances current same-evidence reports even when the source raw is already recorded', () => {
    const processFinding = provisional('F-0001', 'manager-budget-exhausted');
    const source = stampTargetPrecondition({
      ...raw('source-1'),
      relation: 'persists',
      targetFindingId: processFinding.id,
    }, ledger([processFinding]));
    const current = ledger([processFinding], [source]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(source, 'reviewer-stable-a'),
      { ledger: current },
    ).canonical;
    processFinding.provisional!.lineageKey = canonical.lineageKey;
    processFinding.provisional!.interpretationEpochs = 1;
    const baseInterpretationKey = computeBaseInterpretationKey({
      reviewerStableKey: canonical.reviewerStableKey,
      lineageKey: canonical.lineageKey,
      candidateEvidenceHash: canonical.evidenceSetHash,
    });
    current.interpretations = [{
      interpretationKey: computeInterpretationAttemptKey(baseInterpretationKey, 1),
      baseInterpretationKey,
      attemptOrdinal: 1,
      reviewerStableKey: canonical.reviewerStableKey,
      lineageKey: canonical.lineageKey,
      candidateEvidenceHash: canonical.evidenceSetHash,
      canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
      stage: 'ledger_applied',
      startedAt: observation,
      ...completedWalFields(source.rawFindingId),
      reservationToken: 'completed-attempt-owner',
      promptPreconditions: [],
      appliedAt: observation,
      applicationResult: 'provisional_created',
    }];
    const currentItems = attachInterpretationRecoveryOrigins({
      ledger: current,
      currentItems: [{ canonical, wire: toLedgerRawFinding(canonical) }],
      roundsCompleted: 1,
    });

    const classified = classifyInitialLadderTargets({
      tainted: currentItems,
      provisionalOnlyRawFindingIds: new Set([source.rawFindingId]),
      previousLedger: current,
    });

    expect(current.rawFindings.map((item) => item.rawFindingId)).toContain(source.rawFindingId);
    expect(classified.needsInterpretation[0]?.attemptOrdinal).toBe(2);
  });

  it('rejects every inconsistent recovery metadata shape at the ladder runtime boundary', () => {
    const previousLedger = ledger([]);
    const candidate = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(raw('invalid-recovery-shape'), 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const wire = toLedgerRawFinding(candidate);
    const validOrigin = snapshotProvisionalRecoveryOrigin({
      ...provisional('F-0001', 'manager-budget-exhausted'),
      provisional: provisional('F-0001', 'manager-budget-exhausted').provisional!,
    });
    const invalidItems = [
      { canonical: candidate, wire, interpretationRecoveryAttempt: true },
      { canonical: candidate, wire, recoveryOrigins: [validOrigin] },
      { canonical: candidate, wire, interpretationRecoveryAttempt: true, recoveryOrigins: [] },
      {
        canonical: candidate,
        wire,
        interpretationRecoveryAttempt: true,
        recoveryOrigins: [{}],
      },
    ];

    for (const item of invalidItems) {
      expect(() => Reflect.apply(classifyInitialLadderTargets, undefined, [{
        tainted: [item],
        provisionalOnlyRawFindingIds: new Set(),
        previousLedger,
      }])).toThrow(/inconsistent interpretation recovery metadata/);
    }
  });

  it('rejects inconsistent recovery metadata before clean admission is classified', () => {
    const previousLedger = ledger([]);
    const candidate = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(raw('invalid-clean-recovery-shape'), 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const wire = toLedgerRawFinding(candidate);
    const validOrigin = snapshotProvisionalRecoveryOrigin({
      ...provisional('F-0001', 'manager-budget-exhausted'),
      provisional: provisional('F-0001', 'manager-budget-exhausted').provisional!,
    });

    expect(() => Reflect.apply(evaluateRawAdmission, undefined, [{
      cwd: process.cwd(),
      reviewScopeSnapshotId: 'unused-for-invalid-recovery',
      previousLedger,
      intake: {
        entityBindings: new Map(),
        items: [{ canonical: candidate, wire, recoveryOrigins: [validOrigin] }],
        overflowRawFindingIds: new Set(),
        intakeProvisionalSpecs: [],
        intakeAnomalySpecs: [],
        overflowReports: [],
        clarifications: [],
        rawNormalizations: [],
        healthyReviewerStableKeys: new Set(),
      },
    }])).toThrow(/inconsistent interpretation recovery metadata/);
  });

  it('rejects duplicate recovery origin identities within and across intake items', () => {
    const previousLedger = ledger([]);
    const candidate = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(raw('duplicate-origin-a'), 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const second = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(raw('duplicate-origin-b'), 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const process = provisional('F-duplicate', 'manager-budget-exhausted');
    const origin = snapshotProvisionalRecoveryOrigin({
      ...process,
      provisional: process.provisional!,
    });
    const recoveryItem = (canonical: typeof candidate) => ({
      canonical,
      wire: toLedgerRawFinding(canonical),
      recoveryOrigins: [origin],
      interpretationRecoveryAttempt: true as const,
    });

    expect(() => classifyInitialLadderTargets({
      tainted: [{
        ...recoveryItem(candidate),
        recoveryOrigins: [origin, origin],
      }],
      provisionalOnlyRawFindingIds: new Set(),
      previousLedger,
    })).toThrow(/duplicate recovery origin/i);
    expect(() => classifyInitialLadderTargets({
      tainted: [recoveryItem(candidate), recoveryItem(second)],
      provisionalOnlyRawFindingIds: new Set(),
      previousLedger,
    })).toThrow(/claimed by multiple raw findings/i);
  });

  it('rejects a canonical and wire raw finding identity mismatch at the boundary', () => {
    const previousLedger = ledger([]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(raw('canonical-id'), 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const otherCanonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(raw('wire-id'), 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;

    expect(() => assertCanonicalIntakeRecoveryState({
      canonical,
      wire: toLedgerRawFinding(otherCanonical),
    })).toThrow(/canonical.*wire.*identity/i);
  });

  it('rejects a fresh attached origin whose lineage or reviewer does not match the item', () => {
    const process = provisional('F-0003', 'manager-budget-exhausted');
    const previousLedger = ledger([process], [raw('source-1')]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(raw('current-attached'), 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    process.provisional!.lineageKey = canonical.lineageKey;
    const origin = snapshotProvisionalRecoveryOrigin({
      ...process,
      provisional: process.provisional!,
    });
    const invalidCanonicalItems = [
      { ...canonical, lineageKey: 'different-lineage' },
      { ...canonical, reviewerStableKey: 'different-reviewer' },
    ];

    for (const invalidCanonical of invalidCanonicalItems) {
      expect(() => assertCanonicalIntakeRecoveryState(
        {
          canonical: invalidCanonical,
          wire: toLedgerRawFinding(canonical),
          recoveryOrigins: [origin],
          interpretationRecoveryAttempt: true,
        },
        previousLedger,
      )).toThrow(/recovery origin provenance mismatch/i);
    }
  });

  it('persists one raw replay attempt and returns the same durable reservation to concurrent readers', async () => {
    let current = ledger([provisional('F-0001', 'raw-adjudication-unresolved')], [raw('source-1')]);
    const processFinding = current.findings[0]!;
    const claimed = new Set<string>();
    const store: FindingManagerStore = {
      ledgerIdentity: '/test/finding-provisional-recovery/action-ledger.json',
      interpretationLiveClaims: testInterpretationLiveClaims(),
      workflowName: current.workflowName,
      loadLedger: () => current,
      updateLedger: async (mutator) => {
        const mutation = mutator(current);
        current = mutation.ledger;
        return mutation;
      },
      claimAdjudicationReservation: (token) => {
        if (claimed.has(token)) {
          return false;
        }
        claimed.add(token);
        return true;
      },
      releaseAdjudicationReservation: (token) => { claimed.delete(token); },
      saveLedgerSnapshot: () => {},
      saveRawFindings: () => {},
      saveManagerValidationReport: () => {},
    };

    const [first, second] = await Promise.all([
      reserveRawAdjudicationRecovery(store, observation, '1'.repeat(64)),
      reserveRawAdjudicationRecovery(store, observation, '1'.repeat(64)),
    ]);
    const owner = first;
    const concurrent = second;

    expect(owner.result).toEqual([
      expect.objectContaining({
        provisionalFindingId: 'F-0001',
        expectedRevision: 1,
        attempt: 1,
        recoveryOrigin: {
          provisionalFindingId: processFinding.id,
          expectedProvisionalRevision: 1,
          expectedTargetIdentityHash: processFinding.targetIdentityHash,
          expectedProvisionalStableKey: processFinding.provisional!.stableKey,
          expectedProvisionalLineageKey: processFinding.provisional!.lineageKey,
          expectedRecoveryReviewerStableKey: 'reviewer-stable-a',
        },
      }),
    ]);
    expect(concurrent.result).toEqual(owner.result);
    expect(current.rawRecoveryAttempts).toEqual([
      expect.objectContaining({
        attemptId: owner.result[0]?.attemptId,
        provisionalFindingId: processFinding.id,
        attempt: 1,
      }),
    ]);

    releaseRawAdjudicationReservations(
      store,
      new Set(owner.result.map((reservation) => reservation.reservationToken)),
    );
    const retried = await reserveRawAdjudicationRecovery(
      store,
      observation,
      '1'.repeat(64),
    );
    expect(retried.result[0]).toMatchObject({ expectedRevision: 1, attempt: 1 });
    releaseRawAdjudicationReservations(
      store,
      new Set(retried.result.map((reservation) => reservation.reservationToken)),
    );
  });

  it('requeues a saved unresolved lineage without a new reviewer report', () => {
    const processFinding = provisional('F-0001', 'manager-budget-exhausted');
    processFinding.provisional!.interpretationEpochs = 1;
    const source = raw('source-1');
    alignRecoveryLineageWithStoredRaw(processFinding, source);

    const recovered = collectInterpretationRecoveryItems({
      ledger: ledger([processFinding], [source]),
      currentItems: [],
      roundsCompleted: 1,
    });

    expect(recovered).toEqual([
      expect.objectContaining({
        wire: expect.objectContaining({ rawFindingId: source.rawFindingId }),
        recoveryOrigins: [expect.objectContaining({
          provisionalFindingId: processFinding.id,
          expectedProvisionalRevision: 1,
        })],
      }),
    ]);
  });

  it('carries the saved process identity on a same-lineage reviewer report', () => {
    const processFinding = provisional('F-0001', 'manager-budget-exhausted');
    processFinding.provisional!.interpretationEpochs = 1;
    const source = raw('source-1');
    const current = ledger([processFinding], [source]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(source, 'reviewer-stable-a'),
      { ledger: current },
    ).canonical;
    processFinding.provisional!.lineageKey = canonical.lineageKey;

    const attached = attachInterpretationRecoveryOrigins({
      ledger: current,
      currentItems: [{ canonical, wire: toLedgerRawFinding(canonical) }],
      roundsCompleted: 1,
    });

    expect(attached[0]?.recoveryOrigins).toEqual([{
      provisionalFindingId: processFinding.id,
      expectedProvisionalRevision: 1,
      expectedTargetIdentityHash: processFinding.targetIdentityHash,
      expectedProvisionalStableKey: processFinding.provisional!.stableKey,
      expectedProvisionalLineageKey: processFinding.provisional!.lineageKey,
      expectedRecoveryReviewerStableKey: 'reviewer-stable-a',
    }]);
    expect(collectInterpretationRecoveryItems({
      ledger: current,
      currentItems: attached,
      roundsCompleted: 1,
    })).toEqual([]);
  });

  it('does not infer a recovery origin from lineage when reviewer provenance differs', () => {
    const processFinding = provisional('F-0001', 'manager-budget-exhausted');
    processFinding.provisional!.interpretationEpochs = 1;
    const source = raw('source-1');
    const current = ledger([processFinding], [source]);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(source, 'reviewer-stable-b'),
      { ledger: current },
    ).canonical;
    processFinding.provisional!.lineageKey = canonical.lineageKey;

    const attached = attachInterpretationRecoveryOrigins({
      ledger: current,
      currentItems: [{ canonical, wire: toLedgerRawFinding(canonical) }],
      roundsCompleted: 1,
    });

    expect(attached[0]?.recoveryOrigins).toBeUndefined();
  });

  it('resolves an overflow after an empty healthy envelope and bounds absent recovery rounds', () => {
    const overflow = provisional('F-0001', 'reviewer-output-overflow');
    const current = ledger([overflow]);
    const settlement = settleProvisionalsWithCleanEvidence({
      output: emptyOutput(),
      cleanRawIds: new Set(),
      wireById: new Map(),
      freshLedger: current,
      explicitResolvedByMapping: new Map(),
      explicitPromotedFindingIds: new Set(),
      healthyReviewerStableKeys: new Set(['reviewer-stable-a']),
      replayOrigins: new Map(),
    });
    const settled = applyProvisionalSettlement(current, settlement, observation.timestamp);

    expect(settled.findings[0]?.status).toBe('resolved');
    expect(settled.findings[0]?.resolvedEvidence)
      .toBe('A later output from the same reviewer passed the intake envelope.');
    expect(classifyProvisionalRecovery(overflow.provisional!, 2)).toBe('envelope');
    expect(classifyProvisionalRecovery(overflow.provisional!, 3)).toBe('process-failure');
  });

  it('does not reapply a stale waiver without a fresh adjudication', () => {
    const target: FindingLedgerEntry = {
      ...provisional('F-0001', 'raw-adjudication-unresolved'),
      provisional: undefined,
      severity: 'medium',
    };
    const processFinding = provisional('F-0002', 'stale-precondition');
    const targetPrecondition = captureFindingPreconditions(ledger([target]))
      .get(target.id)!.precondition;
    processFinding.provisional = {
      ...processFinding.provisional!,
      sourceRawFindingIds: [],
      actionRecovery: {
        action: 'waive',
        findingId: target.id,
        reason: 'The supported runtime cannot change.',
        evidence: 'Runtime support policy is fixed.',
        targetPreconditions: [targetPrecondition],
      },
    };
    const current = ledger([target, processFinding]);
    const candidates = collectManagerActionRecoveryCandidates(current, 1);
    const recovered = applyManagerActionRecovery({
      ledger: current,
      candidates,
      cwd: process.cwd(),
      context: {
        workflowName: current.workflowName,
        stepName: observation.stepName,
        runId: observation.runId,
        timestamp: observation.timestamp,
      },
      observation,
    });

    expect(recovered.findings.find((finding) => finding.id === target.id)?.status).toBe('open');
    expect(recovered.findings.find((finding) => finding.id === processFinding.id)?.status).toBe('open');
    expect(recovered.findings.find((finding) => finding.id === processFinding.id)
      ?.provisional?.actionRecoveryAttempts).toHaveLength(1);
  });

  it.each([
    { name: 'exact head', revision: 1, expectedStatus: 'invalidated' as const },
    { name: 'unrelated intermediate revision', revision: 2, expectedStatus: 'open' as const },
  ])('applies an engine-persisted action only against its $name', ({ revision, expectedStatus }) => {
    const evidencePayload = {
      kind: 'file_quote' as const,
      path: '/outside-workflow.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'outside workflow',
      snapshotId: 'snapshot',
      claimIdentityHash: 'a'.repeat(64),
      fileHash: 'b'.repeat(64),
    };
    const evidenceRecord = {
      evidenceId: computeFileQuoteEvidenceRecordId(evidencePayload),
      ...evidencePayload,
    };
    const observedTarget: FindingLedgerEntry = {
      ...provisional('F-0001', 'raw-adjudication-unresolved'),
      provisional: undefined,
      evidenceIds: [evidenceRecord.evidenceId],
    };
    const authorizedObservedLedger = ledger([observedTarget]);
    const observedLedger = {
      ...authorizedObservedLedger,
      evidenceRecords: [...authorizedObservedLedger.evidenceRecords, evidenceRecord],
    };
    const targetPrecondition = captureFindingPreconditions(observedLedger)
      .get(observedTarget.id)!.precondition;
    const target = { ...observedTarget, revision };
    const processFinding = provisional('F-0002', 'stale-precondition');
    processFinding.provisional = {
      ...processFinding.provisional!,
      sourceRawFindingIds: [],
      actionRecovery: {
        action: 'invalidate',
        findingId: target.id,
        evidence: 'The location is outside the workflow root.',
        targetPreconditions: [targetPrecondition],
      },
    };
    const authorizedCurrent = ledger([target, processFinding]);
    const current = {
      ...authorizedCurrent,
      evidenceRecords: [...authorizedCurrent.evidenceRecords, evidenceRecord],
    };
    const recovered = applyManagerActionRecovery({
      ledger: current,
      candidates: collectManagerActionRecoveryCandidates(current, 1),
      cwd: process.cwd(),
      context: {
        workflowName: current.workflowName,
        stepName: observation.stepName,
        runId: observation.runId,
        timestamp: observation.timestamp,
      },
      observation,
    });

    expect(recovered.findings.find((finding) => finding.id === target.id)?.status)
      .toBe(expectedStatus);
  });

  it('applies action recovery invalidation and settlement through lifecycle commands', () => {
    const evidencePayload = {
      kind: 'file_quote' as const,
      path: '/outside-workflow.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'outside workflow',
      snapshotId: 'snapshot',
      claimIdentityHash: 'a'.repeat(64),
      fileHash: 'b'.repeat(64),
    };
    const evidenceRecord = {
      evidenceId: computeFileQuoteEvidenceRecordId(evidencePayload),
      ...evidencePayload,
    };
    const target: FindingLedgerEntry = {
      ...provisional('F-0001', 'raw-adjudication-unresolved'),
      provisional: undefined,
      evidenceIds: [evidenceRecord.evidenceId],
    };
    const withEvidence = {
      ...ledger([target]),
      evidenceRecords: [evidenceRecord],
    };
    const targetPrecondition = captureFindingPreconditions(withEvidence)
      .get(target.id)!.precondition;
    const processFinding = provisional('F-0002', 'stale-precondition');
    processFinding.provisional = {
      ...processFinding.provisional!,
      sourceRawFindingIds: [],
      actionRecovery: {
        action: 'invalidate',
        findingId: target.id,
        evidence: 'The location is outside the workflow root.',
        targetPreconditions: [targetPrecondition],
      },
    };
    const authorized = ledger([target, processFinding]);
    const current = {
      ...authorized,
      evidenceRecords: [...authorized.evidenceRecords, evidenceRecord],
    };
    const context = {
      workflowName: current.workflowName,
      stepName: observation.stepName,
      runId: observation.runId,
      timestamp: observation.timestamp,
    };
    const plan = planManagerActionRecovery({
      ledger: current,
      candidates: collectManagerActionRecoveryCandidates(current, 1),
      cwd: process.cwd(),
      context,
      observation,
    });
    const proofed = issueManagerLifecycleAuthority({
      current,
      rawRecoveryCurrent: current,
      rawRecoveryManagerDecisionProposed: current,
      rawRecoveryManagerDecisionCommands: [],
      rawRecoverySettlementCommands: [],
      managerDecisionProposed: plan.ledger,
      proposed: plan.ledger,
      managerDecisionCommands: [],
      settlementCommands: [],
      managerOutput: plan.output,
      cwd: process.cwd(),
      workflowName: current.workflowName,
      runId: observation.runId,
      scopeIdentity: 'action-recovery-command-test',
      reviewScopeSnapshotId: 'c'.repeat(64),
      observation,
    }).ledger;

    const applied = applyManagerActionRecoveryLifecycleCommands({
      ledger: {
        ...current,
        evidenceRecords: proofed.evidenceRecords,
      },
      plan,
      proofedLedger: proofed,
      observation,
    });

    expect(applied.findings.find((finding) => finding.id === target.id)?.status)
      .toBe('invalidated');
    expect(applied.findings.find((finding) => finding.id === processFinding.id)?.status)
      .toBe('resolved');
    expect(applied.lifecycleEvents
      .slice(current.lifecycleEvents.length)
      .map((event) => event.operation)).toEqual([
      'invalidate_finding',
      'resolve_finding',
    ]);
    expect(applied.lifecycleReservations
      .slice(current.lifecycleReservations.length)
      .map((reservation) => reservation.authority))
      .toEqual([
        { kind: 'verified_evidence' },
        { kind: 'system', action: 'settle_action_recovery' },
      ]);
  });

  it('records a failed action recovery attempt through a lifecycle command', () => {
    const target: FindingLedgerEntry = {
      ...provisional('F-0001', 'raw-adjudication-unresolved'),
      provisional: undefined,
      severity: 'medium',
    };
    const processFinding = provisional('F-0002', 'stale-precondition');
    const targetPrecondition = captureFindingPreconditions(ledger([target]))
      .get(target.id)!.precondition;
    processFinding.provisional = {
      ...processFinding.provisional!,
      sourceRawFindingIds: [],
      actionRecovery: {
        action: 'waive',
        findingId: target.id,
        reason: 'The supported runtime cannot change.',
        evidence: 'Runtime support policy is fixed.',
        targetPreconditions: [targetPrecondition],
      },
    };
    const current = ledger([target, processFinding]);
    const plan = planManagerActionRecovery({
      ledger: current,
      candidates: collectManagerActionRecoveryCandidates(current, 1),
      cwd: process.cwd(),
      context: {
        workflowName: current.workflowName,
        stepName: observation.stepName,
        runId: observation.runId,
        timestamp: observation.timestamp,
      },
      observation,
    });

    const applied = applyManagerActionRecoveryLifecycleCommands({
      ledger: current,
      plan,
      proofedLedger: current,
      observation,
    });

    expect(applied.findings.find((finding) => finding.id === processFinding.id)
      ?.provisional?.actionRecoveryAttempts).toHaveLength(1);
    expect(applied.lifecycleEvents.slice(current.lifecycleEvents.length)).toEqual([
      expect.objectContaining({ operation: 'record_recovery_attempt' }),
    ]);
    expect(applied.lifecycleReservations.at(-1)?.authority).toEqual({
      kind: 'system',
      action: 'record_recovery_attempt',
    });
  });

  it('allows verified reviewer evidence to reopen a recorded dismissal', () => {
    const dismissed = provisional('F-0001', 'raw-meaning-ambiguous');
    dismissed.status = 'dismissed';
    dismissed.lifecycle = 'dismissed';
    dismissed.dismissal = {
      basis: 'unverifiable_claim',
      reason: 'No verifiable evidence was available.',
      evidence: 'The original observation contained no verifiable subject.',
      authority: 'standard',
      decidedAt: observation,
    };
    const previousLedger = ledger([dismissed], [raw('source-1')]);
    const reopenedRaw = stampTargetPrecondition({
      ...raw('reopen-1'),
      relation: 'reopened',
      targetFindingId: dismissed.id,
    }, previousLedger);
    const canonical = canonicalizeReviewerRawFinding(
      candidateFromStoredRawFinding(reopenedRaw, 'reviewer-stable-a'),
      { ledger: previousLedger },
    ).canonical;
    const reopened = reconcileFindingLedger({
      previousLedger,
      rawFindings: [reopenedRaw],
      managerOutput: {
        ...emptyOutput(),
        anchorAdjudications: [createAnchorAdjudication({
          rawFindingId: reopenedRaw.rawFindingId,
          decision: 'reopened',
          findingId: dismissed.id,
          anchorRelevance: 'not_applicable',
          evidence: 'A later reviewer supplied current evidence.',
        })],
        reopenedFindings: [{
          findingId: dismissed.id,
          rawFindingIds: [reopenedRaw.rawFindingId],
          evidence: 'A later reviewer supplied current evidence.',
        }],
      },
      entityProvisionalMutations: [],
      terminalEntityAttachmentFindingIds: new Set(),
      provisionalFindings: [],
      rawFindingDispositions: [],
      rawProvenanceByRawFindingId: new Map([[reopenedRaw.rawFindingId, {
        reviewerStableKey: canonical.reviewerStableKey,
        lineageKey: canonical.lineageKey,
        claimIdentityHash: canonical.claimIdentityHash,
        canonicalIntegrityDigest: canonicalRawIntegrityDigestOf(canonical),
        canonicalProvenance: canonical.provenance,
      }]]),
      verifiedEvidenceRecordsByRawFindingId: new Map(),
      context: {
        workflowName: 'peer-review',
        stepName: observation.stepName,
        runId: observation.runId,
        timestamp: observation.timestamp,
      },
    });

    expect(reopened.findings[0]?.status).toBe('open');
    expect(reopened.findings[0]?.provisional).toBeUndefined();
    expect(reopened.findings[0]?.dismissal).toEqual(dismissed.dismissal);
  });
});
