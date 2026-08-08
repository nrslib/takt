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
  ConflictAdjudicationProviderOutputJsonSchema,
  TerminalAdjudicationProviderOutputJsonSchema,
  FindingManagerOutputJsonSchema,
  InterpretationAttemptSchema,
  InterpretationBatchReceiptSchema,
  InterpretationCaseSnapshotSchema,
  InterpretationRawObservationSchema,
  ProviderRawFindingIdSchema,
  RawFindingIdSchema,
  FindingSeveritySchema,
  FindingStatusSchema,
  RawFindingSchema,
  RawFindingsOutputJsonSchema,
  RawFindingsOutputValidationJsonSchema,
  ReviewerRawFindingSchema,
  createRawFindingsOutputJsonSchema,
  parseFindingLedger,
  parseConflictAdjudicationProviderOutput,
  parseConflictAdjudicationProposal,
  parseTerminalAdjudicationProviderOutput,
  parseFindingManagerDecisions,
  parseFindingManagerOutput,
  parseRawFindings,
  parseReviewerRawFindings,
} from '../core/models/finding-schemas.js';
import { compareRfc3339Timestamps } from '../core/models/rfc3339.js';
import { compareBinaryStrings } from '../shared/utils/binary-string-comparator.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import {
  RAW_FINDING_FIELD_LIMITS,
  RAW_FINDING_NORMALIZER_LIMITS,
} from '../core/models/finding-contract-limits.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import {
  computeFindingManagerBudgetScopeId,
  computeFindingManagerRoundIdentity,
} from '../core/models/finding-contract-identity.js';
import {
  computeClaimIdentityHash,
  computeSemanticClaimIdentityHash,
  computeTargetIdentityHash,
} from '../core/models/finding-claim-identity.js';
import { deduplicateRawEvidence } from '../core/workflow/findings/evidence-domain.js';
import { createFindingLifecycleReservation } from '../core/models/finding-lifecycle-identity.js';
import {
  computeInterpretationAttemptId,
  computeInterpretationBatchId,
  computeInterpretationCohortId,
} from '../core/models/finding-interpretation-identity.js';
import {
  authorizeFindingLedgerFixture,
  canonicalRawFindingFixture,
  emptyFindingAuthorityProjection,
  reviewerRawExtractionFixture,
} from './helpers/finding-lifecycle-fixture.js';

