import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getResourcesDir } from './index.js';
import { MAX_TEAM_LEADER_MAX_TOTAL_PARTS } from '../../shared/constants.js';

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

export function loadDecompositionSchema(maxTotalParts: number): JsonSchema {
  if (!Number.isInteger(maxTotalParts) || maxTotalParts <= 0) {
    throw new Error(`maxTotalParts must be a positive integer: ${maxTotalParts}`);
  }
  if (maxTotalParts > MAX_TEAM_LEADER_MAX_TOTAL_PARTS) {
    throw new Error(`maxTotalParts must be less than or equal to ${MAX_TEAM_LEADER_MAX_TOTAL_PARTS}: ${maxTotalParts}`);
  }

  const schema = cloneSchema(loadSchema('decomposition.json'));
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('decomposition schema is invalid: properties is missing');
  }
  const rawParts = (properties as Record<string, unknown>).parts;
  if (!rawParts || typeof rawParts !== 'object' || Array.isArray(rawParts)) {
    throw new Error('decomposition schema is invalid: parts is missing');
  }

  (rawParts as Record<string, unknown>).maxItems = maxTotalParts;
  return schema;
}

export function loadMorePartsSchema(maxAdditionalParts: number): JsonSchema {
  if (!Number.isInteger(maxAdditionalParts) || maxAdditionalParts <= 0) {
    throw new Error(`maxAdditionalParts must be a positive integer: ${maxAdditionalParts}`);
  }

  const schema = cloneSchema(loadSchema('more-parts.json'));
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('more-parts schema is invalid: properties is missing');
  }
  const rawParts = (properties as Record<string, unknown>).parts;
  if (!rawParts || typeof rawParts !== 'object' || Array.isArray(rawParts)) {
    throw new Error('more-parts schema is invalid: parts is missing');
  }

  (rawParts as Record<string, unknown>).maxItems = maxAdditionalParts;
  return schema;
}
