import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResourcesDir } from './index.js';

type JsonSchema = Record<string, unknown>;

const schemaCache = new Map<string, JsonSchema>();

function loadSchema(name: string): JsonSchema {
  const cached = schemaCache.get(name);
  if (cached) {
    return cached;
  }
  const schemaPath = join(getResourcesDir(), 'schemas', name);
  const content = readFileSync(schemaPath, 'utf-8');
  const parsed = JSON.parse(content) as JsonSchema;
  schemaCache.set(name, parsed);
  return parsed;
}

function cloneSchema(schema: JsonSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

export function loadJudgmentSchema(): JsonSchema {
  return loadSchema('judgment.json');
}

export function loadEvaluationSchema(): JsonSchema {
  return loadSchema('evaluation.json');
}

export function loadDecompositionSchema(maxInitialParts?: number): JsonSchema {
  if (maxInitialParts !== undefined && (!Number.isInteger(maxInitialParts) || maxInitialParts <= 0)) {
    throw new Error(`maxInitialParts must be a positive integer: ${maxInitialParts}`);
  }

  const schema = cloneSchema(loadSchema('decomposition.json'));
  if (maxInitialParts === undefined) {
    return schema;
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('decomposition schema is invalid: properties is missing');
  }
  const rawParts = (properties as Record<string, unknown>).parts;
  if (!rawParts || typeof rawParts !== 'object' || Array.isArray(rawParts)) {
    throw new Error('decomposition schema is invalid: parts is missing');
  }

  (rawParts as Record<string, unknown>).maxItems = maxInitialParts;
  return schema;
}

export function loadMorePartsSchema(): JsonSchema {
  return cloneSchema(loadSchema('more-parts.json'));
}
