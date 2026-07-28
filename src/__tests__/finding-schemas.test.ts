import { describe, expect, it } from 'vitest';
import {
  FINDING_CONFLICT_STATUSES,
  FINDING_LIFECYCLES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
} from '../core/models/finding-types.js';
import {
  FindingLifecycleSchema,
  FindingConflictAdjudicationAttemptSchema,
  FindingObservationSchema,
  FindingManagerDecisionsJsonSchema,
  FindingManagerOutputJsonSchema,
  FindingSeveritySchema,
  FindingStatusSchema,
  RawFindingSchema,
  RawFindingsOutputJsonSchema,
  RawFindingsOutputValidationJsonSchema,
  ReviewerRawFindingSchema,
  createRawFindingsOutputJsonSchema,
  parseFindingLedger,
  parseFindingManagerDecisions,
  parseFindingManagerOutput,
} from '../core/models/finding-schemas.js';
import { compareRfc3339Timestamps } from '../core/models/rfc3339.js';
import { formatConflictId } from '../core/models/finding-conflict-identity.js';
import { RAW_FINDING_FIELD_LIMITS } from '../core/models/finding-contract-limits.js';
import { computeFileQuoteEvidenceRecordId } from '../core/models/finding-evidence-record.js';
import { deduplicateRawEvidence } from '../core/workflow/findings/evidence-domain.js';

