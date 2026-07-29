import { describe, expect, it } from 'vitest';
import {
  MainManagerControlTaskOutputJsonSchema,
  MainManagerRawTaskOutputJsonSchema,
} from '../core/workflow/findings/manager-task-contracts.js';

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
    ['raw task', MainManagerRawTaskOutputJsonSchema, 2],
    ['control task', MainManagerControlTaskOutputJsonSchema, 6],
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
});
