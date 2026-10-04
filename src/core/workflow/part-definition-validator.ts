import type { PartDefinition } from '../models/part.js';
import { isTimeoutContinuationPartId } from './team-leader-continuation-ids.js';

export class PartDefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartDefinitionValidationError';
  }
}

function assertNonEmptyString(value: unknown, fieldName: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PartDefinitionValidationError(`Part[${index}] "${fieldName}" must be a non-empty string`);
  }
  return value;
}

export function parsePartDefinitionEntry(entry: unknown, index: number): PartDefinition {
  if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
    throw new PartDefinitionValidationError(`Part[${index}] must be an object`);
  }

  const raw = entry as Record<string, unknown>;
  if ('timeout_ms' in raw) {
    throw new PartDefinitionValidationError(
      `Part[${index}] "timeout_ms" is not supported; use team_leader.timeout_ms instead`,
    );
  }
  const id = assertNonEmptyString(raw.id, 'id', index);
  if (isTimeoutContinuationPartId(id)) {
    throw new PartDefinitionValidationError(`Part[${index}] "id" uses reserved timeout continuation prefix: ${id}`);
  }
  const title = assertNonEmptyString(raw.title, 'title', index);
  const instruction = assertNonEmptyString(raw.instruction, 'instruction', index);

  return {
    id,
    title,
    instruction,
  };
}

export function ensureUniquePartIds(parts: PartDefinition[]): void {
  const ids = new Set<string>();
  for (const part of parts) {
    if (ids.has(part.id)) {
      throw new PartDefinitionValidationError(`Duplicate part id: ${part.id}`);
    }
    ids.add(part.id);
  }
}
