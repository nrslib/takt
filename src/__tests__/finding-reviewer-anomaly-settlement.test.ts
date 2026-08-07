import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  FindingEvidenceRecord,
  FindingLedger,
  FindingLifecycleEvent,
  FindingLifecycleOperation,
  FindingMutationPrecondition,
  ReviewerAnomalyEntry,
} from '../core/workflow/findings/types.js';
import {
  isOutstandingReviewerAnomaly,
} from '../core/workflow/findings/reviewer-anomalies.js';
import {
  settleReviewerAnomaliesFromAuthorizedTerminalEvents,
} from '../core/workflow/findings/reviewer-anomaly-settlement.js';
import {
  attachReviewIntegrityState,
  resolveReviewIntegrityLimits,
} from '../core/workflow/findings/review-integrity.js';
import { buildLoopMonitorFindingsSummaryData } from '../core/workflow/findings/loop-monitor-summary.js';
import { buildFindingsRuleContext } from '../core/workflow/findings/context.js';
import {
  assertFindingLedgerAppendOnlyTransition,
} from '../core/workflow/findings/finding-integrity.js';
import {
  applyFindingLedgerFixtureRevision,
  applyFindingLedgerFixtureSupersession,
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  rawCanonicalSnapshotFixture,
} from './helpers/finding-lifecycle-fixture.js';
import {
  cleanupTestFindingStorage,
  createTestFindingLedgerStore,
} from './helpers/finding-storage.js';
import { captureFindingMutationPrecondition } from '../core/workflow/findings/finding-preconditions.js';
import {
  applyVerifiedLifecycleMutation,
  captureFindingLifecycleHead,
  reserveVerifiedLifecycleMutation,
} from '../core/workflow/findings/lifecycle-mutation.js';
import {
  createFindingLifecycleReservation,
} from '../core/models/finding-lifecycle-identity.js';
import { assertFindingLedgerProjectionInvariant } from '../core/models/finding-ledger-invariants.js';
import { issueFindingScopeBindings } from '../core/workflow/findings/finding-scope-binding.js';
import type { FindingContractConfig } from '../core/models/finding-types.js';
import { computeWorkflowTaskDigest } from '../core/workflow/findings/task-scope-adjudication.js';

const storageRoots: string[] = [];

