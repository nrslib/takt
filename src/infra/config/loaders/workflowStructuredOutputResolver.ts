import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkflowStep } from '../../../core/models/index.js';
import { getResourcesDir } from '../../resources/index.js';
import {
  getGlobalSchemasDir,
  getProjectSchemasDir,
  isPathSafe,
} from '../paths.js';

const SAFE_SCHEMA_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function validateSchemaName(schemaName: string, field: string): string {
  if (!SAFE_SCHEMA_NAME_PATTERN.test(schemaName)) {
    throw new Error(`Invalid ${field} "${schemaName}": expected bare schema identifier`);
  }
  return schemaName;
}

interface StructuredOutputResolutionOptions {
  readonly projectDir: string;
}

export function resolveStructuredOutput(
  step: { structured_output?: { schema_ref: string } },
  workflowSchemas: Record<string, string> | undefined,
  options: StructuredOutputResolutionOptions,
): WorkflowStep['structuredOutput'] {
  const schemaRef = step.structured_output?.schema_ref;
  if (!schemaRef) {
    return undefined;
  }

  const schemaName = validateSchemaName(workflowSchemas?.[schemaRef] ?? schemaRef, 'schema_ref');
  const candidateDirs = [
    getProjectSchemasDir(options.projectDir),
    getGlobalSchemasDir(),
    join(getResourcesDir(), 'schemas'),
  ];
  const schemaPath = candidateDirs
    .map((dir) => resolve(dir, `${schemaName}.json`))
    .find((candidate) => existsSync(candidate));

  if (!schemaPath) {
    throw new Error(`Structured output schema not found for ref "${schemaRef}"`);
  }

  const isAllowed = candidateDirs
    .map((dir) => resolve(dir))
    .some((dir) => isPathSafe(dir, schemaPath));
  if (!isAllowed) {
    throw new Error(`Invalid schema path for ref "${schemaRef}"`);
  }

  return {
    schemaRef,
    schema: JSON.parse(readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>,
  };
}