interface ProviderProposalAlternativeSchema {
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

function providerProposalAlternatives(
  schema: {
    readonly properties: {
      readonly proposal: {
        readonly anyOf: readonly ProviderProposalAlternativeSchema[];
      };
    };
  },
): readonly ProviderProposalAlternativeSchema[] {
  return schema.properties.proposal.anyOf;
}

import { FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF } from '../core/workflow/findings/adjudication-step.js';
import { RAW_FINDINGS_SCHEMA_REF } from '../core/workflow/findings/manager-agent.js';
import {
  FINDING_MANAGER_CONTROL_SCHEMA_REF,
  FINDING_INTERPRETATION_SCHEMA_REF,
  FINDING_MANAGER_SCHEMA_REF,
} from '../core/workflow/findings/manager-step.js';

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
      description: 'Pending finding description.',
      suggestion: null,
    }),
    semanticClaimIdentityHash: computeSemanticClaimIdentityHash({
      target,
      title: 'Pending finding',
      description: 'Pending finding description.',
    }),
    description: 'Pending finding description.',
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
  it('separates provider-local and wire raw finding ID constraints', () => {
    const maximumProviderId = 'p'.repeat(
      RAW_FINDING_FIELD_LIMITS.maxProviderRawFindingIdChars,
    );
    const maximumWireId = 'w'.repeat(
      RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
    );

    expect(ProviderRawFindingIdSchema.parse(maximumProviderId)).toBe(maximumProviderId);
    expect(() => ProviderRawFindingIdSchema.parse(`${maximumProviderId}x`)).toThrow();
    expect(RawFindingIdSchema.parse(maximumWireId)).toBe(maximumWireId);
    expect(() => RawFindingIdSchema.parse(`${maximumWireId}x`)).toThrow();

    const rawCandidateSchema = RawFindingsOutputJsonSchema.properties.rawFindings.items
      .properties.candidate.anyOf[1];
    expect(rawCandidateSchema.properties.rawFindingId.maxLength)
      .toBe(RAW_FINDING_FIELD_LIMITS.maxProviderRawFindingIdChars);
    expect(FindingManagerDecisionsJsonSchema.properties.rawDecisions.items.anyOf[0]
      .properties.rawFindingId.maxLength)
      .toBe(RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars);
  });

  it('uses only unversioned schema references for the single Finding Contract format', () => {
    expect([
      FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF,
      RAW_FINDINGS_SCHEMA_REF,
      FINDING_INTERPRETATION_SCHEMA_REF,
      FINDING_MANAGER_SCHEMA_REF,
      FINDING_MANAGER_CONTROL_SCHEMA_REF,
    ]).toEqual([
      'takt.findings.adjudication',
      'takt.findings.raw',
      'takt.findings.interpretation-case',
      'takt.findings.manager.raw-task',
      'takt.findings.manager.control-task',
    ]);
  });

  it('caps local clarification IDs and wire manager audit IDs in persisted reports', () => {
    const base = pendingLedgerWithCompleted({ nextId: 1, findings: [] });
    const withReport = (reportFields: Record<string, unknown>) => ({
      ...base,
      pendingManagerCommit: {
        ...base.pendingManagerCommit,
        publication: {
          ...base.pendingManagerCommit.publication,
          report: {
            ...base.pendingManagerCommit.publication.report,
            ...reportFields,
          },
        },
      },
    });
    const maximumProviderId = 'p'.repeat(
      RAW_FINDING_FIELD_LIMITS.maxProviderRawFindingIdChars,
    );
    const maximumWireId = 'w'.repeat(
      RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
    );

    expect(() => parseFindingLedger(withReport({
      relationClarifications: [{
        reviewer: 'reviewer',
        flaggedRawFindingIds: [maximumProviderId],
      }],
      managerTaskAudits: [{
        taskId: 'd'.repeat(64),
        taskKind: 'raw',
        ownedIds: [maximumWireId],
        status: 'failed',
        inputBytes: null,
        reason: 'Provider failure.',
      }],
    }))).not.toThrow();
    expect(() => parseFindingLedger(withReport({
      relationClarifications: [{
        reviewer: 'reviewer',
        flaggedRawFindingIds: [`${maximumProviderId}x`],
      }],
    }))).toThrow();
    expect(() => parseFindingLedger(withReport({
      managerTaskAudits: [{
        taskId: 'd'.repeat(64),
        taskKind: 'raw',
        ownedIds: [`${maximumWireId}x`],
        status: 'failed',
        inputBytes: null,
        reason: 'Provider failure.',
      }],
    }))).toThrow();
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

    for (const alternative of providerProposalAlternatives(
      ConflictAdjudicationProviderOutputJsonSchema,
    )) {
      expect(alternative.additionalProperties).toBe(false);
      expect(alternative.required).toEqual(Object.keys(alternative.properties));
    }
  });

  it('requires nullable adjudication fields and normalizes null to undefined', () => {
    const mergeSchema = providerProposalAlternatives(
      ConflictAdjudicationProviderOutputJsonSchema,
    )[0]!;
    expect(mergeSchema.properties.actionableFix.type)
      .toEqual(['string', 'null']);
    expect(mergeSchema.properties.rationale.type)
      .toEqual(['string', 'null']);
    expect(parseConflictAdjudicationProposal({
      kind: 'undetermined',
      subjectIds: ['subject-1'],
      rationale: null,
    })).toEqual({
      kind: 'undetermined',
      subjectIds: ['subject-1'],
      rationale: undefined,
    });
    expect(parseConflictAdjudicationProposal({
      kind: 'undetermined',
      subjectIds: ['subject-1'],
    })).toEqual({
      kind: 'undetermined',
      subjectIds: ['subject-1'],
    });
  });

  it('uses a Codex-compatible nested anyOf for provider adjudication unions', () => {
    for (const schema of [
      ConflictAdjudicationProviderOutputJsonSchema,
      TerminalAdjudicationProviderOutputJsonSchema,
    ]) {
      expect(schema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['proposal'],
      });
      expect(schema).not.toHaveProperty('anyOf');
      expect(JSON.stringify(schema)).not.toContain('"oneOf"');
      expect(providerProposalAlternatives(schema)).toHaveLength(4);
    }
    expect(parseTerminalAdjudicationProviderOutput({
      proposal: { kind: 'undetermined', rationale: null },
    })).toEqual({ kind: 'undetermined', rationale: undefined });
  });

  it('parses every conflict adjudication proposal variant', () => {
    const proposedProduct = {
      target: { kind: 'review_scope' as const },
      targetIdentityHash: '1'.repeat(64),
      familyTag: 'correctness',
      severity: 'high' as const,
      title: 'Verified issue',
      description: 'The issue remains actionable.',
      suggestion: null,
      claimIdentityHash: '2'.repeat(64),
      semanticClaimIdentityHash: '3'.repeat(64),
      evidenceRecordIds: [],
    };
    const proposals = [
      {
        kind: 'merge_holding' as const,
        holdingSubjectId: 'holding-1',
        targetProductSubjectId: 'product-1',
        authorityRefIds: ['authority-1'],
        actionableFix: 'Apply the verified fix.',
        rationale: 'Both subjects describe the same issue.',
      },
      {
        kind: 'promote_holding' as const,
        holdingSubjectId: 'holding-1',
        proposedProduct,
        authorityRefIds: ['authority-1'],
        actionableFix: 'Apply the verified fix.',
        rationale: 'The held claim is independently verified.',
      },
      {
        kind: 'terminate_subject' as const,
        subjectId: 'holding-1',
        basis: 'finding_claim_refuted' as const,
        authorityRefIds: ['authority-1'],
        rationale: 'The claim-specific proof refutes the subject.',
      },
      {
        kind: 'undetermined' as const,
        subjectIds: ['holding-1'],
        rationale: 'No exact authority resolves the conflict.',
      },
    ];

    expect(proposals.map((proposal) => parseConflictAdjudicationProposal(proposal)))
      .toEqual(proposals);
    expect(parseConflictAdjudicationProviderOutput({ proposal: proposals[0] }))
      .toEqual(proposals[0]);
  });

  it('rejects malformed conflict adjudication proposals and provider envelopes', () => {
    expect(() => parseConflictAdjudicationProposal({
      kind: 'merge_holding',
      holdingSubjectId: 'holding-1',
      authorityRefIds: ['authority-1'],
      actionableFix: null,
      rationale: null,
    })).toThrow();
    expect(() => parseConflictAdjudicationProposal({
      kind: 'undetermined',
      subjectIds: ['holding-1'],
      rationale: null,
      subjectId: 'unexpected',
    })).toThrow();
    expect(() => parseConflictAdjudicationProposal({
      kind: 'terminate_subject',
      subjectId: 'holding-1',
      basis: 'finding_claim_refuted',
      authorityRefIds: [],
      rationale: null,
    })).toThrow();
    expect(() => parseConflictAdjudicationProviderOutput({
      proposal: {
        kind: 'undetermined',
        subjectIds: ['holding-1'],
        rationale: null,
      },
      extra: true,
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

  it('accepts a provider-local maximum and a longer engine-namespaced wire ID', () => {
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
    const providerId = 'p'.repeat(
      RAW_FINDING_FIELD_LIMITS.maxProviderRawFindingIdChars,
    );
    const namespacedId = `engine-namespace:${providerId}`;
    const reviewer = reviewerRawExtractionFixture({
      ...fields,
      rawFindingId: providerId,
      target: { kind: 'code', paths: ['src/namespaced.ts'] },
      evidenceRequests: [],
    });

    expect(ReviewerRawFindingSchema.parse(reviewer).candidate?.rawFindingId)
      .toBe(providerId);
    expect(() => ReviewerRawFindingSchema.parse({
      ...reviewer,
      candidate: { ...reviewer.candidate, rawFindingId: `${providerId}x` },
    })).toThrow();
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
    expect(candidateSchema.required).toContain('reassertsReviewerAnomalyId');
    expect(candidateSchema.required).toContain('evidenceRequests');
    expect(candidateSchema.required).toContain('suggestion');
    expect(candidateSchema.properties.targetFindingIds.maxItems)
      .toBe(RAW_FINDING_NORMALIZER_LIMITS.maxTargetFindingIdsPerCandidate);
    expect(candidateSchema.properties.targetFindingIds.items.maxLength)
      .toBe(RAW_FINDING_FIELD_LIMITS.maxFindingIdChars);
    // familyTag は正規化係が付ける分類。空文字は projection が candidate ごと
    // 不正にするので wire 側でも禁止する。kebab-case は description の規約に留め、
    // pattern では縛らない（表記ゆれで publication 全体を落とさないため）。
    expect(candidateSchema.properties.familyTag).toMatchObject({
      type: ['string', 'null'],
      minLength: 1,
      maxLength: RAW_FINDING_FIELD_LIMITS.maxFamilyTagChars,
    });
    expect(candidateSchema.properties.familyTag).not.toHaveProperty('pattern');
    expect(() => ReviewerRawFindingSchema.parse({
      ...reviewerRawFinding,
      candidate: {
        ...reviewerRawFinding.candidate,
        familyTag: '',
      },
    })).toThrow();
    expect(candidateSchema.properties.reassertsReviewerAnomalyId.type).toEqual(['string', 'null']);
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
      gateEffect: 'block' as const,
      firstObservedRound: 1,
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
    expect(() => FindingProvisionalMetadataSchema.parse({
      ...provisional,
      sourceRawFindingIds: ['raw-b', 'raw-a'],
    })).toThrow(/binary sorted|sorted/u);
    expect(() => FindingProvisionalMetadataSchema.parse({
      ...provisional,
      actionRecovery: {
        action: 'dismiss',
        findingId: 'F-0001',
        basis: 'outside_contract_jurisdiction',
        authority: 'terminal_adjudication',
        reason: 'Adjudicated claim.',
        evidence: 'Current-code evidence.',
        targetPreconditions: [],
      },
    })).toThrow();

    const parsers: Array<(dismissal: DismissalPair) => unknown> = [
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
      for (const basis of [
        'outside_contract_jurisdiction',
        'false_positive',
        'overreach',
        'no_issue_after_verification',
      ] as const) {
        expect(() => parse({ basis, authority: 'terminal_adjudication' })).not.toThrow();
        expect(() => parse({ basis, authority: 'standard' }))
          .toThrow(/requires terminal_adjudication authority/u);
      }
      expect(() => parse({
        basis: 'unverifiable_claim' as FindingDismissalBasis,
        authority: 'terminal_adjudication',
      })).toThrow();
    }
  });
});

describe('interpretation case schemas', () => {
  const caseId = '1'.repeat(64);
  const semanticProjectionDigest = '2'.repeat(64);
  const lineageKey = '4'.repeat(64);
  const caseSnapshotId = '5'.repeat(64);
  const providerCallId = '6'.repeat(64);
  const cohortId = computeInterpretationCohortId(
    caseId,
    semanticProjectionDigest,
    ['raw-schema'],
  );
  const observation = {
    runId: 'run-schema',
    stepName: 'reviewers',
    timestamp: '2026-08-02T00:00:00.000Z',
  };
  const attemptId = computeInterpretationAttemptId(caseSnapshotId, 1, 0);
  const attemptBase = {
    attemptId,
    caseSnapshotId,
    caseId,
    cohortId,
    lineageKey,
    semanticProjectionDigest,
    attemptOrdinal: 1,
    retryOrdinal: 0,
    rawFindingIds: ['raw-schema'],
    providerCallId,
  };

  it('accepts a workflow-stack wire id in observations and case members', () => {
    const rawFindingId = [
      '20260802-203347',
      JSON.stringify({
        stack: Array.from({ length: 2 }, (_, index) => ({
          workflow: `parent-workflow-${index}-with-a-descriptive-name`,
          workflowRef: `workflows/parent-workflow-${index}.yaml`,
          step: `invoke-child-workflow-${index}-for-review`,
          kind: 'workflow_call',
          occurrence: index + 1,
        })),
        childWorkflow: 'workflows/review-child.yaml',
      }),
      'reviewers',
      '1',
      'reviewer',
      `item-${'a'.repeat(64)}`,
    ].join(':');
    const observationDigest = '7'.repeat(64);
    const rawCanonicalSnapshotId = '8'.repeat(64);
    const parsedObservation = InterpretationRawObservationSchema.parse({
      observationDigest,
      rawFindingId,
      rawCanonicalSnapshotId,
      caseId,
      cohortId,
      caseSnapshotId,
      lineageKey,
      semanticProjectionDigest,
      originSnapshotDigests: [],
      recoveryOriginBindingIds: [],
    });
    const parsedSnapshot = InterpretationCaseSnapshotSchema.parse({
      caseSnapshotId,
      caseId,
      cohortId,
      roundIdentity: '9'.repeat(64),
      lineageKey,
      policyClass: 'general',
      semanticProjectionDigest,
      memberRawFindingIds: [rawFindingId],
      memberObservationDigests: [observationDigest],
      originSnapshotSetDigest: 'a'.repeat(64),
      createdAt: observation,
    });

    expect(rawFindingId.length).toBeGreaterThan(400);
    expect(parsedObservation.rawFindingId).toBe(rawFindingId);
    expect(parsedSnapshot.memberRawFindingIds).toEqual([rawFindingId]);
  });

  it('requires semantic projection identity and stage-specific attempt times', () => {
    expect(() => InterpretationRawObservationSchema.parse({
      rawFindingId: 'raw-schema',
      caseId,
      cohortId,
      lineageKey,
      canonicalIntegrityDigest: '3'.repeat(64),
    })).toThrow();
    expect(() => InterpretationAttemptSchema.parse({
      ...attemptBase,
      stage: 'started',
    })).toThrow();
    expect(() => InterpretationAttemptSchema.parse({
      ...attemptBase,
      stage: 'applied',
      startedAt: observation,
      completedAt: observation,
      decision: { kind: 'provisional', reason: 'Held for review.' },
    })).toThrow();
  });

  it('rejects attempt timestamps that move backward', () => {
    expect(() => InterpretationAttemptSchema.parse({
      ...attemptBase,
      stage: 'applied',
      startedAt: { ...observation, timestamp: '2026-08-02T00:02:00.000Z' },
      completedAt: { ...observation, timestamp: '2026-08-02T00:01:00.000Z' },
      appliedAt: observation,
      decision: { kind: 'provisional', reason: 'Held for review.' },
      application: {
        classification: 'decision_applied',
        originSettlementIds: [],
      },
    })).toThrow(/must not precede/u);
  });

  it('derives a receipt solely from its canonical fences', () => {
    const fences = [{
      attemptId,
      caseId,
      semanticProjectionDigest,
      rawFindingIds: ['raw-schema'],
    }];
    const receipt = {
      batchId: computeInterpretationBatchId(fences),
      fences,
    };

    expect(InterpretationBatchReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => InterpretationBatchReceiptSchema.parse({
      ...receipt,
      batchId: '5'.repeat(64),
    })).toThrow(/canonical fences/u);
    expect(() => InterpretationBatchReceiptSchema.parse({
      ...receipt,
      ownedAttemptIds: [attemptId],
    })).toThrow();
  });

  it('requires receipt fences to be unique and binary-sorted by attempt id', () => {
    const otherAttemptId = computeInterpretationAttemptId(caseSnapshotId, 2, 0);
    const fences = [
      {
        attemptId,
        caseId,
        semanticProjectionDigest,
        rawFindingIds: ['raw-schema'],
      },
      {
        attemptId: otherAttemptId,
        caseId,
        semanticProjectionDigest,
        rawFindingIds: ['raw-schema-other'],
      },
    ].sort((left, right) => compareBinaryStrings(left.attemptId, right.attemptId));
    const receipt = {
      batchId: computeInterpretationBatchId(fences),
      fences,
    };

    expect(InterpretationBatchReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => InterpretationBatchReceiptSchema.parse({
      batchId: computeInterpretationBatchId([...fences].reverse()),
      fences: [...fences].reverse(),
    })).toThrow(/binary-sorted/u);
    expect(() => InterpretationBatchReceiptSchema.parse({
      batchId: computeInterpretationBatchId([fences[0]!, fences[0]!]),
      fences: [fences[0]!, fences[0]!],
    })).toThrow(/unique/u);
  });
});

describe('item 7: relation schema invariants', () => {
  it('Given relation "new" with a non-empty targetFindingId When parsed Then it is rejected', () => {
    expect(() => parseRawFindings([{
      rawFindingId: 'raw-1',
      stepName: 's',
      reviewer: 'r',
      familyTag: 'bug',
      severity: 'high',
      title: 't',
      description: 'd',
      relation: 'new',
      targetFindingId: 'F-0001',
    }])).toThrow();
  });

  it('Given relation "persists" with no targetFindingId When parsed Then it is rejected', () => {
    expect(() => parseRawFindings([{
      rawFindingId: 'raw-1',
      stepName: 's',
      reviewer: 'r',
      familyTag: 'bug',
      severity: 'high',
      title: 't',
      description: 'd',
      relation: 'persists',
    }])).toThrow();
  });

  it('Given an unknown field instead of relation When parsed Then normal strict validation rejects it', () => {
    expect(() => parseRawFindings([{
      rawFindingId: 'raw-1',
      stepName: 's',
      reviewer: 'r',
      familyTag: 'bug',
      severity: 'high',
      title: 't',
      description: 'd',
      kind: 'issue',
    }])).toThrow(/Unrecognized key/);
  });
});

describe('finding raw schemas', () => {
  it('should require relation', () => {
    expect(() => parseRawFindings([
      {
        rawFindingId: 'raw-invalid',
        stepName: 'arch-review',
        reviewer: 'arch-review',
        familyTag: 'bug',
        severity: 'high',
        title: 'Missing relation',
        description: 'The current contract requires relation.',
      },
    ])).toThrow();
  });

  it('should reject removed flat location and suggestion fields from structured output', () => {
    expect(() => parseReviewerRawFindings([
      {
        rawFindingId: 'raw-confirm',
        familyTag: 'bug',
        severity: 'low',
        title: 'Confirmed fixed',
        description: 'Verified at src/index.ts:42.',
        relation: 'resolution_confirmation',
        targetFindingId: 'F-0001',
        location: '',
        suggestion: null,
        evidence: [],
      },
    ])).toThrow();
  });

  it('should accept an empty targetFindingIds set for a new finding', () => {
    const parsed = parseReviewerRawFindings([
      reviewerRawExtractionFixture({
        rawFindingId: 'raw-1',
        familyTag: 'bug',
        severity: 'low',
        title: 'Issue entry',
        description: 'Strict structured output fills every field.',
        suggestion: null,
        relation: 'new',
        targetFindingId: null,
        evidence: [],
      }),
    ]);

    expect(parsed[0]?.candidate?.relation).toBe('new');
    expect(parsed[0]?.candidate?.targetFindingIds).toEqual([]);
  });
});
