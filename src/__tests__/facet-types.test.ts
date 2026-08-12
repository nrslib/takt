import { describe, expect, it } from 'vitest';
import { parseFacetType, VALID_FACET_TYPES } from '../features/config/facetTypes.js';

describe('CLI facet types', () => {
  it('should reject consumer mutation of the published facet names', () => {
    const originalFacetTypes = [...VALID_FACET_TYPES];

    try {
      expect(() => (VALID_FACET_TYPES as string[]).push('unknown')).toThrow(TypeError);
      expect(VALID_FACET_TYPES).toEqual(originalFacetTypes);
    } finally {
      if (VALID_FACET_TYPES.length !== originalFacetTypes.length) {
        (VALID_FACET_TYPES as string[]).splice(0, VALID_FACET_TYPES.length, ...originalFacetTypes);
      }
    }
  });

  it.each([
    ['persona', 'personas'],
    ['policy', 'policies'],
    ['knowledge', 'knowledge'],
    ['instruction', 'instructions'],
    ['output-contract', 'output-contracts'],
  ] as const)('should map %s to %s', (input, expected) => {
    expect(parseFacetType(input)).toBe(expected);
  });

  it.each([
    'unknown',
    'toString',
    'constructor',
    '__proto__',
  ])('should reject unsupported facet type %s', (input) => {
    expect(parseFacetType(input)).toBeUndefined();
  });
});
