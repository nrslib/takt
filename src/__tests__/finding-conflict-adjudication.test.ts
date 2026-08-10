import { describe, expect, it } from 'vitest';
import { createEmptyFindingContractRegistries } from '../core/models/finding-contract-seed.js';
import type {
  ConflictAdjudicationSnapshot,
  ConflictClaimSettlement,
  ConflictClaimSubject,
} from '../core/models/finding-contract-types.js';
import { hasVerifiedOrdinaryLifecycleCoverage } from '../core/models/finding-lifecycle-continuity.js';
import type {
  EngineProofRecord,
  FindingLedger,
  FindingLifecycleEntityHead,
  FindingLifecycleEvent,
} from '../core/workflow/findings/types.js';
import {
  hasSubstantiveVerifiedSettlementWitness,
  isConflictResolved,
} from '../core/workflow/findings/conflict-adjudication-model.js';
import {
  buildConflictAdjudicationSnapshotReference,
} from '../core/workflow/findings/adjudication-evidence.js';
import { resolveConflictAdjudicationPlan } from '../core/workflow/findings/conflict-adjudication-verifier.js';

const OBSERVATION = {
  runId: 'run-conflict',
  stepName: 'finding-conflict-adjudication',
  timestamp: '2026-08-02T00:00:00.000Z',
};

function head(entityKind: 'finding' | 'conflict', entityId: string, revision: number): FindingLifecycleEntityHead {
  return {
    entityKind,
    entityId,
    revision,
    eventId: `event-${entityId}-${revision}`,
    projectionDigest: `projection-${entityId}-${revision}`,
  };
}

function event(
  operation: FindingLifecycleEvent['operation'],
  before: FindingLifecycleEntityHead | null,
  after: FindingLifecycleEntityHead,
): FindingLifecycleEvent {
  return {
    eventId: after.eventId,
    mutationId: `mutation-${after.eventId}`,
    reservationId: `reservation-${after.eventId}`,
    operation,
    transitions: [{ before, after }],
    evidenceBindingIds: [],
    outcome: { kind: 'projection_applied' },
    resultDigest: `result-${after.eventId}`,
    occurredAt: OBSERVATION,
  };
}

function emptyLedger(overrides: Partial<FindingLedger> = {}): FindingLedger {
  return {
    workflowName: 'peer-review',
    nextId: 3,
    updatedAt: OBSERVATION.timestamp,
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    evidenceBindings: [],
    lifecycleReservations: [],
    lifecycleEvents: [],
    ...createEmptyFindingContractRegistries(),
    ...overrides,
  };
}

function subject(findingId: string, expectedHead: FindingLifecycleEntityHead): ConflictClaimSubject {
  return {
    subjectId: `subject-${findingId}`,
    conflictId: 'C-0001',
    role: 'product_finding',
    findingId,
    expectedHead,
    targetIdentityHash: `target-${findingId}`,
    claimIdentityHash: `claim-${findingId}`,
    semanticClaimIdentityHash: `semantic-${findingId}`,
    claimSnapshotDigest: `snapshot-${findingId}`,
    sourceRawFindingIds: [],
    sourceRawPayloadDigests: [],
    evidenceBindingIds: [],
    evidenceSetDigest: `evidence-${findingId}`,
    rawClaimLandingIds: [],
  };
}

function snapshot(subjects: ConflictClaimSubject[]): ConflictAdjudicationSnapshot {
  return {
    conflictSnapshotId: 'conflict-snapshot-1',
    conflictId: 'C-0001',
    expectedConflictHead: head('conflict', 'C-0001', 1),
    claimUniverseDigest: 'universe',
    coverageSnapshotDigest: 'coverage',
    evidenceSnapshotDigest: 'evidence',
    rawClaimLandingIds: [],
    priorSettlementIds: [],
    subjects,
    originStep: null,
    createdAt: OBSERVATION,
  };
}

