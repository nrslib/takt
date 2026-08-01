import { describe, expect, it } from 'vitest';
import {
  FINDING_CONFLICT_STATUSES,
  FINDING_LIFECYCLES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  type FindingDismissalBasis,
  type FindingManagerAuthority,
} from '../core/models/finding-types.js';
import {
  FindingLifecycleSchema,
  FindingLifecycleReservationSchema,
  FindingLedgerEntrySchema,
  FindingProvisionalMetadataSchema,
  FindingObservationSchema,
  FindingManagerDecisionsJsonSchema,
  FindingConflictAdjudicationOutputJsonSchema,
  FindingManagerOutputJsonSchema,
  FindingSeveritySchema,
  FindingStatusSchema,
  RawFindingSchema,
  RawFindingsOutputJsonSchema,
  RawFindingsOutputValidationJsonSchema,
  ReviewerRawFindingSchema,
  createRawFindingsOutputJsonSchema,
  parseFindingLedger,
  parseFindingConflictAdjudicationOutput,
  parseFindingManagerDecisions,
  parseFindingManagerOutput,
} from '../core/models/finding-schemas.js';
import { compareRfc3339Timestamps } from '../core/models/rfc3339.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import {
  RAW_FINDING_FIELD_LIMITS,
  RAW_FINDING_NORMALIZER_LIMITS,
} from '../core/models/finding-contract-limits.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import {
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../core/models/finding-claim-identity.js';
import { deduplicateRawEvidence } from '../core/workflow/findings/evidence-domain.js';
import { createFindingLifecycleReservation } from '../core/models/finding-lifecycle-identity.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  emptyFindingAuthorityProjection,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';

const TEST_INTEGRITY_DIGEST = 'a'.repeat(64);
import { FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF } from '../core/workflow/findings/adjudication-step.js';
import { RAW_FINDINGS_SCHEMA_REF } from '../core/workflow/findings/manager-agent.js';
import {
  FINDING_MANAGER_CONTROL_SCHEMA_REF,
  FINDING_INTERPRETATION_SCHEMA_REF,
  FINDING_MANAGER_SCHEMA_REF,
} from '../core/workflow/findings/manager-step.js';
import { RAW_ADJUDICATION_SCHEMA_REF } from '../core/workflow/findings/raw-adjudication-step.js';

function pendingLedgerWithCompleted(
  completed: {
    nextId: number;
    findings: unknown[];
    conflicts?: unknown[];
  },
) {
  const roundMarker = 'round-pending-invariant';
  return {
    workflowName: 'peer-review',
    nextId: 1,
    updatedAt: '2026-07-24T00:00:00.000Z',
    findings: [],
    evidenceRecords: [],
    rawFindings: [],
    conflicts: [],
    interpretations: [],
    ...emptyFindingAuthorityProjection(),
    pendingManagerCommit: {
      roundMarker,
      publication: {
        publicationId: 'a'.repeat(64),
        domainId: 'b'.repeat(64),
        originRunId: 'run-source',
        destinationRunId: 'run-source',
        fileName: 'findings-manager-validation.reviewers.json',
        contentSha256: 'c'.repeat(64),
        report: {
          version: 1,
          runId: 'run-source',
          stepName: 'reviewers',
          retryCount: 0,
          ledgerUpdated: true,
          finalErrors: [],
          attempts: [],
        },
      },
      completed: {
        nextId: completed.nextId,
        updatedAt: '2026-07-24T00:01:00.000Z',
        findings: completed.findings,
        evidenceRecords: [],
        rawFindings: [],
        conflicts: completed.conflicts ?? [],
        interpretations: [],
        ...emptyFindingAuthorityProjection(),
        stopBudget: {
          roundMarkers: [roundMarker],
          firstRoundAt: '2026-07-24T00:01:00.000Z',
          exhausted: false,
        },
      },
    },
  };
}

function pendingFinding(id: string) {
  const target = {
    kind: 'code' as const,
    paths: [`fixtures/${id}.ts`],
  };
  return {
    id,
    status: 'open',
    lifecycle: 'new',
    revision: 1,
    severity: 'high',
    title: 'Pending finding',
    target,
    targetIdentityHash: computeTargetIdentityHash(target),
    claimIdentityHash: computeClaimIdentityHash({
      target,
      familyTag: 'fixture',
      severity: 'high',
      title: 'Pending finding',
      description: null,
      suggestion: null,
    }),
    semanticClaimIdentityHash: computeSemanticClaimIdentityHash({
      target,
      title: 'Pending finding',
      description: null,
    }),
    reviewers: ['reviewer'],
    rawFindingIds: ['raw-1'],
    evidenceIds: [],
    firstSeen: {
      runId: 'run-source',
      stepName: 'reviewers',
      timestamp: '2026-07-24T00:00:00.000Z',
    },
    lastSeen: {
      runId: 'run-source',
      stepName: 'reviewers',
      timestamp: '2026-07-24T00:00:00.000Z',
    },
  };
}

