import type { FindingsRuleContext } from './finding-types.js';

export type FindingsReferenceValueKind = 'array' | 'boolean' | 'number' | 'object' | 'string';

export type FindingsReferenceDescriptor =
  | { readonly kind: 'array'; readonly item: FindingsReferenceDescriptor }
  | { readonly kind: 'boolean' | 'number' | 'string' }
  | {
    readonly kind: 'object';
    readonly properties: Readonly<Record<string, FindingsReferenceDescriptor>>;
  };

type FindingsValueShape<T> =
  T extends readonly (infer Item)[]
    ? { kind: 'array'; item: FindingsValueShape<Item> }
    : T extends boolean
      ? { kind: 'boolean' }
      : T extends number
        ? { kind: 'number' }
        : T extends string
          ? { kind: 'string' }
          : T extends object
            ? {
              kind: 'object';
              properties: {
                [Key in keyof Required<T>]-?: FindingsValueShape<NonNullable<T[Key]>>;
              };
            }
            : never;

function freezeFindingsDescriptor<T extends FindingsReferenceDescriptor>(
  descriptor: T,
): T {
  if (descriptor.kind === 'array') {
    freezeFindingsDescriptor(descriptor.item);
  } else if (descriptor.kind === 'object') {
    for (const property of Object.values(descriptor.properties)) {
      freezeFindingsDescriptor(property);
    }
    Object.freeze(descriptor.properties);
  }
  return Object.freeze(descriptor);
}

const FINDINGS_RULE_CONTEXT_SHAPE = freezeFindingsDescriptor({
  kind: 'object',
  properties: {
    open: {
      kind: 'object',
      properties: {
        count: { kind: 'number' },
        bySeverity: {
          kind: 'object',
          properties: {
            critical: { kind: 'number' },
            high: { kind: 'number' },
            medium: { kind: 'number' },
            low: { kind: 'number' },
          },
        },
        items: {
          kind: 'array',
          item: {
            kind: 'object',
            properties: {
              id: { kind: 'string' },
              severity: { kind: 'string' },
              title: { kind: 'string' },
              location: { kind: 'string' },
              description: { kind: 'string' },
              suggestion: { kind: 'string' },
              reviewers: { kind: 'array', item: { kind: 'string' } },
              familyTags: { kind: 'array', item: { kind: 'string' } },
              unknownRawFindingIds: { kind: 'array', item: { kind: 'string' } },
            },
          },
        },
      },
    },
    resolved: { kind: 'object', properties: { count: { kind: 'number' } } },
    waived: { kind: 'object', properties: { count: { kind: 'number' } } },
    provisional: {
      kind: 'object',
      properties: {
        count: { kind: 'number' },
        fixpoint: { kind: 'boolean' },
        items: {
          kind: 'array',
          item: {
            kind: 'object',
            properties: {
              id: { kind: 'string' },
              kind: { kind: 'string' },
              reason: { kind: 'string' },
            },
          },
        },
      },
    },
    rounds: { kind: 'object', properties: { budgetExhausted: { kind: 'boolean' } } },
    invalidated: { kind: 'object', properties: { count: { kind: 'number' } } },
    superseded: { kind: 'object', properties: { count: { kind: 'number' } } },
    reviewerAnomalies: {
      kind: 'object',
      properties: {
        count: { kind: 'number' },
        budgetExhausted: { kind: 'boolean' },
      },
    },
    conflicts: {
      kind: 'object',
      properties: {
        count: { kind: 'number' },
        items: {
          kind: 'array',
          item: {
            kind: 'object',
            properties: {
              id: { kind: 'string' },
              status: { kind: 'string' },
              findingIds: { kind: 'array', item: { kind: 'string' } },
              rawFindingIds: { kind: 'array', item: { kind: 'string' } },
              description: { kind: 'string' },
            },
          },
        },
        unadjudicated: { kind: 'object', properties: { count: { kind: 'number' } } },
      },
    },
  },
} satisfies FindingsValueShape<FindingsRuleContext>);

function resolveFindingsValueShape(
  shape: FindingsReferenceDescriptor,
  path: readonly string[],
): FindingsReferenceDescriptor | undefined {
  const [segment, ...remaining] = path;
  if (segment === undefined) return shape;

  if (shape.kind === 'object') {
    const property = Object.hasOwn(shape.properties, segment)
      ? shape.properties[segment]
      : undefined;
    return property === undefined ? undefined : resolveFindingsValueShape(property, remaining);
  }
  if (shape.kind !== 'array') return undefined;
  if (segment === 'length') {
    return resolveFindingsValueShape({ kind: 'number' }, remaining);
  }
  if (/^\d+$/.test(segment)) {
    return resolveFindingsValueShape(shape.item, remaining);
  }
  if (shape.item.kind !== 'object') return undefined;

  const projectedProperty = Object.hasOwn(shape.item.properties, segment)
    ? shape.item.properties[segment]
    : undefined;
  if (projectedProperty === undefined) return undefined;
  return resolveFindingsValueShape(
    { kind: 'array', item: projectedProperty },
    remaining,
  );
}

export function describeFindingsReferencePath(
  path: readonly string[],
): FindingsReferenceDescriptor | undefined {
  return resolveFindingsValueShape(FINDINGS_RULE_CONTEXT_SHAPE, path);
}

export function describeFindingsNestedPath(
  descriptor: FindingsReferenceDescriptor,
  path: readonly string[],
): FindingsReferenceDescriptor | undefined {
  return resolveFindingsValueShape(descriptor, path);
}
