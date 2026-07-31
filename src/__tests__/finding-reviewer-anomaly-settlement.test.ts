import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  FindingEvidenceRecord,
  FindingLedger,
  FindingLifecycleEvent,
  FindingLifecycleOperation,
  ReviewerAnomalyEntry,
} from '../core/workflow/findings/types.js';
import {
  isOutstandingReviewerAnomaly,
} from '../core/workflow/findings/reviewer-anomalies.js';
import {
  settleReviewerAnomaliesFromVerifiedResolutions,
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
} from './helpers/finding-lifecycle-fixture.js';
import {
  cleanupRealRunStorages,
  createRealRunStorage,
} from './helpers/run-storage.js';

afterEach(cleanupRealRunStorages);

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
  return {
    eventId: `event-${operation}-${findingId}`,
    mutationId: `mutation-${operation}-${findingId}`,
    reservationId: `reservation-${operation}-${findingId}`,
    operation,
    transitions: [{
      before: null,
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
      targets: [],
      evidenceBindingIds: event.evidenceBindingIds,
      authority: { kind: 'verified_evidence' },
      context: { kind: 'transaction' },
      reservedAt: afterObservation,
    }],
    lifecycleEvents: input.eventInPrevious === true ? [event] : [],
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [source],
    conflicts: [],
    interpretations: [],
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
    rawRecoveryAttempts: [],
    rawRecoveryResults: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
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

describe('reviewer anomaly settlement', () => {
  it('同一manager roundで観測したanomalyをverified resolve後にsettleする', () => {
    const { previous, anomaliesApplied, next } = ledger();
    const settled = settleReviewerAnomaliesFromVerifiedResolutions(
      previous,
      anomaliesApplied,
      next,
    );

    expect(settled.reviewerAnomalies).toEqual([
      expect.objectContaining({
        id: 'RA-1',
        settlement: {
          kind: 'target_resolved_by_verified_evidence',
          findingId: 'F-0003',
          lifecycleEventId: 'event-resolve_finding-F-0003',
        },
      }),
    ]);
    expect(isOutstandingReviewerAnomaly(settled.reviewerAnomalies![0]!)).toBe(false);
    expect(buildFindingsRuleContext(settled, process.cwd()).reviewerAnomalies.count).toBe(0);
    expect(buildLoopMonitorFindingsSummaryData(settled, {}).reviewerAnomalies.count).toBe(0);
    expect(attachReviewIntegrityState(
      previous,
      settled,
      resolveReviewIntegrityLimits(undefined),
      'round-2',
      afterObservation.timestamp,
    ).reviewIntegrity).toBeUndefined();
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
    const result = settleReviewerAnomaliesFromVerifiedResolutions(
      previous,
      anomaliesApplied,
      next,
    );

    expect(result.reviewerAnomalies?.[0]?.settlement).toBeUndefined();
    expect(isOutstandingReviewerAnomaly(result.reviewerAnomalies![0]!)).toBe(true);
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
      .toThrow(/event added in the same transition/u);
    expect(() => assertFindingLedgerAppendOnlyTransition(settled, unsettled))
      .toThrow(/settlement cannot be removed or replaced/u);
  });

  it('settlement後の正当なreopenを許可しSQLite revisionからloadする', async () => {
    const { databasePath, root } = createRealRunStorage({
      findingContractEnabled: true,
    });
    const lease = root.claimLease({
      ownerKey: 'reviewer-anomaly-settlement-test',
      leaseDurationMs: 10_000,
    });
    const execution = root.runtime({ lease }).execution.startStep({
      stepKey: 'findings-manager',
      expectedScopeRevision: 0,
    });
    const store = root.runtime({ lease }).findingManager({
      workflowName: 'default',
      producer: execution.handle,
    });
    const settled = validSettledLedger();

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

    root.close();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(`
      SELECT count(*) AS count
      FROM finding_reviewer_anomaly_entries
      WHERE revision IN (2, 3, 4, 5)
    `).get()).toEqual({ count: 4 });
    expect(database.prepare(`
      SELECT count(*) AS count
      FROM finding_ledger_revisions
    `).get()).toEqual({ count: 5 });
    database.close();
  });
});
