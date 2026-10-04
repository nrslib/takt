const NATIVE_STRUCTURED_OUTPUT_SCHEMA_KEYWORDS = new Set([
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
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);

type NativeStructuredOutputSchemaKeyword =
  | '$defs'
  | '$ref'
  | 'type'
  | 'description'
  | 'properties'
  | 'required'
  | 'additionalProperties'
  | 'enum'
  | 'anyOf'
  | 'items'
  | 'minLength'
  | 'maxLength'
  | 'minItems'
  | 'maxItems';

type ProjectedKeyword<Key> = Key extends 'oneOf'
  ? 'anyOf'
  : Key extends 'const'
    ? 'enum'
    : Key extends NativeStructuredOutputSchemaKeyword
      ? Key
      : never;

type ProjectedSchemaRecord<Value> = Value extends object
  ? { readonly [Key in keyof Value]: ProjectedNativeStructuredOutputSchema<Value[Key]> }
  : never;

export type ProjectedNativeStructuredOutputSchema<Value> =
  Value extends readonly unknown[]
    ? { readonly [Index in keyof Value]: ProjectedNativeStructuredOutputSchema<Value[Index]> }
    : Value extends object
      ? {
          readonly [Key in keyof Value as ProjectedKeyword<Key>]: Key extends 'const'
            ? readonly [Value[Key]]
            : Key extends 'properties' | '$defs'
              ? ProjectedSchemaRecord<Value[Key]>
              : ProjectedNativeStructuredOutputSchema<Value[Key]>
        }
      : Value;

function projectSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(projectSchemaValue);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const schema = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const [keyword, keywordValue] of Object.entries(schema)) {
    const projectedKeyword = keyword === 'oneOf'
      ? 'anyOf'
      : keyword === 'const'
        ? 'enum'
        : keyword;
    if (!NATIVE_STRUCTURED_OUTPUT_SCHEMA_KEYWORDS.has(projectedKeyword)) {
      continue;
    }
    if (projectedKeyword === 'properties' || projectedKeyword === '$defs') {
      projected[projectedKeyword] = Object.fromEntries(
        Object.entries(keywordValue as Record<string, unknown>).map(([name, propertySchema]) => [
          name,
          projectSchemaValue(propertySchema),
        ]),
      );
      continue;
    }
    projected[projectedKeyword] = keyword === 'const'
      ? [keywordValue]
      : projectSchemaValue(keywordValue);
  }
  return projected;
}

export function projectNativeStructuredOutputSchema<const Schema>(
  schema: Schema,
): ProjectedNativeStructuredOutputSchema<Schema> {
  return projectSchemaValue(schema) as ProjectedNativeStructuredOutputSchema<Schema>;
}
