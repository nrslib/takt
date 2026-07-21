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
  parseFindingManagerOutput,
} from '../core/models/finding-schemas.js';
import { compareRfc3339Timestamps } from '../core/models/rfc3339.js';

describe('finding schemas', () => {
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

  it('post-hoc 検証用 schema は typed evidence protocol の3フィールドだけを required から外す', () => {
    const strictItem = RawFindingsOutputJsonSchema.properties.rawFindings.items;
    const lenientItem = RawFindingsOutputValidationJsonSchema.properties.rawFindings.items;
    // required は strict 版から evidenceKind/verbatimExcerpt/snapshotId を除いたもの
    // （codex 対策#4: schema が生成を拘束しない劣化経路のモデルがこれらを省略しても
    // structured output 全体を無効にしない — finding-schemas.ts の doc コメント参照）。
    const evidenceFields = ['evidenceKind', 'verbatimExcerpt', 'snapshotId'];
    expect(lenientItem.required).toEqual(
      strictItem.required.filter((key) => !evidenceFields.includes(key)),
    );
    expect(Object.keys(lenientItem.properties).sort()).toEqual(
      Object.keys(strictItem.properties).sort(),
    );
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
});
