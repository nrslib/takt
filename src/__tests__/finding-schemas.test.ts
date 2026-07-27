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
      rawFindings: [],
      conflicts: [],
      interpretations: [],
    };

    expect(parseFindingLedger(ledger)).toEqual(ledger);
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
      rawFindings: [],
      conflicts: [],
      interpretations: [],
      [field]: {
        roundMarkers,
        firstRoundAt: '2026-07-24T00:00:00.000Z',
        exhausted: false,
      },
    })).toThrow(/binary-sorted unique set/);
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
        firstSeen: provisional.firstObservedAt,
        lastSeen: provisional.lastObservedAt,
        revision: 1,
        provisional,
      }],
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

  it('creates a provider-facing snapshotId enum for each review round without changing the static lenient validation schema', () => {
    const firstRound = createRawFindingsOutputJsonSchema('review-snapshot-first');
    const secondRound = createRawFindingsOutputJsonSchema('review-snapshot-second');
    const getSnapshotIdSchema = (schema: typeof firstRound) =>
      schema.properties.rawFindings.items.properties.snapshotId;

    expect(getSnapshotIdSchema(firstRound).enum).toEqual(['', 'review-snapshot-first']);
    expect(getSnapshotIdSchema(secondRound).enum).toEqual(['', 'review-snapshot-second']);
    expect(getSnapshotIdSchema(firstRound).enum).not.toContain('review-snapshot-second');
    expect(RawFindingsOutputValidationJsonSchema.properties.rawFindings.items.properties.snapshotId)
      .toEqual(RawFindingsOutputJsonSchema.properties.rawFindings.items.properties.snapshotId);
  });

  it('describes the complete resolution confirmation evidence contract in the provider schema', () => {
    const properties = RawFindingsOutputJsonSchema.properties.rawFindings.items.properties;

    expect(properties.relation.description).toContain('one contiguous');
    expect(properties.location.description).toContain('Exactly one contiguous');
    expect(properties.verbatimExcerpt.description).toContain('complete');
    expect(properties.verbatimExcerpt.description).toContain('current');
    expect(properties.snapshotId.description).toContain('current');
    expect(properties.snapshotId.description).toContain('resolution_confirmation');
  });

  it('uses finding type constants for schema enum values', () => {
    expect(FindingSeveritySchema.options).toEqual(FINDING_SEVERITIES);
    expect(FindingStatusSchema.options).toEqual(FINDING_STATUSES);
    expect(FindingLifecycleSchema.options).toEqual(FINDING_LIFECYCLES);
    expect(FindingManagerOutputJsonSchema.properties.newFindings.items.properties.severity.enum).toBe(FINDING_SEVERITIES);
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.properties.severity.enum).toBe(FINDING_SEVERITIES);

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
    const reviewerRawFinding = {
      rawFindingId: 'raw-1',
      familyTag: 'missing-edge-case',
      severity: 'high',
      title: 'Structured output omits the family tag',
      location: 'src/core/workflow/findings/manager-runner.ts:72',
      description: 'The findings manager cannot reconcile findings without familyTag.',
      suggestion: 'Keep reviewer raw finding fields complete for reconciliation.',
      relation: 'new',
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
      location: 'src/core/workflow/findings/manager-runner.ts:72',
      description: 'The findings manager cannot reconcile findings without familyTag.',
      suggestion: 'Keep reviewer raw finding fields complete for reconciliation.',
    })).toThrow();
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.required).toContain('familyTag');
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.required).toContain('location');
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.required).toContain('suggestion');
    expect(RawFindingsOutputJsonSchema.properties.rawFindings.items.properties.familyTag).toEqual({
      type: 'string',
      minLength: 1,
      description: 'Structured form of the Observed Findings family_tag value. A classification/search hint only — it is not used to determine whether two findings are the same issue.',
    });
  });

  it('keeps target mutation authority engine-issued and persisted only', () => {
    const reviewerTarget = {
      rawFindingId: 'raw-target',
      familyTag: 'state',
      severity: 'high',
      title: 'State remains invalid',
      location: 'src/state.ts:1',
      description: 'The invalid state remains.',
      suggestion: 'Repair the transition.',
      relation: 'persists',
      targetFindingId: 'F-0001',
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
