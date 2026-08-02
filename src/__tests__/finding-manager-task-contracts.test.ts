import { describe, expect, it } from 'vitest';
import {
  FindingEntityBindingTaskOutputJsonSchema,
  MainManagerControlTaskOutputJsonSchema,
  MainManagerRawTaskOutputJsonSchema,
  parseFindingEntityBindingTaskOutput,
} from '../core/workflow/findings/manager-task-contracts.js';
import { RAW_FINDING_FIELD_LIMITS } from '../core/models/finding-contract-limits.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectConstrainedSchemas(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectConstrainedSchemas);
  }
  if (!isRecord(value)) {
    return [];
  }

  const descendants = Object.values(value).flatMap(collectConstrainedSchemas);
  return Object.hasOwn(value, 'enum') || Object.hasOwn(value, 'const')
    ? [value, ...descendants]
    : descendants;
}

describe('finding manager task contracts', () => {
  it.each([
    ['raw task', MainManagerRawTaskOutputJsonSchema, 3],
    ['control task', MainManagerControlTaskOutputJsonSchema, 8],
    ['entity binding task', FindingEntityBindingTaskOutputJsonSchema, 1],
  ])('declares matching string types for every enum and const in the %s output schema', (
    _name,
    schema,
    expectedCount,
  ) => {
    const constrainedSchemas = collectConstrainedSchemas(schema);

    expect(constrainedSchemas).toHaveLength(expectedCount);
    for (const constrainedSchema of constrainedSchemas) {
      const values = Array.isArray(constrainedSchema.enum)
        ? constrainedSchema.enum
        : [constrainedSchema.const];
      expect(constrainedSchema.type).toBe('string');
      expect(values.every((value) => typeof value === 'string')).toBe(true);
    }
  });

  it('allows the empty bind_existing group sentinel without relaxing raw finding ID limits', () => {
    const taskId = 'a'.repeat(64);
    const rawFindingId = 'raw-1';
    const bindExisting = {
      taskId,
      decisions: [{
        rawFindingId,
        decision: 'bind_existing',
        findingId: 'F-0001',
        groupRawFindingId: '',
        reason: 'Matches the existing semantic entity.',
      }],
    };

    expect(parseFindingEntityBindingTaskOutput(bindExisting)).toEqual(bindExisting);

    const maximumGroupRawFindingId = 'x'.repeat(
      RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
    );
    const newEntity = {
      taskId,
      decisions: [{
        rawFindingId,
        decision: 'new_entity',
        findingId: '',
        groupRawFindingId: maximumGroupRawFindingId,
        reason: 'Represents a distinct semantic entity.',
      }],
    };
    expect(parseFindingEntityBindingTaskOutput(newEntity)).toEqual(newEntity);
    expect(() => parseFindingEntityBindingTaskOutput({
      ...newEntity,
      decisions: [{
        ...newEntity.decisions[0],
        groupRawFindingId: `${maximumGroupRawFindingId}x`,
      }],
    })).toThrow();

    expect(
      FindingEntityBindingTaskOutputJsonSchema
        .properties.decisions.items.properties.groupRawFindingId,
    ).toEqual({
      type: 'string',
      minLength: 0,
      maxLength: RAW_FINDING_FIELD_LIMITS.maxWireRawFindingIdChars,
    });
  });
});