describe('finding lifecycle continuity', () => {
  it('accepts exact current head with no later lifecycle event', () => {
    const expected = head('finding', 'F-0001', 1);
    expect(hasVerifiedOrdinaryLifecycleCoverage({
      lifecycleEvents: [event('create_finding', null, expected)],
      findingId: 'F-0001',
      expectedHead: expected,
    })).toBe(true);
  });

  it('keeps coverage through resolved, reopened, and invalidated revisions of the same finding', () => {
    const first = head('finding', 'F-0001', 1);
    const resolved = head('finding', 'F-0001', 2);
    const reopened = head('finding', 'F-0001', 3);
    const invalidated = head('finding', 'F-0001', 4);
    expect(hasVerifiedOrdinaryLifecycleCoverage({
      lifecycleEvents: [
        event('create_finding', null, first),
        event('resolve_finding', first, resolved),
        event('reopen_finding', resolved, reopened),
        event('invalidate_finding', reopened, invalidated),
      ],
      findingId: 'F-0001',
      expectedHead: first,
    })).toBe(true);
  });

  it('rejects a broken chain and never hops to another finding id', () => {
    const first = head('finding', 'F-0001', 1);
    const other = head('finding', 'F-0002', 2);
    const broken = head('finding', 'F-0001', 3);
    expect(hasVerifiedOrdinaryLifecycleCoverage({
      lifecycleEvents: [event('create_finding', null, first), event('persist_finding', other, broken)],
      findingId: 'F-0001',
      expectedHead: first,
    })).toBe(false);
  });
});