afterEach(() => {
  cleanupTestFindingStorage();
  for (const root of storageRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFindingStore(runId: string) {
  const projectCwd = mkdtempSync(join(tmpdir(), 'takt-anomaly-settlement-'));
  storageRoots.push(projectCwd);
  return {
    projectCwd,
    store: createTestFindingLedgerStore({
      projectCwd,
      runId,
      reportDir: join(projectCwd, '.takt', 'runs', runId, 'reports'),
      workflowName: 'default',
    }),
  };
}

const beforeObservation = {
  runId: 'run-1',
  stepName: 'reviewers',
  timestamp: '2026-07-31T00:00:00.000Z',
};
const afterObservation = {
  runId: 'run-1',
  stepName: 'reviewers',
  timestamp: '2026-07-31T00:01:00.000Z',
};
const TERMINAL_DISMISSAL_TASK = 'Review only src/in-scope.ts.';
const WORKFLOW_TASK_DIGEST = computeWorkflowTaskDigest(TERMINAL_DISMISSAL_TASK);
const TERMINAL_DISMISSAL_CONTRACT: FindingContractConfig = {
  manager: {
    persona: 'manager',
    instruction: 'Manage findings.',
    outputContract: 'Return structured findings.',
  },
  adjudicator: { persona: 'supervisor' },
};
const historicalObservation = {
  ...afterObservation,
  timestamp: '2026-07-31T00:02:00.000Z',
};

function anomaly(overrides: Partial<ReviewerAnomalyEntry> = {}): ReviewerAnomalyEntry {
  return {
    id: 'RA-1',
    kind: 'quote-mismatch',
    stableKey: 'stable-1',
    lineageKey: 'lineage-1',
    sourceRawFindingIds: ['raw-anomaly'],
    sourceIntakeIds: [],
    reviewers: ['architecture'],
    title: 'Unverified lifecycle claim',
    mismatchReason: 'The quoted source did not match',
    firstObserved: beforeObservation,
    lastObserved: beforeObservation,
    occurrences: 1,
    ...overrides,
  };
}

function lifecycleEvent(
  operation: FindingLifecycleOperation = 'resolve_finding',
  findingId = 'F-0003',
): FindingLifecycleEvent {
  const before = {
    entityKind: 'finding' as const,
    entityId: findingId,
    revision: 1,
    eventId: `event-before-${findingId}`,
    projectionDigest: 'projection-before',
  };
  return {
    eventId: `event-${operation}-${findingId}`,
    mutationId: `mutation-${operation}-${findingId}`,
    reservationId: `reservation-${operation}-${findingId}`,
    operation,
    transitions: [{
      before,
      after: {
        entityKind: 'finding',
        entityId: findingId,
        revision: 2,
        eventId: `event-${operation}-${findingId}`,
        projectionDigest: 'projection',
      },
    }],
    evidenceBindingIds: [`binding-${findingId}`],
    outcome: { kind: 'projection_applied' },
    resultDigest: 'result',
    occurredAt: afterObservation,
  };
}

function ledger(input: {
  status?: 'open' | 'resolved' | 'dismissed' | 'waived';
  targetFindingId?: string;
  operation?: FindingLifecycleOperation;
  eventInPrevious?: boolean;
  eventInNext?: boolean;
  withEvidenceBinding?: boolean;
  budgetExhausted?: boolean;
  reviewerAnomaly?: ReviewerAnomalyEntry;
} = {}): { previous: FindingLedger; anomaliesApplied: FindingLedger; next: FindingLedger } {
  const targetFindingId = input.targetFindingId ?? 'F-0003';
  const operation = input.operation ?? 'resolve_finding';
  const event = lifecycleEvent(operation, targetFindingId);
  const source = canonicalRawFindingFixture({
    rawFindingId: 'raw-anomaly',
    stepName: 'architecture',
    reviewer: 'architecture',
    relation: 'persists',
    targetFindingId: 'F-0003',
    evidence: [],
  });
  const evidenceRecord = {
    evidenceId: 'evidence-1',
  } as FindingEvidenceRecord;
  const anomalyEntry = input.reviewerAnomaly ?? anomaly();
  const base: FindingLedger = {
    workflowName: 'peer-review',
    nextId: 4,
    updatedAt: beforeObservation.timestamp,
    findings: [{
      id: targetFindingId,
      status: input.status ?? 'resolved',
      lifecycle: input.status ?? 'resolved',
      severity: 'high',
      title: 'Target finding',
      evidenceIds: [],
      reviewers: ['architecture'],
      rawFindingIds: [],
      firstSeen: beforeObservation,
      lastSeen: afterObservation,
      revision: 2,
    }],
    evidenceRecords: input.withEvidenceBinding === false ? [] : [evidenceRecord],
    evidenceBindings: input.withEvidenceBinding === false ? [] : [{
      bindingId: `binding-${targetFindingId}`,
      evidenceId: evidenceRecord.evidenceId,
      claimIdentityHash: null,
      sourceRawFindingId: 'raw-resolution',
      sourceRawIntegrityDigest: null,
      operation,
      target: {
        entityKind: 'finding',
        entityId: targetFindingId,
        expectedHead: null,
      },
    }],
    lifecycleReservations: [{
      reservationId: event.reservationId,
      mutationId: event.mutationId,
      operation,
      targets: [{
        entityKind: 'finding',
        entityId: targetFindingId,
        expectedHead: event.transitions[0]!.before,
      }],
      evidenceBindingIds: event.evidenceBindingIds,
      authority: { kind: 'verified_evidence' },
      context: { kind: 'transaction' },
      reservedAt: afterObservation,
    }],
    lifecycleEvents: input.eventInPrevious === true ? [event] : [],
    rawFindings: [source],
    conflicts: [],
    ...(input.budgetExhausted === true
      ? {
          reviewIntegrity: {
            roundMarkers: ['round-1'],
            firstRoundAt: beforeObservation.timestamp,
            exhausted: true,
          },
        }
      : {}),
  };
  return {
    previous: base,
    anomaliesApplied: {
      ...base,
      reviewerAnomalies: [anomalyEntry],
    },
    next: {
      ...base,
      updatedAt: afterObservation.timestamp,
      lifecycleEvents: input.eventInNext === false ? base.lifecycleEvents : [event],
      reviewerAnomalies: [anomalyEntry],
    },
  };
}

function validSettledLedger(): FindingLedger {
  const resolved = authorizeFindingLedgerFixture({
    workflowName: 'default',
    nextId: 2,
    updatedAt: afterObservation.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'resolved',
      lifecycle: 'resolved',
      severity: 'high',
      title: 'Resolved target',
      evidenceIds: [],
      reviewers: ['architecture'],
      rawFindingIds: [],
      firstSeen: beforeObservation,
      lastSeen: afterObservation,
      revision: 2,
      resolvedAt: afterObservation.timestamp,
      resolvedEvidence: 'Verified resolution.',
    }],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
  });
  const event = resolved.lifecycleEvents.find(
    (candidate) => candidate.operation === 'resolve_finding',
  )!;
  const sourceRawFindingId = resolved.evidenceBindings.find((binding) => (
    event.evidenceBindingIds.includes(binding.bindingId)
    && binding.target.entityId === 'F-0001'
  ))!.sourceRawFindingId!;
  return {
    ...resolved,
    reviewerAnomalies: [anomaly({
      id: 'RA-VALID',
      sourceRawFindingIds: [sourceRawFindingId],
      settlement: {
        kind: 'target_resolved_by_verified_evidence',
        findingId: 'F-0001',
        lifecycleEventId: event.eventId,
      },
    })],
  };
}

function terminalDismissalFixture(): {
  previous: FindingLedger;
  anomaliesApplied: FindingLedger;
  next: FindingLedger;
} {
  const initial = authorizeFindingLedgerFixture({
    workflowName: 'default',
    nextId: 2,
    updatedAt: beforeObservation.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Terminal target',
      target: { kind: 'code', paths: ['docs/outside.md'] },
      evidenceIds: [],
      reviewers: ['architecture'],
      rawFindingIds: [],
      firstSeen: beforeObservation,
      lastSeen: beforeObservation,
      revision: 1,
    }],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
  });
  const targetPrecondition = captureFindingMutationPrecondition(initial, 'F-0001')!;
  const raw = canonicalRawFindingFixture({
    rawFindingId: 'raw-anomaly',
    stepName: 'architecture',
    reviewer: 'architecture',
    relation: 'reopened',
    targetFindingId: 'F-0001',
    targetPrecondition,
    evidence: [],
  });
  const previousWithoutScopeBinding = {
    ...initial,
    rawFindings: [...initial.rawFindings, raw],
    rawCanonicalSnapshots: [
      ...initial.rawCanonicalSnapshots,
      rawCanonicalSnapshotFixture(raw, afterObservation),
    ],
  };
  const dismissal = {
    basis: 'outside_task_scope' as const,
    reason: 'The claim is outside this workflow task.',
    taskQuote: TERMINAL_DISMISSAL_TASK,
    workflowTaskDigest: WORKFLOW_TASK_DIGEST,
    adjudicationTaskId: 'c'.repeat(64),
    authority: 'terminal_adjudication' as const,
    decidedAt: { ...afterObservation },
  };
  const target = previousWithoutScopeBinding.findings[0]!;
  const expectedHead = captureFindingLifecycleHead(
    previousWithoutScopeBinding,
    'finding',
    target.id,
  )!;
  const scopeBinding = issueFindingScopeBindings({
    finding: target,
    expectedHead,
    workflowTask: TERMINAL_DISMISSAL_TASK,
    contract: TERMINAL_DISMISSAL_CONTRACT,
    reviewScopeSnapshot: {
      reviewScopeSnapshotId: 'b'.repeat(64),
      trackedDiff: undefined,
      untrackedEvidence: [],
      queryInventory: [],
      changedPaths: ['src/in-scope.ts'],
    },
    issuedAt: afterObservation,
  }).find(({ source }) => source === 'workflow_task_scope')!;
  const previous = {
    ...previousWithoutScopeBinding,
    findingScopeBindings: [
      ...previousWithoutScopeBinding.findingScopeBindings,
      scopeBinding,
    ],
  };
  const reservation = createFindingLifecycleReservation({
    operation: 'dismiss_finding',
    targets: [{
      entityKind: 'finding',
      entityId: target.id,
      expectedHead,
    }],
    evidenceBindingIds: [],
    authority: {
      kind: 'verified_terminal_adjudication',
      episodeId: 'd'.repeat(64),
      attemptId: dismissal.adjudicationTaskId,
      verificationDigest: 'e'.repeat(64),
      proofRecordIds: [],
      scopeBindingIds: [scopeBinding.bindingId],
    },
    context: { kind: 'transaction' },
    reservedAt: afterObservation,
  });
  const reserved = reserveVerifiedLifecycleMutation(previous, {
    reservation,
    evidenceBindings: [],
  });
  const dismissed = applyVerifiedLifecycleMutation(reserved, {
    mutationId: reservation.mutationId,
    findings: [{
      ...target,
      status: 'dismissed',
      lifecycle: 'dismissed',
      revision: target.revision + 1,
      dismissal,
    }],
    conflicts: [],
    occurredAt: afterObservation,
  });
  const anomalyEntry = anomaly({ sourceRawFindingIds: [raw.rawFindingId] });
  return {
    previous,
    anomaliesApplied: {
      ...previous,
      reviewerAnomalies: [anomalyEntry],
    },
    next: {
      ...dismissed,
      reviewerAnomalies: [anomalyEntry],
    },
  };
}

