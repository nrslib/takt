import { createHash } from 'node:crypto';
import type { PartDefinition } from '../models/types.js';
import {
  collectFindingContractPartBatchValidationIssues,
  parseFindingContractPartDefinition,
} from './team-leader-finding-contract.js';
import {
  FindingContractControlValidationError,
  createFindingContractControlValidationIssue,
  type FindingContractControlValidationIssue,
  type FindingContractRejectedOutputDigest,
} from './team-leader-finding-contract-control-validation.js';

export interface FindingContractRejectedDecompositionDigest
  extends FindingContractRejectedOutputDigest {
  readonly partIds: readonly string[];
}

export class FindingContractDecompositionValidationError
  extends FindingContractControlValidationError<FindingContractRejectedDecompositionDigest> {
  constructor(issues: readonly FindingContractControlValidationIssue[], raw: unknown) {
    super(issues, createDecompositionDigest(raw));
    this.name = 'FindingContractDecompositionValidationError';
  }
}

export function validateFindingContractDecomposition(
  rawParts: unknown,
  maxInitialParts: number | undefined,
  targetFindingIds: readonly string[],
): PartDefinition[] {
  if (!Array.isArray(rawParts)) {
    throw new FindingContractDecompositionValidationError([
      decompositionIssue('shape.parts', 'shape', 'parts', 'Structured output "parts" must be an array'),
    ], rawParts);
  }
  const issues: FindingContractControlValidationIssue[] = [];
  if (rawParts.length === 0) {
    issues.push(decompositionIssue(
      'contract.empty_parts',
      'contract',
      'parts',
      'Structured output "parts" must not be empty',
    ));
  }
  if (maxInitialParts !== undefined && rawParts.length > maxInitialParts) {
    issues.push(decompositionIssue(
      'contract.initial_part_limit',
      'contract',
      'parts',
      `Structured output produced too many initial parts: ${rawParts.length} > initial_max_parts ${maxInitialParts}`,
    ));
  }
  const parts: PartDefinition[] = [];
  for (const [index, rawPart] of rawParts.entries()) {
    try {
      parts.push(parseFindingContractPartDefinition(rawPart, index));
    } catch (error) {
      issues.push(decompositionIssue(
        'shape.part',
        'shape',
        `parts[${index}]`,
        error instanceof Error ? error.message : String(error),
      ));
    }
  }
  const seenPartIds = new Set<string>();
  for (const part of parts) {
    if (seenPartIds.has(part.id)) {
      issues.push(decompositionIssue(
        'contract.duplicate_part_id',
        'contract',
        `parts.part:${part.id}`,
        `Duplicate part id: "${part.id}"`,
        { partId: part.id },
      ));
    }
    seenPartIds.add(part.id);
  }
  if (issues.length > 0) {
    throw new FindingContractDecompositionValidationError(issues, rawParts);
  }
  const batchIssues = collectFindingContractPartBatchValidationIssues(parts, targetFindingIds)
    .map((batchIssue): FindingContractControlValidationIssue => (
      createFindingContractControlValidationIssue({
        boundaryKind: 'decomposition',
        code: `contract.${batchIssue.code}`,
        category: batchIssue.code === 'unknown_finding' ? 'reference' : 'contract',
        path: batchIssue.partId === undefined ? 'parts' : `parts.part:${batchIssue.partId}`,
        message: batchIssue.message,
        ...(batchIssue.findingId === undefined ? {} : { findingId: batchIssue.findingId }),
        ...(batchIssue.partId === undefined ? {} : { partId: batchIssue.partId }),
        retryability: 'corrective_retry',
      })
    ));
  if (batchIssues.length > 0) {
    throw new FindingContractDecompositionValidationError(batchIssues, rawParts);
  }
  return parts;
}

function decompositionIssue(
  code: string,
  category: 'shape' | 'contract',
  path: string,
  message: string,
  reference?: { readonly partId?: string },
): FindingContractControlValidationIssue {
  return createFindingContractControlValidationIssue({
    boundaryKind: 'decomposition',
    code,
    category,
    path,
    message,
    ...(reference?.partId === undefined ? {} : { partId: reference.partId }),
    retryability: 'corrective_retry',
  });
}

function createDecompositionDigest(raw: unknown): FindingContractRejectedDecompositionDigest {
  const partIds = Array.isArray(raw)
    ? raw.flatMap((entry) => (
        typeof entry === 'object'
        && entry !== null
        && !Array.isArray(entry)
        && typeof (entry as Record<string, unknown>).id === 'string'
          ? [(entry as Record<string, unknown>).id as string]
          : []
      ))
    : [];
  const canonical = canonicalJson(raw);
  return {
    hash: createHash('sha256').update(canonical).digest('hex'),
    partIds: partIds.slice(0, 100),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