describe('finding schemas', () => {
  it('uses only unversioned schema references for the single Finding Contract format', () => {
    expect([
      FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF,
      RAW_FINDINGS_SCHEMA_REF,
      FINDING_INTERPRETATION_SCHEMA_REF,
      FINDING_MANAGER_SCHEMA_REF,
      FINDING_MANAGER_CONTROL_SCHEMA_REF,
      RAW_ADJUDICATION_SCHEMA_REF,
    ]).toEqual([
      'takt.findings.adjudication',
      'takt.findings.raw',
      'takt.findings.interpretation',
      'takt.findings.manager.raw-task',
      'takt.findings.manager.control-task',
      'takt.findings.raw-adjudication',
    ]);
  });

  it('accepts a finding ledger in the single root format', () => {
    const ledger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
    };

    expect(parseFindingLedger(ledger)).toEqual(ledger);
  });

  it('parses a persisted nullable provisional from a pending resume snapshot', () => {
    const provisional = {
      ...pendingFinding('F-0001'),
      target: null,
      targetIdentityHash: null,
      claimIdentityHash: null,
      semanticClaimIdentityHash: null,
      severity: null,
      title: null,
      provisional: {
        kind: 'raw-meaning-ambiguous' as const,
        stableKey: 'stable-resume-nullable',
        lineageKey: 'lineage-resume-nullable',
        sourceRawFindingIds: ['raw-1'],
        reason: 'The persisted observation does not yet contain a complete claim.',
        firstObservedAt: {
          runId: 'run-source',
          stepName: 'reviewers',
          timestamp: '2026-07-24T00:00:00.000Z',
        },
        lastObservedAt: {
          runId: 'run-source',
          stepName: 'reviewers',
          timestamp: '2026-07-24T00:00:00.000Z',
        },
        interpretationEpochs: 0,
        gateEffect: 'block' as const,
        firstObservedRound: 1,
      },
    };
    const resumed = parseFindingLedger(pendingLedgerWithCompleted({
      nextId: 2,
      findings: [provisional],
    }));

    expect(resumed.pendingManagerCommit?.completed.findings[0]).toEqual(provisional);
  });

  it('rejects nullable claim fields on a product finding', () => {
    expect(() => FindingLedgerEntrySchema.parse({
      ...pendingFinding('F-0001'),
      severity: null,
      title: null,
    })).toThrow(/require severity|require title/u);
  });

  it('rejects a non-provisional finding whose semantic claim identity is null', () => {
    expect(() => FindingLedgerEntrySchema.parse({
      ...pendingFinding('F-0001'),
      semanticClaimIdentityHash: null,
    })).toThrow(/all null or all present/u);
  });

  it('requires superseded evidence to be projected onto the canonical finding', () => {
    const evidencePayload = {
      kind: 'file_quote' as const,
      path: 'src/duplicate.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'duplicate evidence',
      snapshotId: '1'.repeat(64),
      claimIdentityHash: '2'.repeat(64),
      fileHash: '3'.repeat(64),
    };
    const evidenceRecord = {
      evidenceId: computeFileQuoteEvidenceRecordId(evidencePayload),
      ...evidencePayload,
    };
    const observedAt = {
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-07-24T00:00:00.000Z',
    };
    const canonicalTarget = {
      kind: 'code' as const,
      paths: ['src/duplicate.ts'],
    };
    const canonical = {
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Canonical',
      description: 'Canonical finding description.',
      target: canonicalTarget,
      targetIdentityHash: computeTargetIdentityHash(canonicalTarget),
      claimIdentityHash: computeClaimIdentityHash({
        target: canonicalTarget,
        familyTag: 'fixture',
        severity: 'high',
        title: 'Canonical',
        description: 'Canonical finding description.',
        suggestion: null,
      }),
      semanticClaimIdentityHash: computeSemanticClaimIdentityHash({
        target: canonicalTarget,
        title: 'Canonical',
        description: 'Canonical finding description.',
      }),
      reviewers: ['reviewer-a'],
      rawFindingIds: [],
      evidenceIds: [],
      firstSeen: observedAt,
      lastSeen: observedAt,
      revision: 1,
    };
    const duplicate = {
      ...canonical,
      id: 'F-0002',
      status: 'superseded',
      lifecycle: 'superseded',
      title: 'Duplicate',
      semanticClaimIdentityHash: computeSemanticClaimIdentityHash({
        target: canonicalTarget,
        title: 'Duplicate',
        description: 'Canonical finding description.',
      }),
      evidenceIds: [evidenceRecord.evidenceId],
      supersededByFindingId: 'F-0001',
    };
    const ledger = {
      workflowName: 'peer-review',
      nextId: 3,
      updatedAt: observedAt.timestamp,
      findings: [canonical, duplicate],
      evidenceRecords: [evidenceRecord],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
    };

    expect(() => parseFindingLedger(ledger)).toThrow(
      /must also be referenced by canonical finding/u,
    );
    expect(parseFindingLedger({
      ...ledger,
      findings: [
        { ...canonical, evidenceIds: [evidenceRecord.evidenceId] },
        duplicate,
      ],
    }).findings).toHaveLength(2);
  });

  it.each([
    ['stopBudget', ['round-a', 'round-a']],
    ['stopBudget', ['round-b', 'round-a']],
    ['reviewIntegrity', ['round-a', 'round-a']],
    ['reviewIntegrity', ['round-b', 'round-a']],
  ] as const)('rejects duplicate or binary-unsorted %s.roundMarkers', (field, roundMarkers) => {
    expect(() => parseFindingLedger({
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
      [field]: {
        roundMarkers,
        firstRoundAt: '2026-07-24T00:00:00.000Z',
        exhausted: false,
      },
    })).toThrow(/binary-sorted unique string set/i);
  });

  it('accepts canonical binary-sorted unique roundMarkers for both budgets', () => {
    const state = {
      roundMarkers: ['round-a', 'round-b'],
      firstRoundAt: '2026-07-24T00:00:00.000Z',
      exhausted: false,
    };
    const ledger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
      stopBudget: state,
      reviewIntegrity: state,
    };

    expect(parseFindingLedger(ledger)).toEqual(ledger);
  });

  it('round-trips a reviewer anomaly settlement bound to a complete verified resolution', () => {
    const observation = {
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-07-31T00:00:00.000Z',
    };
    const resolved = authorizeFindingLedgerFixture({
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: observation.timestamp,
      findings: [{
        ...pendingFinding('F-0001'),
        rawFindingIds: [],
        status: 'resolved',
        lifecycle: 'resolved',
        revision: 2,
        firstSeen: observation,
        lastSeen: observation,
        resolvedAt: observation.timestamp,
        resolvedEvidence: 'Verified resolution.',
      }],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
    });
    const event = resolved.lifecycleEvents.find(
      (candidate) => candidate.operation === 'resolve_finding',
    )!;
    const sourceRawFindingId = resolved.evidenceBindings
      .find((binding) => (
        event.evidenceBindingIds.includes(binding.bindingId)
        && binding.target.entityId === 'F-0001'
      ))!.sourceRawFindingId!;
    const ledger = {
      ...resolved,
      reviewerAnomalies: [{
        id: 'RA-VALID',
        kind: 'quote-mismatch',
        stableKey: 'stable-1',
        lineageKey: 'lineage-1',
        sourceRawFindingIds: [sourceRawFindingId],
        sourceIntakeIds: [],
        reviewers: ['architecture'],
        title: 'Unverified claim',
        mismatchReason: 'Quote mismatch',
        firstObserved: observation,
        lastObserved: observation,
        occurrences: 1,
        settlement: {
          kind: 'target_resolved_by_verified_evidence',
          findingId: 'F-0001',
          lifecycleEventId: event.eventId,
        },
      }],
    };

    expect(parseFindingLedger(ledger)).toEqual(ledger);
    expect(event.eventId).toMatch(/^[0-9a-f]{64}$/u);
    expect(event.evidenceBindingIds[0]).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects reviewer anomaly settlement references outside the verified resolution graph', () => {
    const observation = {
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-07-31T00:00:00.000Z',
    };
    const ledger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: observation.timestamp,
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
      reviewerAnomalies: [{
        id: 'RA-INVALID',
        kind: 'quote-mismatch',
        stableKey: 'stable-invalid',
        lineageKey: 'lineage-invalid',
        sourceRawFindingIds: ['missing-raw'],
        sourceIntakeIds: [],
        reviewers: ['architecture'],
        title: 'Unverified claim',
        mismatchReason: 'Quote mismatch',
        firstObserved: observation,
        lastObserved: observation,
        occurrences: 1,
        settlement: {
          kind: 'target_resolved_by_verified_evidence',
          findingId: 'F-0001',
          lifecycleEventId: 'a'.repeat(64),
        },
      }],
    };

    expect(() => parseFindingLedger(ledger))
      .toThrow(/invalid verified-resolution settlement/u);
  });

  it('rejects unexpected fields on the finding ledger root', () => {
    expect(() => parseFindingLedger({
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      unexpectedField: true,
    })).toThrow();
  });

  it('rejects duplicate finding ids inside pending completed projections', () => {
    const finding = pendingFinding('F-0001');
    expect(() => parseFindingLedger(pendingLedgerWithCompleted({
      nextId: 2,
      findings: [finding, { ...finding }],
    }))).toThrow(/Duplicate finding id/);
  });

  it('rejects a pending completed nextId that cannot allocate after its largest finding id', () => {
    expect(() => parseFindingLedger(pendingLedgerWithCompleted({
      nextId: 1,
      findings: [pendingFinding('F-0001')],
    }))).toThrow('must be greater than existing finding id F-0001');
  });

  it('rejects noncanonical conflict ids inside pending completed projections', () => {
    const identity = {
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-conflict'],
    };
    expect(() => parseFindingLedger(pendingLedgerWithCompleted({
      nextId: 2,
      findings: [pendingFinding('F-0001')],
      conflicts: [{
        id: 'C-NONCANONICAL',
        status: 'active',
        revision: 1,
        ...identity,
        description: 'Pending conflict',
        firstSeen: {
          runId: 'run-source',
          stepName: 'reviewers',
          timestamp: '2026-07-24T00:00:00.000Z',
        },
        lastSeen: {
          runId: 'run-source',
          stepName: 'reviewers',
          timestamp: '2026-07-24T00:00:00.000Z',
        },
      }],
    }))).toThrow('must equal its canonical content-derived id');
  });

  it('enforces the final interpretation WAL record contract without a finding policy version', () => {
    const record = {
      interpretationKey: 'attempt-key',
      baseInterpretationKey: 'base-key',
      attemptOrdinal: 1,
      reviewerStableKey: 'reviewer-key',
      lineageKey: 'lineage-key',
      candidateEvidenceHash: 'evidence-hash',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      stage: 'interpretation_started',
      reservationToken: 'reservation-1',
      startedAt: {
        runId: 'run-1',
        stepName: 'reviewers',
        timestamp: '2026-07-24T00:00:00.000Z',
      },
      promptPreconditions: [],
    };
    const ledger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [record],
      ...emptyFindingAuthorityProjection(),
    };

    expect(parseFindingLedger(ledger).interpretations).toEqual([record]);
    expect(() => parseFindingLedger({
      ...ledger,
      interpretations: [{ ...record, baseInterpretationKey: undefined }],
    })).toThrow();
    expect(() => parseFindingLedger({
      ...ledger,
      interpretations: [{ ...record, attemptOrdinal: undefined }],
    })).toThrow();
    expect(() => parseFindingLedger({
      ...ledger,
      interpretations: [{ ...record, canonicalIntegrityDigest: undefined }],
    })).toThrow();
  });

  it('enforces required and contradictory fields for every interpretation WAL stage', () => {
    const observation = {
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-07-24T00:00:00.000Z',
    };
    const base = {
      interpretationKey: 'attempt-key',
      baseInterpretationKey: 'base-key',
      attemptOrdinal: 1,
      reviewerStableKey: 'reviewer-key',
      lineageKey: 'lineage-key',
      candidateEvidenceHash: 'evidence-hash',
      canonicalIntegrityDigest: TEST_INTEGRITY_DIGEST,
      startedAt: observation,
      promptPreconditions: [],
    };
    const decision = {
      decision: 'provisional',
      rawFindingId: 'raw-1',
      reason: 'Needs another observation.',
    };
    const ledgerFor = (record: Record<string, unknown>) => ({
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [record],
      ...emptyFindingAuthorityProjection(),
    });
    const started = {
      ...base,
      stage: 'interpretation_started',
      reservationToken: 'reservation-1',
    };
    const interrupted = {
      ...base,
      stage: 'interpretation_interrupted',
      reservationToken: 'reservation-1',
      interruptedAt: observation,
    };
    const completed = {
      ...base,
      stage: 'interpretation_completed',
      reservationToken: 'reservation-1',
      completedAt: observation,
      validatedDecision: decision,
    };
    const applied = {
      ...completed,
      stage: 'ledger_applied',
      appliedAt: observation,
      applicationResult: 'provisional_created',
    };

    for (const valid of [started, interrupted, completed, applied]) {
      expect(parseFindingLedger(ledgerFor(valid)).interpretations).toEqual([valid]);
    }

    for (const invalid of [
      { ...started, reservationToken: undefined },
      { ...started, completedAt: observation },
      { ...interrupted, interruptedAt: undefined },
      { ...interrupted, validatedDecision: decision },
      { ...completed, reservationToken: undefined },
      { ...completed, completedAt: undefined },
      { ...completed, validatedDecision: undefined },
      { ...completed, interruptedAt: observation },
      { ...applied, reservationToken: undefined },
      { ...applied, completedAt: undefined },
      { ...applied, validatedDecision: undefined },
      { ...applied, appliedAt: undefined },
      { ...applied, applicationResult: undefined },
      { ...applied, interruptedAt: observation },
    ]) {
      expect(() => parseFindingLedger(ledgerFor(invalid))).toThrow();
    }
  });

  it('requires firstObservedRound on every provisional finding', () => {
    const provisional = {
      kind: 'raw-adjudication-unresolved',
      stableKey: 'stable-key',
      lineageKey: 'lineage-key',
      sourceRawFindingIds: ['raw-1'],
      reason: 'Pending adjudication.',
      firstObservedAt: {
        runId: 'run-1',
        stepName: 'reviewers',
        timestamp: '2026-07-24T00:00:00.000Z',
      },
      lastObservedAt: {
        runId: 'run-1',
        stepName: 'reviewers',
        timestamp: '2026-07-24T00:00:00.000Z',
      },
      interpretationEpochs: 0,
      gateEffect: 'block',
    };

    expect(() => parseFindingLedger({
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Pending finding',
        reviewers: ['reviewer-a'],
        rawFindingIds: ['raw-1'],
        evidenceIds: [],
        firstSeen: provisional.firstObservedAt,
        lastSeen: provisional.lastObservedAt,
        revision: 1,
        provisional,
      }],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
    })).toThrow();
  });

  it('rejects a finding ledger entry without a revision', () => {
    const ledger = {
      workflowName: 'peer-review',
      nextId: 2,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [{
        id: 'F-0001',
        status: 'open',
        lifecycle: 'new',
        severity: 'high',
        title: 'Missing revision must fail',
        reviewers: ['reviewer-a'],
        rawFindingIds: ['raw-1'],
        firstSeen: {
          runId: 'run-1',
          stepName: 'reviewers',
          timestamp: '2026-07-24T00:00:00.000Z',
        },
        lastSeen: {
          runId: 'run-1',
          stepName: 'reviewers',
          timestamp: '2026-07-24T00:00:00.000Z',
        },
      }],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
    };

    expect(() => parseFindingLedger(ledger)).toThrow();
  });

  it('rejects a finding ledger conflict whose id is not its canonical content-derived id', () => {
    const identity = {
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-1'],
    };
    const ledger = {
      workflowName: 'peer-review',
      nextId: 1,
      updatedAt: '2026-07-24T00:00:00.000Z',
      findings: [],
      evidenceRecords: [],
      rawFindings: [],
      conflicts: [{
        id: 'C-NONCANONICAL',
        status: 'active',
        revision: 1,
        ...identity,
        description: 'The evidence conflicts.',
        firstSeen: {
          runId: 'run-1',
          stepName: 'reviewers',
          timestamp: '2026-07-24T00:00:00.000Z',
        },
        lastSeen: {
          runId: 'run-1',
          stepName: 'reviewers',
          timestamp: '2026-07-24T00:00:00.000Z',
        },
      }],
      interpretations: [],
      ...emptyFindingAuthorityProjection(),
    };

    expect(formatConflictId(identity)).not.toBe(ledger.conflicts[0]?.id);
    expect(() => parseFindingLedger(ledger)).toThrow('must equal its canonical content-derived id');
  });

  it('normalizes RFC 3339 observation timestamps to UTC and rejects invalid values', () => {
    expect(FindingObservationSchema.parse({
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-06-13T00:15:00+02:00',
    }).timestamp).toBe('2026-06-12T22:15:00.000Z');

    expect(() => FindingObservationSchema.parse({
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: 'not-a-timestamp',
    })).toThrow('Expected an RFC 3339 timestamp');
  });

  it('should normalize lowercase RFC 3339 separators and actual leap seconds without crossing into the next minute', () => {
    expect(FindingObservationSchema.parse({
      runId: 'run-1',
      stepName: 'reviewers',
      timestamp: '2026-06-13t00:15:00.123z',
    }).timestamp).toBe('2026-06-13T00:15:00.123Z');
    for (const timestamp of [
      '2016-12-31T23:59:60.500Z',
      '2017-01-01T00:59:60.500+01:00',
      '2016-12-31T18:59:60.500-05:00',
    ]) {
      expect(FindingObservationSchema.parse({
        runId: 'run-1',
        stepName: 'reviewers',
        timestamp,
      }).timestamp).toBe('2016-12-31T23:59:60.500Z');
    }
    expect(compareRfc3339Timestamps(
      '2016-12-31T23:59:60.500Z',
      '2017-01-01T00:00:00.000Z',
    )).toBeLessThan(0);
  });

  it('should reject leap seconds outside announced UTC insertion points', () => {
    for (const timestamp of [
      '2026-01-01T12:34:60Z',
      '2016-12-31T23:58:60Z',
      '2016-12-31T23:59:60+01:00',
      '2016-12-31T19:59:60-05:00',
    ]) {
      expect(() => FindingObservationSchema.parse({
        runId: 'run-1',
        stepName: 'reviewers',
        timestamp,
      })).toThrow(/Expected (?:an |a valid )?RFC 3339 timestamp/);
    }
  });

  it('should reject timestamps that cannot be stored at millisecond precision or normalized within four-digit years', () => {
    for (const timestamp of [
      '2026-06-13T00:15:00.0001Z',
      '9999-12-31T23:59:59-23:59',
      '0000-01-01T00:00:00+23:59',
    ]) {
      expect(() => FindingObservationSchema.parse({
        runId: 'run-1',
        stepName: 'reviewers',
        timestamp,
      })).toThrow(/Expected (?:an |a valid )?RFC 3339 timestamp/);
    }
  });

  it('requires the lifecycle reservation identity that authorizes a recovery mutation', () => {
    const reservation = createFindingLifecycleReservation({
      operation: 'record_recovery_attempt',
      targets: [{
        entityKind: 'finding',
        entityId: 'F-0001',
        expectedHead: {
          entityKind: 'finding',
          entityId: 'F-0001',
          revision: 1,
          projectionDigest: '1'.repeat(64),
          eventId: '2'.repeat(64),
        },
      }],
      evidenceBindingIds: [],
      authority: { kind: 'system', action: 'record_recovery_attempt' },
      context: { kind: 'transaction' },
      reservedAt: {
        runId: 'run-1',
        stepName: 'raw-recovery',
        timestamp: '2026-07-17T00:00:00.000Z',
      },
    });

    expect(FindingLifecycleReservationSchema.parse(reservation)).toEqual(reservation);
    const { reservationId: _reservationId, ...withoutIdentity } = reservation;
    expect(() => FindingLifecycleReservationSchema.parse(withoutIdentity)).toThrow();
  });

  it('keeps strict JSON Schema object properties listed in required', () => {
    // provider-facing schema は strict 様式（全 properties が required、optional
    // プロパティ無し）を維持する。OpenAI/Codex 系 native structured output は
    // これを要求し、違反すると生成前に schema 自体が拒否される。
    const rawFindingItem = RawFindingsOutputJsonSchema.properties.rawFindings.items;
    expect(rawFindingItem.required).toEqual(Object.keys(rawFindingItem.properties));
    expect(Object.keys(rawFindingItem.properties)).not.toContain('kind');

    const managerProperties = FindingManagerOutputJsonSchema.properties;
    expect(managerProperties.matches.items.required).toEqual(Object.keys(managerProperties.matches.items.properties));
    expect(managerProperties.newFindings.items.required).toEqual(Object.keys(managerProperties.newFindings.items.properties));
    expect(managerProperties.resolvedFindings.items.required).toEqual(Object.keys(managerProperties.resolvedFindings.items.properties));
    expect(managerProperties.reopenedFindings.items.required).toEqual(Object.keys(managerProperties.reopenedFindings.items.properties));
    expect(managerProperties.conflicts.items.required).toEqual(Object.keys(managerProperties.conflicts.items.properties));
    expect(managerProperties.resolvedConflicts.items.required).toEqual(Object.keys(managerProperties.resolvedConflicts.items.properties));

    expect(FindingConflictAdjudicationOutputJsonSchema.required).toEqual(
      Object.keys(FindingConflictAdjudicationOutputJsonSchema.properties),
    );
  });

  it('requires nullable adjudication fields and normalizes null to undefined', () => {
    expect(FindingConflictAdjudicationOutputJsonSchema.properties.actionableFix.type)
      .toEqual(['string', 'null']);
    expect(FindingConflictAdjudicationOutputJsonSchema.properties.rationale.type)
      .toEqual(['string', 'null']);
    expect(parseFindingConflictAdjudicationOutput({
      conflictId: 'C-0001',
      outcome: 'undetermined',
      actionableFix: null,
      rationale: null,
    })).toEqual({
      conflictId: 'C-0001',
      outcome: 'undetermined',
      actionableFix: undefined,
      rationale: undefined,
    });
    expect(() => parseFindingConflictAdjudicationOutput({
      conflictId: 'C-0001',
      outcome: 'undetermined',
    })).toThrow();
  });

  it('keeps strict JSON Schema object properties listed in required for the manager decisions schema', () => {
    const decisionsProperties = FindingManagerDecisionsJsonSchema.properties;
    expect(FindingManagerDecisionsJsonSchema.required).toEqual(Object.keys(decisionsProperties));
    for (const alternative of decisionsProperties.rawDecisions.items.anyOf) {
      expect(alternative.required).toEqual(Object.keys(alternative.properties));
    }
    expect(decisionsProperties.rawDecisions.items.anyOf.map(
      (alternative) => Object.hasOwn(alternative.properties, 'anchorRelevance'),
    )).toEqual([false, true]);
    expect(decisionsProperties.disputeDecisions.items.required).toEqual(Object.keys(decisionsProperties.disputeDecisions.items.properties));
    expect(decisionsProperties.conflictDecisions.items.required).toEqual(Object.keys(decisionsProperties.conflictDecisions.items.properties));
    expect(decisionsProperties.invalidateDecisions.items.required).toEqual(Object.keys(decisionsProperties.invalidateDecisions.items.properties));
    expect(decisionsProperties.duplicateDecisions.items.required).toEqual(Object.keys(decisionsProperties.duplicateDecisions.items.properties));
  });

  it('omits an empty manager decision findingId from the parsed audit value', () => {
    const decisions = parseFindingManagerDecisions({
      rawDecisions: [{
        rawFindingId: 'raw-1',
        decision: 'new',
        findingId: '',
        evidence: 'No related open finding.',
      }],
      disputeDecisions: [],
      conflictDecisions: [],
      invalidateDecisions: [],
      duplicateDecisions: [],
      dismissDecisions: [],
    });

    expect(decisions.rawDecisions[0]).not.toHaveProperty('findingId');
    expect(decisions.rawDecisions[0]).not.toHaveProperty('anchorRelevance');
    expect(() => parseFindingManagerDecisions({
      rawDecisions: [{
        rawFindingId: 'raw-1',
        decision: 'new',
        anchorRelevance: 'not_applicable',
        findingId: '',
        evidence: 'Legacy external sentinel.',
      }],
      disputeDecisions: [],
      conflictDecisions: [],
      invalidateDecisions: [],
      duplicateDecisions: [],
      dismissDecisions: [],
    })).toThrow();
  });

  it('post-hoc 検証用 schema は item 欠損を per-item ambiguity へ渡す', () => {
    const strictItem = RawFindingsOutputJsonSchema.properties.rawFindings.items;
    const lenientItem = RawFindingsOutputValidationJsonSchema.properties.rawFindings.items;
    expect(lenientItem.required).toEqual([]);
    expect(Object.keys(lenientItem.properties).sort()).toEqual(
      Object.keys(strictItem.properties).sort(),
    );
  });

  it('keeps engine-issued snapshot, proof, and run identities out of the provider schema', () => {
    const serialized = JSON.stringify(createRawFindingsOutputJsonSchema());
    expect(serialized).toContain('"rawExcerpt"');
    expect(serialized).toContain('"evidenceRequests"');
    expect(serialized).not.toContain('"snapshotId"');
    expect(serialized).not.toContain('"proofId"');
    expect(serialized).not.toContain('"runId"');
  });

  it('describes reviewer evidence requests without engine-issued verification results', () => {
    const candidate = RawFindingsOutputJsonSchema.properties.rawFindings.items
      .properties.candidate.anyOf[1];
    const properties = candidate.properties;
    const providerEvidence = properties.evidenceRequests.items as unknown as {
      anyOf: Array<{
        required: string[];
        properties: Record<string, { enum?: string[] }>;
      }>;
    };
    const fileQuote = providerEvidence.anyOf.find(
      (branch) => branch.properties.kind?.enum?.includes('file_quote') === true,
    );

    expect(properties.relation.enum).toContain('resolution_confirmation');
    expect(properties.evidenceRequests.maxItems).toBe(16);
    expect(fileQuote?.required).toEqual([
      'kind',
      'path',
      'startLine',
      'endLine',
    ]);
    expect(fileQuote).toMatchObject({
      properties: {
        kind: { enum: ['file_quote'] },
      },
    });
    const engineProof = providerEvidence.anyOf.find(
      (branch) => branch.properties.kind?.enum?.includes('engine_proof') === true,
    );
    expect(engineProof).toMatchObject({
      properties: {
        kind: { enum: ['engine_proof'] },
      },
    });
    expect(fileQuote?.properties).not.toHaveProperty('snapshotId');
    expect(fileQuote?.properties).not.toHaveProperty('verbatimExcerpt');
    expect(engineProof?.properties).not.toHaveProperty('proofId');
  });

  it('uses only the native structured output keyword subset recursively', () => {
    const allowedKeywords = new Set([
      '$defs',
      '$ref',
      'type',
      'description',
      'properties',
      'required',
      'additionalProperties',
      'enum',
      'anyOf',
      'items',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
    ]);
    const visit = (value: unknown, insideProperties = false): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, nested] of Object.entries(value)) {
        if (!insideProperties) expect(allowedKeywords.has(key)).toBe(true);
        visit(nested, key === 'properties' || key === '$defs');
      }
    };

    visit(createRawFindingsOutputJsonSchema());
  });

  it('rejects engine-issued identity fields in reviewer evidence requests', () => {
    const base = reviewerRawExtractionFixture({
      rawFindingId: 'raw-1',
      relation: 'new',
      targetFindingId: null,
      familyTag: 'bug',
      severity: 'low',
      title: 'title',
      description: 'description',
      suggestion: null,
      target: { kind: 'code', paths: ['src/a.ts'] },
      evidenceRequests: [{
        kind: 'file_quote',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 1,
      }],
    });
    expect(() => ReviewerRawFindingSchema.parse({
      ...base,
      candidate: {
        ...base.candidate,
        evidenceRequests: [{
          kind: 'engine_proof',
          subject: { kind: 'repository_query' },
          proofId: 'a'.repeat(64),
        }],
      },
    })).toThrow();
    expect(() => ReviewerRawFindingSchema.parse({
      ...base,
      candidate: {
        ...base.candidate,
        evidenceRequests: [{
          kind: 'file_quote',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          snapshotId: 'a'.repeat(64),
        }],
      },
    })).toThrow();
    expect(() => ReviewerRawFindingSchema.parse({
      ...base,
      candidate: {
        ...base.candidate,
        evidenceRequests: [{
          kind: 'file_quote',
          path: 'src/a.ts',
          startLine: 1,
          endLine: 1,
          verbatimExcerpt: 'reviewer-supplied source',
        }],
      },
    })).toThrow();
    expect(RAW_FINDING_FIELD_LIMITS.maxSnapshotIdChars).toBe(64);
    expect(RAW_FINDING_FIELD_LIMITS.maxProofIdChars).toBe(64);
  });

  it('keeps the provider raw id limit separate from valid engine-namespaced ids', () => {
    const evidence = [{
      kind: 'engine_proof' as const,
      proofId: 'a'.repeat(64),
    }];
    const fields = {
      relation: 'new' as const,
      targetFindingId: null,
      familyTag: 'bug',
      severity: 'low' as const,
      title: 'Namespaced id',
      description: 'Engine namespaces may exceed the provider local id limit.',
      suggestion: null,
      evidence,
    };
    const namespacedId = 'namespace:'.repeat(20);
    const reviewer = reviewerRawExtractionFixture({
      ...fields,
      rawFindingId: namespacedId,
      target: { kind: 'code', paths: ['src/namespaced.ts'] },
      evidenceRequests: [],
    });

    expect(() => ReviewerRawFindingSchema.parse(reviewer)).toThrow();
    expect(RawFindingSchema.parse(canonicalRawFindingFixture({
      ...fields,
      rawFindingId: namespacedId,
      stepName: 'reviewers',
      reviewer: 'reviewer-a',
    })).rawFindingId).toBe(namespacedId);
  });

  it('accepts persisted multi-evidence normalized by the canonical evidence ordering helper', () => {
    const snapshotId = 'a'.repeat(64);
    const byEarlierCanonicalField = {
      kind: 'file_quote' as const,
      path: 'src/z.ts',
      startLine: 1,
      endLine: 1,
      verbatimExcerpt: 'z',
      snapshotId,
    };
    const byLaterCanonicalField = {
      kind: 'file_quote' as const,
      path: 'src/a.ts',
      startLine: 2,
      endLine: 2,
      verbatimExcerpt: 'a',
      snapshotId,
    };
    const evidence = deduplicateRawEvidence([
      byLaterCanonicalField,
      byEarlierCanonicalField,
    ]);

    expect(evidence).toEqual([
      byEarlierCanonicalField,
      byLaterCanonicalField,
    ]);
    expect(RawFindingSchema.parse(canonicalRawFindingFixture({
      rawFindingId: 'raw-multi-evidence',
      stepName: 'review',
      reviewer: 'reviewer',
      relation: 'new',
      targetFindingId: null,
      familyTag: 'bug',
      severity: 'low',
      title: 'Multi evidence ordering',
      description: 'Canonical JSON ordering differs from insertion-order JSON.',
      suggestion: null,
      evidence,
    })).evidence).toEqual(evidence);
  });

  it('uses finding type constants for schema enum values', () => {
    expect(FindingSeveritySchema.options).toEqual(FINDING_SEVERITIES);
    expect(FindingStatusSchema.options).toEqual(FINDING_STATUSES);
    expect(FindingLifecycleSchema.options).toEqual(FINDING_LIFECYCLES);
    expect(FindingManagerOutputJsonSchema.properties.newFindings.items.properties.severity.enum).toBe(FINDING_SEVERITIES);
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.properties
      .candidate.anyOf[1].properties.severity.enum)
      .toEqual([...FINDING_SEVERITIES, null]);

    const conflictStatus = {
      id: 'C-0001',
      status: FINDING_CONFLICT_STATUSES[0],
      findingIds: ['F-0001'],
      rawFindingIds: ['raw-1'],
      description: 'Conflict',
      firstSeen: { runId: 'run-1', stepName: 'review', timestamp: '2026-06-14T00:00:00.000Z' },
      lastSeen: { runId: 'run-1', stepName: 'review', timestamp: '2026-06-14T00:00:00.000Z' },
    };
    expect(conflictStatus.status).toBe('active');
  });

  it('requires structured fields in reviewer raw findings output', () => {
    const evidence = [{
      kind: 'file_quote',
      path: 'src/core/workflow/findings/manager-runner.ts',
      startLine: 72,
      endLine: 72,
      verbatimExcerpt: 'const finding = true;',
      snapshotId: 'a'.repeat(64),
    }] as const;
    const reviewerRawFinding = reviewerRawExtractionFixture({
      rawFindingId: 'raw-1',
      familyTag: 'missing-edge-case',
      severity: 'high',
      title: 'Structured output omits the family tag',
      description: 'The findings manager cannot reconcile findings without familyTag.',
      suggestion: 'Keep reviewer raw finding fields complete for reconciliation.',
      relation: 'new',
      targetFindingId: null,
      evidence,
    });
    const {
      evidenceRequests: _evidenceRequests,
      targetFindingIds,
      ...persistedCandidate
    } = reviewerRawFinding.candidate!;
    const persistedRawFinding = canonicalRawFindingFixture({
      ...persistedCandidate,
      targetFindingId: targetFindingIds[0] ?? null,
      stepName: 'ai-antipattern-review',
      reviewer: 'ai-antipattern-reviewer',
      evidence,
    });

    expect(ReviewerRawFindingSchema.parse(reviewerRawFinding).candidate?.familyTag)
      .toBe('missing-edge-case');
    expect(RawFindingSchema.parse(persistedRawFinding).familyTag).toBe('missing-edge-case');
    expect(() => ReviewerRawFindingSchema.parse({
      ...reviewerRawFinding,
      candidate: {
        ...reviewerRawFinding.candidate,
        familyTag: undefined,
      },
    })).toThrow();
    const candidateSchema = RawFindingsOutputJsonSchema.properties.rawFindings.items
      .properties.candidate.anyOf[1];
    expect(candidateSchema.required).toContain('familyTag');
    expect(candidateSchema.required).toContain('evidenceRequests');
    expect(candidateSchema.required).toContain('suggestion');
    expect(candidateSchema.properties.targetFindingIds.maxItems)
      .toBe(RAW_FINDING_NORMALIZER_LIMITS.maxTargetFindingIdsPerCandidate);
    expect(candidateSchema.properties.targetFindingIds.items.maxLength)
      .toBe(RAW_FINDING_FIELD_LIMITS.maxRawFindingIdChars);
    expect(candidateSchema.properties.familyTag).toEqual({
      type: ['string', 'null'],
      maxLength: RAW_FINDING_FIELD_LIMITS.maxFamilyTagChars,
    });
  });

  it('keeps target mutation authority engine-issued and persisted only', () => {
    const reviewerTarget = reviewerRawExtractionFixture({
      rawFindingId: 'raw-target',
      familyTag: 'state',
      severity: 'high',
      title: 'State remains invalid',
      description: 'The invalid state remains.',
      suggestion: 'Repair the transition.',
      relation: 'persists',
      targetFindingId: 'F-0001',
      target: { kind: 'code', paths: ['src/state.ts'] },
      evidence: [{
        kind: 'file_quote',
        path: 'src/state.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'const state = invalid;',
        snapshotId: 'b'.repeat(64),
      }],
    });
    const targetPrecondition = {
      targetFindingId: 'F-0001',
      targetRevision: 4,
      targetStatus: 'open',
      targetEvidenceHash: 'a'.repeat(64),
    };
    const {
      evidenceRequests: _evidenceRequests,
      targetFindingIds,
      ...persistedTargetCandidate
    } = reviewerTarget.candidate!;
    const persistedTarget = {
      ...persistedTargetCandidate,
      targetFindingId: targetFindingIds[0] ?? null,
      evidence: [{
        kind: 'file_quote' as const,
        path: 'src/state.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'const state = invalid;',
        snapshotId: 'b'.repeat(64),
      }],
      stepName: 'review',
      reviewer: 'reviewer',
    };

    expect(ReviewerRawFindingSchema.parse(reviewerTarget)).not.toHaveProperty('targetPrecondition');
    expect(() => ReviewerRawFindingSchema.parse({
      ...reviewerTarget,
      targetPrecondition,
    })).toThrow();
    expect(() => RawFindingSchema.parse({
      ...canonicalRawFindingFixture(persistedTarget),
    })).toThrow();
    expect(RawFindingSchema.parse(canonicalRawFindingFixture({
      ...persistedTarget,
      targetPrecondition,
    })).targetPrecondition).toEqual(targetPrecondition);
  });

  // 決定スキーマ（FindingManagerDuplicateDecisionSchema）と対称に、出力側の
  // duplicateFindings も duplicate を1件も持たないエントリを拒否する。
  it('rejects a duplicateFindings entry with an empty duplicateFindingIds array', () => {
    const base = {
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
      dismissedFindings: [],
    };

    expect(() => parseFindingManagerOutput({
      ...base,
      duplicateFindings: [{ canonicalFindingId: 'F-0001', duplicateFindingIds: [], evidence: 'dup' }],
    })).toThrow();
    expect(parseFindingManagerOutput({
      ...base,
      duplicateFindings: [{ canonicalFindingId: 'F-0001', duplicateFindingIds: ['F-0002'], evidence: 'dup' }],
    }).duplicateFindings).toHaveLength(1);
    // LLM 向け JSON schema も同じ制約を明示する。
    expect(FindingManagerOutputJsonSchema.properties.duplicateFindings.items.properties.duplicateFindingIds.minItems).toBe(1);
    expect(FindingManagerDecisionsJsonSchema.properties.duplicateDecisions.items.properties.duplicateFindingIds.minItems).toBe(1);
  });

  it('requires every FindingManagerOutput array explicitly', () => {
    const output = {
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

    expect(parseFindingManagerOutput(output)).toEqual(output);
    expect(() => parseFindingManagerOutput({
      ...output,
      dismissedFindings: undefined,
    })).toThrow();
    expect(() => parseFindingManagerOutput({
      ...output,
      conflicts: [{
        rawFindingIds: ['raw-1'],
        description: 'Conflicting evidence.',
      }],
    })).toThrow();
  });

  it('enforces dismissal basis and authority in every persisted schema', () => {
    type DismissalPair = {
      basis: FindingDismissalBasis;
      authority: FindingManagerAuthority;
    };
    const observation = {
      runId: 'run-source',
      stepName: 'reviewers',
      timestamp: '2026-07-24T00:00:00.000Z',
    };
    const provisional = {
      kind: 'raw-meaning-ambiguous' as const,
      stableKey: 'stable-dismissal-authority',
      lineageKey: 'lineage-dismissal-authority',
      sourceRawFindingIds: ['raw-1'],
      reason: 'The observation requires terminal adjudication.',
      firstObservedAt: observation,
      lastObservedAt: observation,
      interpretationEpochs: 2,
      gateEffect: 'block' as const,
      firstObservedRound: 1,
    };
    const targetPrecondition = {
      targetFindingId: 'F-0001',
      targetRevision: 1,
      targetStatus: 'open' as const,
      targetEvidenceHash: 'a'.repeat(64),
    };
    const managerOutputBase = {
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
    const parsers: Array<(dismissal: DismissalPair) => unknown> = [
      (dismissal) => FindingProvisionalMetadataSchema.parse({
        ...provisional,
        actionRecovery: {
          action: 'dismiss',
          findingId: 'F-0001',
          ...dismissal,
          reason: 'Adjudicated claim.',
          evidence: 'Current-code evidence.',
          targetPreconditions: [targetPrecondition],
        },
      }),
      (dismissal) => FindingLedgerEntrySchema.parse({
        ...pendingFinding('F-0001'),
        status: 'dismissed',
        lifecycle: 'dismissed',
        provisional,
        dismissal: {
          ...dismissal,
          reason: 'Adjudicated claim.',
          evidence: 'Current-code evidence.',
          decidedAt: observation,
        },
      }),
      (dismissal) => parseFindingManagerOutput({
        ...managerOutputBase,
        dismissedFindings: [{
          findingId: 'F-0001',
          ...dismissal,
          reason: 'Adjudicated claim.',
          evidence: 'Current-code evidence.',
        }],
      }),
    ];

    for (const parse of parsers) {
      for (const basis of ['outside_contract_jurisdiction', 'unverifiable_claim'] as const) {
        expect(() => parse({ basis, authority: 'standard' })).not.toThrow();
        expect(() => parse({ basis, authority: 'terminal_adjudication' })).not.toThrow();
      }
      for (const basis of [
        'false_positive',
        'overreach',
        'no_issue_after_verification',
      ] as const) {
        expect(() => parse({ basis, authority: 'terminal_adjudication' })).not.toThrow();
        expect(() => parse({ basis, authority: 'standard' }))
          .toThrow(/requires terminal_adjudication authority/u);
      }
    }
  });
});