function verifiedResolutionFixture(
  mutatePrecondition?: (
    precondition: FindingMutationPrecondition,
  ) => FindingMutationPrecondition,
): {
  previous: FindingLedger;
  anomaliesApplied: FindingLedger;
  next: FindingLedger;
} {
  const initial = authorizeFindingLedgerFixture({
    workflowName: 'default',
    nextId: 2,
    updatedAt: beforeObservation.timestamp,
    findings: [{
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Verified resolution target',
      evidenceIds: [],
      reviewers: ['architecture'],
      rawFindingIds: [],
      firstSeen: beforeObservation,
      lastSeen: beforeObservation,
      revision: 1,
    }],
    evidenceRecords: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    rawFindings: [],
    conflicts: [],
  });
  const currentPrecondition = captureFindingMutationPrecondition(
    initial,
    'F-0001',
  )!;
  const source = canonicalRawFindingFixture({
    rawFindingId: 'raw-anomaly',
    stepName: 'architecture',
    reviewer: 'architecture',
    relation: 'persists',
    targetFindingId: 'F-0001',
    targetPrecondition: mutatePrecondition === undefined
      ? currentPrecondition
      : mutatePrecondition(currentPrecondition),
    evidence: [],
  });
  const previous = {
    ...initial,
    rawFindings: [...initial.rawFindings, source],
    rawCanonicalSnapshots: [
      ...initial.rawCanonicalSnapshots,
      rawCanonicalSnapshotFixture(source, beforeObservation),
    ],
  };
  const target = previous.findings[0]!;
  const resolved = applyFindingLedgerFixtureRevision({
    ledger: previous,
    entityKind: 'finding',
    entity: {
      ...target,
      status: 'resolved',
      lifecycle: 'resolved',
      revision: target.revision + 1,
      lastSeen: afterObservation,
      resolvedAt: afterObservation.timestamp,
      resolvedEvidence: 'Verified resolution.',
    },
  });
  const anomalyEntry = anomaly({ sourceRawFindingIds: [source.rawFindingId] });
  return {
    previous,
    anomaliesApplied: {
      ...previous,
      reviewerAnomalies: [anomalyEntry],
    },
    next: {
      ...resolved,
      reviewerAnomalies: [anomalyEntry],
    },
  };
}

function historicalTerminalDismissalFixture(
  mutatePrecondition?: (
    precondition: FindingMutationPrecondition,
  ) => FindingMutationPrecondition,
): {
  eventBaseline: FindingLedger;
  anomalyLedger: FindingLedger;
  next: FindingLedger;
} {
  const { next: dismissed } = terminalDismissalFixture();
  const {
    reviewerAnomalies: _reviewerAnomalies,
    ...eventBaseline
  } = dismissed;
  const currentPrecondition = captureFindingMutationPrecondition(
    eventBaseline,
    'F-0001',
  )!;
  const sourceRaws = [1, 2, 3].map((index) => canonicalRawFindingFixture({
    rawFindingId: `raw-historical-dismiss-${index}`,
    stepName: 'architecture',
    reviewer: 'architecture',
    relation: 'reopened',
    targetFindingId: 'F-0001',
    targetPrecondition: index === 3 && mutatePrecondition !== undefined
      ? mutatePrecondition(currentPrecondition)
      : currentPrecondition,
    evidence: [],
  }));
  const anomalyEntry = anomaly({
    id: 'RA-HISTORICAL-DISMISS',
    sourceRawFindingIds: sourceRaws.map((raw) => raw.rawFindingId),
    firstObserved: historicalObservation,
    lastObserved: historicalObservation,
  });
  const anomalyLedger = {
    ...eventBaseline,
    rawFindings: [...eventBaseline.rawFindings, ...sourceRaws],
    rawCanonicalSnapshots: [
      ...eventBaseline.rawCanonicalSnapshots,
      ...sourceRaws.map((raw) => rawCanonicalSnapshotFixture(raw, historicalObservation)),
    ],
    reviewerAnomalies: [anomalyEntry],
  };
  return {
    eventBaseline,
    anomalyLedger,
    next: { ...anomalyLedger },
  };
}

