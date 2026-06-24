const CODEX_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'allOf',
]);

const SCHEMA_MAP_KEYS = new Set([
  '$defs',
  'definitions',
  'properties',
]);

const SCHEMA_VALUE_KEYS = new Set([
  'additionalProperties',
  'contains',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'else',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSchemaKeywordValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (isPlainObject(item) ? normalizeCodexOutputSchema(item) : item));
  }
  if (isPlainObject(value)) {
    return normalizeCodexOutputSchema(value);
  }
  return value;
}

function normalizeSchemaMap(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, nestedSchema] of Object.entries(value)) {
    normalized[key] = normalizeSchemaKeywordValue(nestedSchema);
  }
  return normalized;
}

function collectRequiredProperties(
  properties: Record<string, unknown>,
  currentRequired: unknown,
): string[] {
  const required = Array.isArray(currentRequired)
    ? currentRequired.filter((value): value is string => typeof value === 'string')
    : [];
  const seen = new Set(required);

  for (const propertyName of Object.keys(properties)) {
    if (!seen.has(propertyName)) {
      required.push(propertyName);
      seen.add(propertyName);
    }
  }

  return required;
}

export function normalizeCodexOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    if (CODEX_UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      // Codex forwards this schema to OpenAI response_format, which rejects allOf before the model call.
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key)) {
      normalized[key] = normalizeSchemaMap(value);
      continue;
    }
    if (SCHEMA_VALUE_KEYS.has(key)) {
      normalized[key] = normalizeSchemaKeywordValue(value);
      continue;
    }
    normalized[key] = value;
  }

  if (isPlainObject(normalized.properties)) {
    // OpenAI Structured Outputs requires every object property to be listed as required.
    normalized.required = collectRequiredProperties(normalized.properties, normalized.required);
  }

  return normalized;
}