describe('verified conflict adjudication', () => {
  it('selects the recent reference window by observation order and keeps set digests deterministic', () => {
    const claim = {
      ...subject('F-0001', head('finding', 'F-0001', 1)),
      sourceRawFindingIds: ['raw-a', 'raw-b', 'raw-c', 'raw-d'],
      sourceRawPayloadDigests: ['payload-a', 'payload-b', 'payload-c', 'payload-d'],
      evidenceBindingIds: ['binding-a', 'binding-b', 'binding-c', 'binding-d'],
      rawClaimLandingIds: ['landing-a', 'landing-b', 'landing-c', 'landing-d'],
      role: 'holding_provisional' as const,
    };
    const current = snapshot([claim]);
    current.rawClaimLandingIds = ['landing-a', 'landing-b', 'landing-c', 'landing-d'];
    current.priorSettlementIds = ['settlement-a', 'settlement-b', 'settlement-c', 'settlement-d'];
    const observation = (timestamp: string) => ({
      runId: 'run-history',
      stepName: 'reviewers',
      timestamp,
    });
    const history = {
      sourceRawFindingIds: new Map([
        ['raw-a', observation('2026-08-04T00:00:04.000Z')],
        ['raw-b', observation('2026-08-04T00:00:01.000Z')],
        ['raw-c', observation('2026-08-04T00:00:03.000Z')],
        ['raw-d', observation('2026-08-04T00:00:02.000Z')],
      ]),
      sourceRawPayloadDigests: new Map([
        ['payload-a', observation('2026-08-04T00:00:04.000Z')],
        ['payload-b', observation('2026-08-04T00:00:01.000Z')],
        ['payload-c', observation('2026-08-04T00:00:03.000Z')],
        ['payload-d', observation('2026-08-04T00:00:02.000Z')],
      ]),
      evidenceBindingIds: new Map([
        ['binding-a', observation('2026-08-04T00:00:04.000Z')],
        ['binding-b', observation('2026-08-04T00:00:01.000Z')],
        ['binding-c', observation('2026-08-04T00:00:03.000Z')],
        ['binding-d', observation('2026-08-04T00:00:02.000Z')],
      ]),
      rawClaimLandingIds: new Map([
        ['landing-a', observation('2026-08-04T00:00:04.000Z')],
        ['landing-b', observation('2026-08-04T00:00:01.000Z')],
        ['landing-c', observation('2026-08-04T00:00:03.000Z')],
        ['landing-d', observation('2026-08-04T00:00:02.000Z')],
      ]),
      priorSettlementIds: new Map([
        ['settlement-a', observation('2026-08-04T00:00:04.000Z')],
        ['settlement-b', observation('2026-08-04T00:00:01.000Z')],
        ['settlement-c', observation('2026-08-04T00:00:03.000Z')],
        ['settlement-d', observation('2026-08-04T00:00:02.000Z')],
      ]),
    };

    const reference = buildConflictAdjudicationSnapshotReference(current, history);

    expect(reference.rawClaimLandingIds).toEqual(['landing-d', 'landing-c', 'landing-a']);
    expect(reference.priorSettlementIds).toEqual(['settlement-d', 'settlement-c', 'settlement-a']);
    expect(reference.subjects[0]?.sourceRawFindingIds)
      .toEqual(['raw-d', 'raw-c', 'raw-a']);
    expect(reference.subjects[0]?.evidenceBindingIds)
      .toEqual(['binding-d', 'binding-c', 'binding-a']);
    const reordered = {
      ...current,
      rawClaimLandingIds: [...current.rawClaimLandingIds].reverse(),
      priorSettlementIds: [...current.priorSettlementIds].reverse(),
      subjects: current.subjects.map((subject) => ({
        ...subject,
        sourceRawFindingIds: [...subject.sourceRawFindingIds].reverse(),
        sourceRawPayloadDigests: [...subject.sourceRawPayloadDigests].reverse(),
        evidenceBindingIds: [...subject.evidenceBindingIds].reverse(),
        rawClaimLandingIds: [...subject.rawClaimLandingIds].reverse(),
      })),
    };
    expect(reference.rawClaimLandingDigest).toBe(
      buildConflictAdjudicationSnapshotReference(reordered, history).rawClaimLandingDigest,
    );
    expect(reference.subjects[0]?.sourceRawPayloadDigest).toBe(
      buildConflictAdjudicationSnapshotReference(reordered, history)
        .subjects[0]?.sourceRawPayloadDigest,
    );
    expect(reference.subjects[0]?.sourceRawPayloadIds).toEqual(
      ['payload-d', 'payload-c', 'payload-a'],
    );
  });

  it('keeps emoji intact when compacting at surrogate boundaries', () => {
    const rawFindingId = `${'a'.repeat(11)}😀${'b'.repeat(200)}😀${'c'.repeat(11)}`;
    const current = snapshot([{
      ...subject('F-0001', head('finding', 'F-0001', 1)),
      sourceRawFindingIds: [rawFindingId],
    }]);
    const history = {
      sourceRawFindingIds: new Map([[rawFindingId, OBSERVATION]]),
      sourceRawPayloadDigests: new Map(),
      evidenceBindingIds: new Map(),
      rawClaimLandingIds: new Map(),
      priorSettlementIds: new Map(),
    };

    const compact = buildConflictAdjudicationSnapshotReference(current, history)
      .subjects[0]?.sourceRawFindingIds[0];

    expect(compact).toMatch(
      new RegExp(
        `^raw-ref:${'a'.repeat(11)}😀…😀${'c'.repeat(11)}#sha256:[0-9a-f]{64}$`,
        'u',
      ),
    );
  });

  it('issues branded terminate authority only for an exactly bound engine proof', () => {
    const findingHead = head('finding', 'F-0001', 1);
    const conflictHead = head('conflict', 'C-0001', 1);
    const claim = subject('F-0001', findingHead);
    const evidence: EngineProofRecord = {
      evidenceId: 'proof-record-1',
      proofId: 'proof-1',
      kind: 'engine_proof',
      purpose: 'lifecycle_authority',
      claimIdentityHash: null,
      verifierId: 'fixture-verifier',
      verifierVersion: '1',
      workflowName: 'peer-review',
      runId: OBSERVATION.runId,
      scopeIdentity: 'scope-1',
      snapshotId: 'snapshot-1',
      targetFindingId: 'F-0001',
      dependencyDigests: [],
      resultDigest: 'result-1',
      issuedAt: OBSERVATION.timestamp,
      subject: {
        kind: 'finding_claim_refuted',
        adjudicationKind: 'conflict',
        subjectId: claim.subjectId,
        findingId: claim.findingId,
        expectedHead: findingHead,
        claimSnapshotDigest: claim.claimSnapshotDigest,
        rawClaimRefIds: [],
      },
    };
    const ledger = emptyLedger({
      evidenceRecords: [evidence],
      lifecycleEvents: [
        event('create_finding', null, findingHead),
        event('create_conflict', null, conflictHead),
      ],
    });
    const plan = resolveConflictAdjudicationPlan({
      ledger,
      snapshot: snapshot([claim]),
      proposal: {
        kind: 'terminate_subject',
        subjectId: claim.subjectId,
        basis: 'finding_claim_refuted',
        authorityRefIds: [evidence.evidenceId],
      },
    });
    expect(plan).toMatchObject({
      kind: 'terminate_subject',
      authority: {
        kind: 'terminate_subject',
        conflictSnapshotId: 'conflict-snapshot-1',
        findingId: 'F-0001',
        proofRecordIds: ['proof-record-1'],
      },
    });
  });

  it('fails closed when the proof is absent', () => {
    const findingHead = head('finding', 'F-0001', 1);
    const conflictHead = head('conflict', 'C-0001', 1);
    const claim = subject('F-0001', findingHead);
    const plan = resolveConflictAdjudicationPlan({
      ledger: emptyLedger({ lifecycleEvents: [
        event('create_finding', null, findingHead),
        event('create_conflict', null, conflictHead),
      ] }),
      snapshot: snapshot([claim]),
      proposal: {
        kind: 'terminate_subject',
        subjectId: claim.subjectId,
        basis: 'finding_claim_refuted',
        authorityRefIds: ['missing-proof'],
      },
    });
    expect(plan).toEqual({ kind: 'undetermined', reasonCodes: ['authority_not_found'] });
  });

  it('requires a substantive settlement witness for product-only multiple claims', () => {
    const firstHead = head('finding', 'F-0001', 1);
    const secondHead = head('finding', 'F-0002', 1);
    const conflictHead = head('conflict', 'C-0001', 1);
    const claims = [subject('F-0001', firstHead), subject('F-0002', secondHead)];
    const adjudicationSnapshot = snapshot(claims);
    const settlement: ConflictClaimSettlement = {
      settlementId: 'settlement-1',
      conflictId: 'C-0001',
      conflictSnapshotId: adjudicationSnapshot.conflictSnapshotId,
      subjectId: claims[0]!.subjectId,
      subjectRole: 'product_finding',
      findingId: 'F-0001',
      expectedHead: firstHead,
      attemptId: 'attempt-1',
      rawClaimLandingIds: [],
      lifecycleEventIds: [firstHead.eventId],
      verificationDigest: 'verification-1',
      recordedAt: OBSERVATION,
      outcome: 'resolved',
    };
    const base = emptyLedger({
      conflicts: [{
        id: 'C-0001',
        findingIds: ['F-0001', 'F-0002'],
        rawFindingIds: [],
        description: 'Product-only conflict',
        status: 'active',
        revision: 1,
        lastSeen: OBSERVATION,
      }],
      lifecycleEvents: [
        event('create_finding', null, firstHead),
        event('create_finding', null, secondHead),
        event('create_conflict', null, conflictHead),
      ],
      conflictAdjudicationSnapshots: [adjudicationSnapshot],
    });
    expect(hasSubstantiveVerifiedSettlementWitness(base, 'C-0001')).toBe(false);
    const settled = emptyLedger({
      ...base,
      conflictClaimSettlements: [settlement],
      conflictAdjudicationAttempts: [{
        attemptId: 'attempt-1',
        episodeId: 'episode-1',
        conflictSnapshotId: adjudicationSnapshot.conflictSnapshotId,
        conflictId: 'C-0001',
        expectedConflictHead: conflictHead,
        attemptOrdinal: 1,
        retryOrdinal: 0,
        providerCallId: 'provider-call-1',
        requestDigest: 'request-1',
        subjectIds: claims.map(({ subjectId }) => subjectId),
        originStep: null,
        stage: 'applied',
        startedAt: OBSERVATION,
        completedAt: OBSERVATION,
        appliedAt: OBSERVATION,
        proposal: {
          kind: 'terminate_subject',
          subjectId: claims[0]!.subjectId,
          basis: 'finding_claim_refuted',
          authorityRefIds: ['proof-1'],
        },
        proposalDigest: 'proposal-1',
        verificationDigest: 'verification-1',
        claimSettlementIds: ['settlement-1'],
        lifecycleEventIds: [firstHead.eventId],
      }],
    });
    expect(hasSubstantiveVerifiedSettlementWitness(settled, 'C-0001')).toBe(true);
    expect(isConflictResolved(settled, 'C-0001')).toBe(true);
  });
});