function historicalVerifiedResolutionFixture(
  mutatePrecondition?: (
    precondition: FindingMutationPrecondition,
  ) => FindingMutationPrecondition,
): {
  eventBaseline: FindingLedger;
  anomalyLedger: FindingLedger;
} {
  const { next: resolvedWithAnomaly } = verifiedResolutionFixture();
  const {
    reviewerAnomalies: _reviewerAnomalies,
    ...eventBaseline
  } = resolvedWithAnomaly;
  const currentPrecondition = captureFindingMutationPrecondition(
    eventBaseline,
    'F-0001',
  )!;
  const sourceRaws = [1, 2, 3].map((index) => canonicalRawFindingFixture({
    rawFindingId: `raw-historical-resolution-${index}`,
    stepName: 'architecture',
    reviewer: 'architecture',
    relation: 'reopened',
    targetFindingId: 'F-0001',
    targetPrecondition: index === 3 && mutatePrecondition !== undefined
      ? mutatePrecondition(currentPrecondition)
      : currentPrecondition,
    evidence: [],
  }));
  const anomalyEntry = anomaly({
    id: 'RA-HISTORICAL-RESOLUTION',
    sourceRawFindingIds: sourceRaws.map((raw) => raw.rawFindingId),
    firstObserved: historicalObservation,
    lastObserved: historicalObservation,
  });
  return {
    eventBaseline,
    anomalyLedger: {
      ...eventBaseline,
      rawFindings: [...eventBaseline.rawFindings, ...sourceRaws],
      rawCanonicalSnapshots: [
        ...eventBaseline.rawCanonicalSnapshots,
        ...sourceRaws.map((raw) => rawCanonicalSnapshotFixture(raw, historicalObservation)),
      ],
      reviewerAnomalies: [anomalyEntry],
    },
  };
}

