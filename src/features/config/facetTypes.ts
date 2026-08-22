import type { FacetType } from '../../infra/config/paths.js';

const FACET_TYPE_MAP = {
  persona: 'personas',
  policy: 'policies',
  knowledge: 'knowledge',
  instruction: 'instructions',
  'output-contract': 'output-contracts',
} as const satisfies Record<string, FacetType>;

export const VALID_FACET_TYPES = Object.freeze(Object.keys(FACET_TYPE_MAP));

export function parseFacetType(singular: string): FacetType | undefined {
  if (!Object.hasOwn(FACET_TYPE_MAP, singular)) {
    return undefined;
  }
  return FACET_TYPE_MAP[singular as keyof typeof FACET_TYPE_MAP];
}
