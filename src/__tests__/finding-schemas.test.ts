import { describe, expect, it } from 'vitest';
import {
  FINDING_CONFLICT_STATUSES,
  FINDING_LIFECYCLES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  RAW_FINDING_KINDS,
} from '../core/models/finding-types.js';
import {
  FindingLifecycleSchema,
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

describe('finding schemas', () => {
  it('keeps strict JSON Schema object properties listed in required', () => {
    // provider-facing schema は strict 様式（全 properties が required、optional
    // プロパティ無し）を維持する。OpenAI/Codex 系 native structured output は
    // これを要求し、違反すると生成前に schema 自体が拒否される。legacy `kind` の
    // 寛容受理は post-hoc 検証専用の RawFindingsOutputValidationJsonSchema が担う
    // （下のテスト参照）。
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
  });

  it('post-hoc 検証用の寛容版 schema は legacy kind を optional で追加し、typed evidence protocol の3フィールドも required から外した strict 版の上位集合になっている', () => {
    const strictItem = RawFindingsOutputJsonSchema.properties.rawFindings.items;
    const lenientItem = RawFindingsOutputValidationJsonSchema.properties.rawFindings.items;
    // required は strict 版から evidenceKind/verbatimExcerpt/snapshotId を除いたもの
    // （codex 対策#4: schema が生成を拘束しない劣化経路のモデルがこれらを省略しても
    // structured output 全体を無効にしない — finding-schemas.ts の doc コメント参照）。
    const evidenceFields = ['evidenceKind', 'verbatimExcerpt', 'snapshotId'];
    expect(lenientItem.required).toEqual(
      strictItem.required.filter((key) => !evidenceFields.includes(key)),
    );
    // properties は strict 版 + kind のみ（typed evidence の3フィールドは
    // properties としては残る — optional で受理するだけで、存在自体は許す）。
    expect(Object.keys(lenientItem.properties).sort()).toEqual(
      [...Object.keys(strictItem.properties), 'kind'].sort(),
    );
    expect(lenientItem.properties.kind.enum).toEqual(RAW_FINDING_KINDS);
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