describe('reviewer anomaly settlement', () => {
  it('同一manager roundで観測したanomalyをverified resolve後にsettleする', () => {
    const { previous, anomaliesApplied, next } = verifiedResolutionFixture();
    const resolutionEvent = next.lifecycleEvents.find(
      (event) => event.operation === 'resolve_finding',
    )!;
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      previous,
      anomaliesApplied,
      next,
      WORKFLOW_TASK_DIGEST,
    );

    expect(settled.reviewerAnomalies).toEqual([
      expect.objectContaining({
        id: 'RA-1',
        settlement: {
          kind: 'target_resolved_by_verified_evidence',
          findingId: 'F-0001',
          lifecycleEventId: resolutionEvent.eventId,
        },
      }),
    ]);
    expect(isOutstandingReviewerAnomaly(settled.reviewerAnomalies![0]!)).toBe(false);
    expect(buildFindingsRuleContext(settled, process.cwd(), new Map()).reviewerAnomalies.count).toBe(0);
    expect(buildLoopMonitorFindingsSummaryData(settled, {}).reviewerAnomalies.count).toBe(0);
    expect(attachReviewIntegrityState(
      previous,
      settled,
      resolveReviewIntegrityLimits(undefined),
      'round-2',
      afterObservation.timestamp,
    ).reviewIntegrity).toBeUndefined();
  });

  /**
   * 決着判定は候補を選ぶ anomalyLedger（コミット途中のビュー）ではなく、settlement を
   * 書き込む nextLedger の episode で行う。同じコミット内で先に走る
   * applyIntakeContractTerminalDispositions が終端処分を付けている場合、古いビューで
   * 判定すると終端処分と settlement の同居違反を作る。
   */
  it('nextLedger側で終端処分を得たanomalyへはsettlementを書かない', () => {
    const { previous, anomaliesApplied, next } = verifiedResolutionFixture();
    const intakeContract = {
      observationClass: 'claim-bearing' as const,
      classificationAuthorityId: 'system/intake_observation_classification_v1' as const,
      reasonCodes: ['product-identity-incomplete' as const],
      // 実データの旧契約語彙（binary 昇順・重複なし）。
      missingRequirements: ['relation' as const, 'severity' as const],
      presentationOwnerReviewer: 'architecture',
      presentationLimit: 6,
    };
    const openEpisode: ReviewerAnomalyEntry = {
      ...anomaliesApplied.reviewerAnomalies![0]!,
      kind: 'intake-contract-incomplete',
      intakeContract,
    };
    const baselineView = { ...anomaliesApplied, reviewerAnomalies: [openEpisode] };
    const openNext = { ...next, reviewerAnomalies: [openEpisode] };
    const disposedNext = {
      ...next,
      reviewerAnomalies: [{
        ...openEpisode,
        intakeContract: {
          ...intakeContract,
          terminalDisposition: {
            kind: 'restatement_exhausted_claim_bearing' as const,
            workflowOutcome: 'review_integrity_unresolved' as const,
            decidedAt: afterObservation,
            terminalPublicationId: 'publication-closed',
            reason: 'Restatement presentation limit 6 was reached without verified correspondence',
          },
        },
      }],
    };

    // 対照: 書き込み先が未決着なら同じ入力で settlement が付く。
    expect(settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      previous,
      baselineView,
      openNext,
      WORKFLOW_TASK_DIGEST,
    ).reviewerAnomalies![0]!.settlement?.kind).toBe('target_resolved_by_verified_evidence');

    const guarded = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      previous,
      baselineView,
      disposedNext,
      WORKFLOW_TASK_DIGEST,
    );

    expect(guarded.reviewerAnomalies![0]!.settlement).toBeUndefined();
    expect(guarded).toBe(disposedNext);
    assertFindingLedgerProjectionInvariant(guarded);
  });

  it.each([
    ['revision', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetRevision: precondition.targetRevision + 1,
    })],
    ['status', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetStatus: 'resolved' as const,
    })],
    ['evidence hash', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetEvidenceHash: 'f'.repeat(64),
    })],
  ])('同一round verified resolveはsource rawの%s不一致でsettleしない', (
    _label,
    mutatePrecondition,
  ) => {
    const { previous, anomaliesApplied, next }
      = verifiedResolutionFixture(mutatePrecondition);
    const result = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      previous,
      anomaliesApplied,
      next,
      WORKFLOW_TASK_DIGEST,
    );
    expect(result.reviewerAnomalies?.[0]?.settlement).toBeUndefined();

    const resolutionEvent = next.lifecycleEvents.find(
      (event) => event.operation === 'resolve_finding',
    )!;
    const forged = {
      ...next,
      reviewerAnomalies: [{
        ...next.reviewerAnomalies![0]!,
        settlement: {
          kind: 'target_resolved_by_verified_evidence' as const,
          findingId: 'F-0001',
          lifecycleEventId: resolutionEvent.eventId,
        },
      }],
    };
    expect(() => assertFindingLedgerAppendOnlyTransition(
      anomaliesApplied,
      forged,
    )).toThrow(/all source raws must match the required target head/u);
  });

  it('protocol anomalyはauthorized terminal eventでも全検証層でsettleできない', () => {
    const fixture = terminalDismissalFixture();
    const protocolAnomaly = anomaly({ kind: 'protocol-anomaly' });
    const anomaliesApplied = {
      ...fixture.anomaliesApplied,
      reviewerAnomalies: [protocolAnomaly],
    };
    const next = {
      ...fixture.next,
      reviewerAnomalies: [protocolAnomaly],
    };
    const result = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      fixture.previous,
      anomaliesApplied,
      next,
      WORKFLOW_TASK_DIGEST,
    );
    expect(result.reviewerAnomalies?.[0]?.settlement).toBeUndefined();

    const dismissalEvent = next.lifecycleEvents.find(
      (event) => event.operation === 'dismiss_finding',
    )!;
    const forged = {
      ...next,
      reviewerAnomalies: [{
        ...protocolAnomaly,
        settlement: {
          kind: 'target_dismissed_by_terminal_adjudication' as const,
          findingId: 'F-0001',
          lifecycleEventId: dismissalEvent.eventId,
        },
      }],
    };
    expect(() => assertFindingLedgerAppendOnlyTransition(
      anomaliesApplied,
      forged,
    )).toThrow(/protocol anomalies cannot be settled/u);
    expect(() => assertFindingLedgerProjectionInvariant(forged))
      .toThrow(/protocol anomalies cannot be settled/u);
  });

  it.each([
    ['anomaly以前のresolve', { eventInPrevious: true }],
    ['generic APPROVE', { eventInNext: false }],
    ['budget exhaustedのみ', { eventInNext: false, budgetExhausted: true }],
    ['証拠bindingなし', { withEvidenceBinding: false }],
    ['別targetのresolve', { targetFindingId: 'F-0004' }],
    ['dismiss', { operation: 'dismiss_finding' as const, status: 'dismissed' as const }],
    ['waive', { operation: 'waive_finding' as const, status: 'waived' as const }],
  ])('%sではsettleしない', (_label, input) => {
    const { previous, anomaliesApplied, next } = ledger(input);
    const result = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      previous,
      anomaliesApplied,
      next,
      WORKFLOW_TASK_DIGEST,
    );

    expect(result.reviewerAnomalies?.[0]?.settlement).toBeUndefined();
    expect(isOutstandingReviewerAnomaly(result.reviewerAnomalies![0]!)).toBe(true);
  });

  it('anomaly後のterminal_adjudication dismissをsettleしappend-only/SQLite遷移を保つ', async () => {
    const { previous, anomaliesApplied, next } = terminalDismissalFixture();
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      previous,
      anomaliesApplied,
      next,
      WORKFLOW_TASK_DIGEST,
    );

    expect(settled.reviewerAnomalies?.[0]?.settlement).toEqual({
      kind: 'target_dismissed_by_terminal_adjudication',
      findingId: 'F-0001',
      lifecycleEventId: next.lifecycleEvents.at(-1)?.eventId,
    });
    expect(buildFindingsRuleContext(
      settled,
      process.cwd(),
      new Map(),
    ).reviewerAnomalies.count).toBe(0);
    expect(() => assertFindingLedgerAppendOnlyTransition(
      anomaliesApplied,
      settled,
    )).not.toThrow();

    const { store } = createFindingStore('terminal-dismissal-settlement-test');
    await store.updateLedger(() => ({
      ledger: anomaliesApplied,
      result: undefined,
    }));
    await store.updateLedger(() => ({ ledger: settled, result: undefined }));
    expect(store.loadLedger().reviewerAnomalies?.[0]?.settlement).toEqual(
      settled.reviewerAnomalies?.[0]?.settlement,
    );
  });

  it('outside_task_scope dismissはworkflowTaskDigestが異なるtaskのanomalyをsettleしない', () => {
    const { previous, anomaliesApplied, next } = terminalDismissalFixture();
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      previous,
      anomaliesApplied,
      next,
      'b'.repeat(64),
    );

    expect(settled.reviewerAnomalies?.[0]?.settlement).toBeUndefined();
  });

  it('baseline DBに既存のterminal dismissへcurrent headで束縛された3 rawをsettleする', async () => {
    const {
      eventBaseline,
      anomalyLedger,
      next,
    } = historicalTerminalDismissalFixture();
    const dismissalEvent = eventBaseline.lifecycleEvents.find(
      (event) => event.operation === 'dismiss_finding',
    )!;
    const expectedPrecondition = captureFindingMutationPrecondition(
      eventBaseline,
      'F-0001',
    )!;

    expect(expectedPrecondition).toMatchObject({
      targetRevision: 2,
      targetStatus: 'dismissed',
    });
    expect(anomalyLedger.reviewerAnomalies?.[0]?.sourceRawFindingIds).toHaveLength(3);
    expect(next.lifecycleEvents).toEqual(eventBaseline.lifecycleEvents);
    for (const rawFindingId of anomalyLedger.reviewerAnomalies![0]!.sourceRawFindingIds) {
      expect(anomalyLedger.rawFindings.find(
        (raw) => raw.rawFindingId === rawFindingId,
      )?.targetPrecondition).toEqual(expectedPrecondition);
    }

    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      eventBaseline,
      anomalyLedger,
      next,
      WORKFLOW_TASK_DIGEST,
    );

    expect(settled.reviewerAnomalies?.[0]?.settlement).toEqual({
      kind: 'target_dismissed_by_terminal_adjudication',
      findingId: 'F-0001',
      lifecycleEventId: dismissalEvent.eventId,
    });
    expect(() => assertFindingLedgerAppendOnlyTransition(
      anomalyLedger,
      settled,
    )).not.toThrow();

    const { store } = createFindingStore(
      'historical-terminal-dismissal-settlement-test',
    );
    await store.updateLedger(() => ({ ledger: eventBaseline, result: undefined }));
    expect(store.loadLedger()).toMatchObject({
      lifecycleEvents: expect.arrayContaining([
        expect.objectContaining({ eventId: dismissalEvent.eventId }),
      ]),
    });
    expect(store.loadLedger().reviewerAnomalies).toBeUndefined();

    await store.updateLedger(() => ({ ledger: anomalyLedger, result: undefined }));
    expect(store.loadLedger()).toMatchObject({
      lifecycleEvents: eventBaseline.lifecycleEvents,
      reviewerAnomalies: [expect.objectContaining({
        id: 'RA-HISTORICAL-DISMISS',
      })],
    });
    expect(store.loadLedger().reviewerAnomalies?.[0]?.settlement).toBeUndefined();

    await store.updateLedger(() => ({ ledger: settled, result: undefined }));
    expect(store.loadLedger().reviewerAnomalies?.[0]?.settlement).toEqual(
      settled.reviewerAnomalies?.[0]?.settlement,
    );
  });

  it.each([
    ['revision', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetRevision: precondition.targetRevision + 1,
    })],
    ['status', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetStatus: 'resolved' as const,
    })],
    ['evidence hash', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetEvidenceHash: 'f'.repeat(64),
    })],
  ])('historical terminal dismissはsource rawの%s不一致でsettleしない', (
    _label,
    mutatePrecondition,
  ) => {
    const { eventBaseline, anomalyLedger, next }
      = historicalTerminalDismissalFixture(mutatePrecondition);
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      eventBaseline,
      anomalyLedger,
      next,
      WORKFLOW_TASK_DIGEST,
    );

    expect(settled.reviewerAnomalies?.[0]?.settlement).toBeUndefined();
  });

  it('historical outside_task_scope dismissはcurrent workflowTaskDigest不一致でsettleしない', () => {
    const { eventBaseline, anomalyLedger, next }
      = historicalTerminalDismissalFixture();
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      eventBaseline,
      anomalyLedger,
      next,
      'b'.repeat(64),
    );

    expect(settled.reviewerAnomalies?.[0]?.settlement).toBeUndefined();
  });

  it('historical verified resolutionはcurrent headに一致する3 sourceをsettleする', () => {
    const { eventBaseline, anomalyLedger }
      = historicalVerifiedResolutionFixture();
    const resolutionEvent = eventBaseline.lifecycleEvents.find(
      (event) => event.operation === 'resolve_finding',
    )!;
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      eventBaseline,
      anomalyLedger,
      anomalyLedger,
      WORKFLOW_TASK_DIGEST,
    );

    expect(settled.reviewerAnomalies?.[0]?.settlement).toEqual({
      kind: 'target_resolved_by_verified_evidence',
      findingId: 'F-0001',
      lifecycleEventId: resolutionEvent.eventId,
    });
    expect(() => assertFindingLedgerAppendOnlyTransition(
      anomalyLedger,
      settled,
    )).not.toThrow();
    expect(() => assertFindingLedgerProjectionInvariant(settled)).not.toThrow();
  });

  it.each([
    ['同一timestamp', afterObservation.timestamp],
    ['時計逆行', beforeObservation.timestamp],
  ])('%sでもhistorical settlementを構造的に保存・loadできる', (_label, timestamp) => {
    const { eventBaseline, anomalyLedger } = historicalVerifiedResolutionFixture();
    const anomalyEntry = anomalyLedger.reviewerAnomalies![0]!;
    const observed = {
      ...anomalyLedger,
      reviewerAnomalies: [{
        ...anomalyEntry,
        firstObserved: { ...anomalyEntry.firstObserved, timestamp },
        lastObserved: { ...anomalyEntry.lastObserved, timestamp },
      }],
    };
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      eventBaseline,
      observed,
      observed,
      WORKFLOW_TASK_DIGEST,
    );

    expect(settled.reviewerAnomalies?.[0]?.settlement?.lifecycleEventId)
      .toBe(eventBaseline.lifecycleEvents.at(-1)?.eventId);
    expect(() => assertFindingLedgerAppendOnlyTransition(observed, settled)).not.toThrow();
    expect(() => assertFindingLedgerProjectionInvariant(settled)).not.toThrow();
  });

  it('historical sourceのhead以前に複数terminal eventがある場合は最新eventだけを選ぶ', () => {
    const { eventBaseline } = historicalVerifiedResolutionFixture();
    const original = eventBaseline.findings[0]!;
    const {
      resolvedAt: _resolvedAt,
      resolvedEvidence: _resolvedEvidence,
      ...withoutResolution
    } = original;
    const reopened = applyFindingLedgerFixtureRevision({
      ledger: eventBaseline,
      entityKind: 'finding',
      entity: {
        ...withoutResolution,
        status: 'open',
        lifecycle: 'reopened',
        revision: original.revision + 1,
        reopenedEvidence: 'Verified recurrence.',
      },
    });
    const resolvedAgain = applyFindingLedgerFixtureRevision({
      ledger: reopened,
      entityKind: 'finding',
      entity: {
        ...reopened.findings[0]!,
        status: 'resolved',
        lifecycle: 'resolved',
        revision: reopened.findings[0]!.revision + 1,
        resolvedAt: historicalObservation.timestamp,
        resolvedEvidence: 'Verified again.',
      },
    });
    const raw = canonicalRawFindingFixture({
      rawFindingId: 'raw-after-second-resolution',
      stepName: 'architecture',
      reviewer: 'architecture',
      relation: 'reopened',
      targetFindingId: 'F-0001',
      targetPrecondition: captureFindingMutationPrecondition(resolvedAgain, 'F-0001')!,
      evidence: [],
    });
    const observed = {
      ...resolvedAgain,
      rawFindings: [...resolvedAgain.rawFindings, raw],
      reviewerAnomalies: [anomaly({ sourceRawFindingIds: [raw.rawFindingId] })],
    };
    const resolutionEvents = resolvedAgain.lifecycleEvents.filter(
      (event) => event.operation === 'resolve_finding',
    );
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      resolvedAgain,
      observed,
      observed,
      WORKFLOW_TASK_DIGEST,
    );

    expect(resolutionEvents).toHaveLength(2);
    expect(settled.reviewerAnomalies?.[0]?.settlement?.lifecycleEventId)
      .toBe(resolutionEvents.at(-1)?.eventId);
  });

  it.each([
    ['revision', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetRevision: precondition.targetRevision + 1,
    })],
    ['status', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetStatus: 'dismissed' as const,
    })],
    ['evidence hash', (precondition: FindingMutationPrecondition) => ({
      ...precondition,
      targetEvidenceHash: 'e'.repeat(64),
    })],
  ])('historical verified resolutionは1/3 sourceの%s不一致で全体をsettleしない', (
    _label,
    mutatePrecondition,
  ) => {
    const { eventBaseline, anomalyLedger }
      = historicalVerifiedResolutionFixture(mutatePrecondition);
    const result = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      eventBaseline,
      anomalyLedger,
      anomalyLedger,
      WORKFLOW_TASK_DIGEST,
    );
    expect(result.reviewerAnomalies?.[0]?.settlement).toBeUndefined();

    const resolutionEvent = eventBaseline.lifecycleEvents.find(
      (event) => event.operation === 'resolve_finding',
    )!;
    const forged = {
      ...anomalyLedger,
      reviewerAnomalies: [{
        ...anomalyLedger.reviewerAnomalies![0]!,
        settlement: {
          kind: 'target_resolved_by_verified_evidence' as const,
          findingId: 'F-0001',
          lifecycleEventId: resolutionEvent.eventId,
        },
      }],
    };
    expect(() => assertFindingLedgerAppendOnlyTransition(
      anomalyLedger,
      forged,
    )).toThrow(/all source raws must match the required target head/u);
    expect(() => assertFindingLedgerProjectionInvariant(forged))
      .toThrow(/all source raws must match the required target head/u);
  });

  it('current target preconditionで束縛されたhistorical verified resolutionを安全にsettleする', () => {
    const resolvedWithSettlement = validSettledLedger();
    const resolved = {
      ...resolvedWithSettlement,
      reviewerAnomalies: undefined,
    };
    const raw = canonicalRawFindingFixture({
      rawFindingId: 'raw-historical-observation',
      stepName: 'architecture',
      reviewer: 'architecture',
      relation: 'reopened',
      targetFindingId: 'F-0001',
      targetPrecondition: captureFindingMutationPrecondition(
        resolved,
        'F-0001',
      )!,
      evidence: [],
    });
    const baseline = {
      ...resolved,
      rawFindings: [...resolved.rawFindings, raw],
      reviewerAnomalies: [anomaly({
        id: 'RA-HISTORICAL',
        sourceRawFindingIds: [raw.rawFindingId],
      })],
    };
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      baseline,
      baseline,
      baseline,
      WORKFLOW_TASK_DIGEST,
    );

    expect(settled.reviewerAnomalies?.[0]?.settlement).toMatchObject({
      kind: 'target_resolved_by_verified_evidence',
      findingId: 'F-0001',
    });
    expect(() => assertFindingLedgerAppendOnlyTransition(
      baseline,
      settled,
    )).not.toThrow();
  });

  it('settlementの削除・差替えと過去eventへの後付けを拒否する', () => {
    const settled = validSettledLedger();
    const [settledAnomaly] = settled.reviewerAnomalies!;
    const { settlement: _settlement, ...unsettledAnomaly } = settledAnomaly!;
    const unsettled = {
      ...settled,
      reviewerAnomalies: [unsettledAnomaly],
    };

    expect(() => assertFindingLedgerAppendOnlyTransition(unsettled, settled))
      .toThrow(/all source raws must match the required target head/u);
    expect(() => assertFindingLedgerAppendOnlyTransition(settled, unsettled))
      .toThrow(/settlement cannot be removed or replaced/u);
  });

  it.each([
    ['kind', (entry: ReviewerAnomalyEntry) => ({ ...entry, kind: 'stale-snapshot' as const })],
    ['stableKey', (entry: ReviewerAnomalyEntry) => ({ ...entry, stableKey: 'replaced' })],
    ['lineageKey', (entry: ReviewerAnomalyEntry) => ({ ...entry, lineageKey: 'replaced' })],
    ['firstObserved', (entry: ReviewerAnomalyEntry) => ({
      ...entry,
      firstObserved: { ...entry.firstObserved, runId: 'replaced' },
    })],
    ['sourceRawFindingIds', (entry: ReviewerAnomalyEntry) => ({
      ...entry,
      sourceRawFindingIds: entry.sourceRawFindingIds.slice(1),
    })],
    ['sourceIntakeIds', (entry: ReviewerAnomalyEntry) => ({ ...entry, sourceIntakeIds: [] })],
    ['reviewers', (entry: ReviewerAnomalyEntry) => ({ ...entry, reviewers: [] })],
    ['occurrences', (entry: ReviewerAnomalyEntry) => ({ ...entry, occurrences: 1 })],
  ])('append-only境界は既存anomalyの%s巻き戻しを拒否する', (_label, mutate) => {
    const { anomalyLedger } = historicalVerifiedResolutionFixture();
    const existing = {
      ...anomalyLedger.reviewerAnomalies![0]!,
      sourceIntakeIds: ['intake-1'],
      reviewers: ['architecture', 'ai-antipattern'],
      occurrences: 2,
    };
    const current = { ...anomalyLedger, reviewerAnomalies: [existing] };
    const next = { ...current, reviewerAnomalies: [mutate(existing)] };

    expect(() => assertFindingLedgerAppendOnlyTransition(current, next)).toThrow();
  });

  it('settlement後の正当なreopenを許可しSQLite revisionからloadする', async () => {
    const runId = 'reviewer-anomaly-settlement-test';
    const { projectCwd, store } = createFindingStore(runId);
    const fixture = verifiedResolutionFixture();
    await store.updateLedger(() => ({
      ledger: fixture.previous,
      result: undefined,
    }));
    await store.updateLedger(() => ({
      ledger: fixture.anomaliesApplied,
      result: undefined,
    }));
    const settled = settleReviewerAnomaliesFromAuthorizedTerminalEvents(
      fixture.previous,
      fixture.anomaliesApplied,
      fixture.next,
      WORKFLOW_TASK_DIGEST,
    );
    await store.updateLedger(() => ({ ledger: settled, result: undefined }));
    expect(store.loadLedger().reviewerAnomalies).toEqual(settled.reviewerAnomalies);

    const reopened = applyFindingLedgerFixtureRevision({
      ledger: settled,
      entityKind: 'finding',
      entity: {
        ...settled.findings[0]!,
        status: 'open',
        lifecycle: 'reopened',
        revision: settled.findings[0]!.revision + 1,
        lastSeen: {
          ...afterObservation,
          timestamp: '2026-07-31T00:02:00.000Z',
        },
        reopenedEvidence: 'A verified recurrence reopened the finding.',
      },
    });
    expect(() => assertFindingLedgerAppendOnlyTransition(settled, reopened)).not.toThrow();
    await store.updateLedger(() => ({ ledger: reopened, result: undefined }));
    expect(store.loadLedger()).toMatchObject({
      findings: [{ id: 'F-0001', status: 'open', lifecycle: 'reopened' }],
      reviewerAnomalies: settled.reviewerAnomalies,
    });

    const {
      resolvedAt: _resolvedAt,
      resolvedEvidence: _resolvedEvidence,
      reopenedEvidence: _reopenedEvidence,
      ...reopenedFinding
    } = reopened.findings[0]!;
    const withCanonical = applyFindingLedgerFixtureRevision({
      ledger: { ...reopened, nextId: 3 },
      entityKind: 'finding',
      entity: {
        ...reopenedFinding,
        id: 'F-0002',
        status: 'open',
        lifecycle: 'new',
        revision: 1,
        evidenceIds: [...reopenedFinding.evidenceIds],
        rawFindingIds: [],
        firstSeen: {
          ...afterObservation,
          timestamp: '2026-07-31T00:03:00.000Z',
        },
        lastSeen: {
          ...afterObservation,
          timestamp: '2026-07-31T00:03:00.000Z',
        },
      },
    });
    await store.updateLedger(() => ({ ledger: withCanonical, result: undefined }));
    const superseded = applyFindingLedgerFixtureSupersession({
      ledger: withCanonical,
      canonicalFindingId: 'F-0002',
      duplicates: [{
        ...withCanonical.findings.find((finding) => finding.id === 'F-0001')!,
        status: 'superseded',
        lifecycle: 'superseded',
        supersededByFindingId: 'F-0002',
        lastSeen: {
          ...afterObservation,
          timestamp: '2026-07-31T00:04:00.000Z',
        },
      }],
    });
    expect(() => assertFindingLedgerAppendOnlyTransition(withCanonical, superseded)).not.toThrow();
    await store.updateLedger(() => ({ ledger: superseded, result: undefined }));
    expect(store.loadLedger()).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({
          id: 'F-0001',
          status: 'superseded',
          supersededByFindingId: 'F-0002',
        }),
      ]),
      reviewerAnomalies: settled.reviewerAnomalies,
    });

    cleanupTestFindingStorage();
    const reopenedStore = createTestFindingLedgerStore({
      projectCwd,
      runId,
      reportDir: join(projectCwd, '.takt', 'runs', runId, 'reports'),
      workflowName: 'default',
    });
    expect(reopenedStore.loadLedger()).toEqual(superseded);
  });
});