const TEST_INTEGRITY_DIGEST = 'a'.repeat(64);
import { FINDING_CONFLICT_ADJUDICATION_SCHEMA_REF } from '../core/workflow/findings/adjudication-step.js';
import { RAW_FINDINGS_SCHEMA_REF } from '../core/workflow/findings/manager-agent.js';
import {
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
  return {
    id,
    status: 'open',
    lifecycle: 'new',
    revision: 1,
    severity: 'high',
    title: 'Pending finding',
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
      RAW_ADJUDICATION_SCHEMA_REF,
    ]).toEqual([
      'takt.findings.adjudication',
      'takt.findings.raw',
      'takt.findings.interpretation',
      'takt.findings.manager',
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
    };

    expect(parseFindingLedger(ledger)).toEqual(ledger);
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
    const canonical = {
      id: 'F-0001',
      status: 'open',
      lifecycle: 'new',
      severity: 'high',
      title: 'Canonical',
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
      stopBudget: state,
      reviewIntegrity: state,
    };

    expect(parseFindingLedger(ledger)).toEqual(ledger);
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

  it('requires an adjudication reservation token', () => {
    const attempt = {
      evidenceHash: 'evidence-hash',
      reservationToken: 'reservation-token',
      startedAt: {
        runId: 'run-1',
        stepName: 'finding-conflict-adjudication',
        timestamp: '2026-07-17T00:00:00.000Z',
      },
    };

    expect(FindingConflictAdjudicationAttemptSchema.parse(attempt)).toEqual(attempt);
    const { reservationToken: _reservationToken, ...withoutToken } = attempt;
    expect(() => FindingConflictAdjudicationAttemptSchema.parse(withoutToken)).toThrow();
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
  });

  it('keeps strict JSON Schema object properties listed in required for the manager decisions schema', () => {
    const decisionsProperties = FindingManagerDecisionsJsonSchema.properties;
    expect(FindingManagerDecisionsJsonSchema.required).toEqual(Object.keys(decisionsProperties));
    expect(decisionsProperties.rawDecisions.items.required).toEqual(Object.keys(decisionsProperties.rawDecisions.items.properties));
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
  });

  it('post-hoc 検証用 schema は item 欠損を per-item ambiguity へ渡す', () => {
    const strictItem = RawFindingsOutputJsonSchema.properties.rawFindings.items;
    const lenientItem = RawFindingsOutputValidationJsonSchema.properties.rawFindings.items;
    expect(lenientItem.required).toEqual([]);
    expect(Object.keys(lenientItem.properties).sort()).toEqual(
      Object.keys(strictItem.properties).sort(),
    );
  });

  it('binds only file_quote evidence to the current review snapshot in the provider schema', () => {
    const firstSnapshotId = '1'.repeat(64);
    const secondSnapshotId = '2'.repeat(64);
    const firstRound = createRawFindingsOutputJsonSchema(firstSnapshotId);
    const secondRound = createRawFindingsOutputJsonSchema(secondSnapshotId);
    type ProviderEvidenceBranch = {
      properties: {
        kind: { enum: string[] };
        snapshotId?: { enum: string[] };
      };
    };
    const branchesOf = (schema: unknown) =>
      (schema as {
        properties: {
          rawFindings: {
            items: {
              properties: {
                evidence: { items: { anyOf: ProviderEvidenceBranch[] } };
              };
            };
          };
        };
      }).properties.rawFindings.items.properties.evidence.items.anyOf;
    const fileQuoteOf = (schema: unknown) => branchesOf(schema).find(
      (branch) => branch.properties.kind.enum.includes('file_quote'),
    );
    const engineProofOf = (schema: unknown) => branchesOf(schema).find(
      (branch) => branch.properties.kind.enum.includes('engine_proof'),
    );

    expect(fileQuoteOf(firstRound)).toMatchObject({
      properties: { snapshotId: { enum: [firstSnapshotId] } },
    });
    expect(fileQuoteOf(secondRound)).toMatchObject({
      properties: { snapshotId: { enum: [secondSnapshotId] } },
    });
    expect(fileQuoteOf(firstRound)).not.toMatchObject({
      properties: { snapshotId: { enum: [secondSnapshotId] } },
    });
    expect(engineProofOf(firstRound)).toEqual(engineProofOf(secondRound));

    const staticFileQuote = RawFindingsOutputValidationJsonSchema
      .properties.rawFindings.items.properties.evidence.items.oneOf.find(
        (branch) => branch.properties.kind.const === 'file_quote',
      );
    expect(staticFileQuote).toMatchObject({
      properties: { snapshotId: { pattern: '^[a-f0-9]{64}$' } },
    });
    expect(staticFileQuote).not.toMatchObject({
      properties: { snapshotId: { const: expect.anything() } },
    });
  });

  it('describes the complete resolution confirmation evidence contract in the provider schema', () => {
    const properties = RawFindingsOutputJsonSchema.properties.rawFindings.items.properties;
    const providerEvidence = properties.evidence.items as unknown as {
      anyOf: Array<{
        required: string[];
        properties: Record<string, { enum?: string[] }>;
      }>;
    };
    const fileQuote = providerEvidence.anyOf.find(
      (branch) => branch.properties.kind?.enum?.includes('file_quote') === true,
    );

    expect(properties.relation.description).toContain('resolution_confirmation');
    expect(properties.relation.description).toContain('mechanically verifiable evidence');
    expect(properties.evidence.maxItems).toBe(16);
    expect(fileQuote?.required).toEqual([
      'kind',
      'path',
      'startLine',
      'endLine',
      'verbatimExcerpt',
      'snapshotId',
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

    visit(createRawFindingsOutputJsonSchema('a'.repeat(64)));
  });

  it('uses the same SHA-256 length contract in runtime and provider schemas', () => {
    const base = {
      rawFindingId: 'raw-1',
      relation: 'new' as const,
      targetFindingId: null,
      familyTag: 'bug',
      severity: 'low' as const,
      title: 'title',
      description: 'description',
      suggestion: null,
    };
    expect(() => ReviewerRawFindingSchema.parse({
      ...base,
      evidence: [{ kind: 'engine_proof', proofId: 'a'.repeat(65) }],
    })).toThrow();
    expect(() => ReviewerRawFindingSchema.parse({
      ...base,
      evidence: [{
        kind: 'file_quote',
        path: 'src/a.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'evidence',
        snapshotId: 'a'.repeat(65),
      }],
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

    expect(() => ReviewerRawFindingSchema.parse({
      ...fields,
      rawFindingId: namespacedId,
    })).toThrow();
    expect(RawFindingSchema.parse({
      ...fields,
      rawFindingId: namespacedId,
      stepName: 'reviewers',
      reviewer: 'reviewer-a',
    }).rawFindingId).toBe(namespacedId);
  });

  it('accepts multi-evidence normalized by the canonical evidence ordering helper', () => {
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
    expect(ReviewerRawFindingSchema.parse({
      rawFindingId: 'raw-multi-evidence',
      relation: 'new',
      targetFindingId: null,
      familyTag: 'bug',
      severity: 'low',
      title: 'Multi evidence ordering',
      description: 'Canonical JSON ordering differs from insertion-order JSON.',
      suggestion: null,
      evidence,
    }).evidence).toEqual(evidence);
  });

  it('uses finding type constants for schema enum values', () => {
    expect(FindingSeveritySchema.options).toEqual(FINDING_SEVERITIES);
    expect(FindingStatusSchema.options).toEqual(FINDING_STATUSES);
    expect(FindingLifecycleSchema.options).toEqual(FINDING_LIFECYCLES);
    expect(FindingManagerOutputJsonSchema.properties.newFindings.items.properties.severity.enum).toBe(FINDING_SEVERITIES);
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.properties.severity.enum)
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
    const reviewerRawFinding = {
      rawFindingId: 'raw-1',
      familyTag: 'missing-edge-case',
      severity: 'high',
      title: 'Structured output omits the family tag',
      description: 'The findings manager cannot reconcile findings without familyTag.',
      suggestion: 'Keep reviewer raw finding fields complete for reconciliation.',
      relation: 'new',
      targetFindingId: null,
      evidence,
    };
    const persistedRawFinding = {
      ...reviewerRawFinding,
      stepName: 'ai-antipattern-review',
      reviewer: 'ai-antipattern-reviewer',
    };

    expect(ReviewerRawFindingSchema.parse(reviewerRawFinding).familyTag).toBe('missing-edge-case');
    expect(RawFindingSchema.parse(persistedRawFinding).familyTag).toBe('missing-edge-case');
    expect(() => ReviewerRawFindingSchema.parse({
      rawFindingId: 'raw-1',
      severity: 'high',
      title: 'Structured output omits the family tag',
      description: 'The findings manager cannot reconcile findings without familyTag.',
      suggestion: 'Keep reviewer raw finding fields complete for reconciliation.',
      relation: 'new',
      targetFindingId: null,
      evidence,
    })).toThrow();
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.required).toContain('familyTag');
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.required).toContain('evidence');
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.required).toContain('suggestion');
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.properties.familyTag).toEqual({
      type: ['string', 'null'],
      description: 'Structured form of the Observed Findings family_tag value. A classification/search hint only — it is not used to determine whether two findings are the same issue.',
    });
  });

  it('keeps target mutation authority engine-issued and persisted only', () => {
    const reviewerTarget = {
      rawFindingId: 'raw-target',
      familyTag: 'state',
      severity: 'high',
      title: 'State remains invalid',
      description: 'The invalid state remains.',
      suggestion: 'Repair the transition.',
      relation: 'persists',
      targetFindingId: 'F-0001',
      evidence: [{
        kind: 'file_quote',
        path: 'src/state.ts',
        startLine: 1,
        endLine: 1,
        verbatimExcerpt: 'const state = invalid;',
        snapshotId: 'b'.repeat(64),
      }],
    };
    const targetPrecondition = {
      targetFindingId: 'F-0001',
      targetRevision: 4,
      targetStatus: 'open',
      targetEvidenceHash: 'a'.repeat(64),
    };

    expect(ReviewerRawFindingSchema.parse(reviewerTarget)).not.toHaveProperty('targetPrecondition');
    expect(() => ReviewerRawFindingSchema.parse({
      ...reviewerTarget,
      targetPrecondition,
    })).toThrow();
    expect(() => RawFindingSchema.parse({
      ...reviewerTarget,
      stepName: 'review',
      reviewer: 'reviewer',
    })).toThrow();
    expect(RawFindingSchema.parse({
      ...reviewerTarget,
      stepName: 'review',
      reviewer: 'reviewer',
      targetPrecondition,
    }).targetPrecondition).toEqual(targetPrecondition);
  });

  // 決定スキーマ（FindingManagerDuplicateDecisionSchema）と対称に、出力側の
  // duplicateFindings も duplicate を1件も持たないエントリを拒否する。
  it('rejects a duplicateFindings entry with an empty duplicateFindingIds array', () => {
    const base = {
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
});
