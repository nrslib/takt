import { describe, expect, it } from 'vitest';
import {
  FINDING_CONFLICT_STATUSES,
  FINDING_LIFECYCLES,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
} from '../core/models/finding-types.js';
import {
  FindingLifecycleSchema,
  FindingManagerOutputJsonSchema,
  FindingSeveritySchema,
  FindingStatusSchema,
  RawFindingSchema,
  RawFindingsOutputJsonSchema,
  ReviewerRawFindingSchema,
} from '../core/models/finding-schemas.js';

describe('finding schemas', () => {
  it('keeps strict JSON Schema object properties listed in required', () => {
    const rawFindingItem = RawFindingsOutputJsonSchema.properties.rawFindings.items;
    expect(rawFindingItem.required).toEqual(Object.keys(rawFindingItem.properties));

    const managerProperties = FindingManagerOutputJsonSchema.properties;
    expect(managerProperties.matches.items.required).toEqual(Object.keys(managerProperties.matches.items.properties));
    expect(managerProperties.newFindings.items.required).toEqual(Object.keys(managerProperties.newFindings.items.properties));
    expect(managerProperties.resolvedFindings.items.required).toEqual(Object.keys(managerProperties.resolvedFindings.items.properties));
    expect(managerProperties.reopenedFindings.items.required).toEqual(Object.keys(managerProperties.reopenedFindings.items.properties));
    expect(managerProperties.conflicts.items.required).toEqual(Object.keys(managerProperties.conflicts.items.properties));
    expect(managerProperties.resolvedConflicts.items.required).toEqual(Object.keys(managerProperties.resolvedConflicts.items.properties));
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
      description: 'Structured form of the Observed Findings family_tag value.',
    });
  });
});
