import { createHash } from 'node:crypto';
import type {
  FindingContractPartCompletionClaim,
  PartDefinition,
} from '../models/types.js';
import { FILE_LINE_EVIDENCE_PATTERN } from './findings/evidence.js';
import {
  parseFindingContractPartCompletionClaim,
} from './team-leader-finding-contract.js';
import {
  findingContractPathIsWithin,
  normalizeFindingContractPath,
} from './team-leader-finding-contract-validation.js';
import {
  FindingContractControlValidationError,
  createFindingContractControlValidationIssue,
  type FindingContractControlValidationIssue,
  type FindingContractRejectedOutputDigest,
} from './team-leader-finding-contract-control-validation.js';

export interface FindingContractRejectedPartCompletionDigest
  extends FindingContractRejectedOutputDigest {
  readonly preview: string;
}

export class FindingContractPartCompletionValidationError
  extends FindingContractControlValidationError<FindingContractRejectedPartCompletionDigest> {
  constructor(
    issues: readonly FindingContractControlValidationIssue[],
    raw: unknown,
  ) {
    super(issues, createRejectedPartCompletionDigest(raw));
    this.name = 'FindingContractPartCompletionValidationError';
  }
}

export function createFindingContractPartCompletionStructuredOutputError(
  part: PartDefinition,
  detail: string,
  kind: 'model_output' | 'schema_config',
  raw: unknown,
  modelIssues?: readonly {
    readonly path: string;
    readonly keyword: string;
    readonly message: string;
  }[],
): FindingContractPartCompletionValidationError {
  const schemaConfigError = kind === 'schema_config';
  const issues = schemaConfigError || modelIssues === undefined
    ? [{
        path: '$',
        code: schemaConfigError ? 'contract.schema_config' : 'shape.structured_output',
        message: detail,
      }]
    : modelIssues.map((modelIssue) => ({
        path: modelIssue.path,
        code: `shape.schema.${modelIssue.keyword}`,
        message: modelIssue.message,
      }));
  return new FindingContractPartCompletionValidationError(issues.map((modelIssue) => (
    createFindingContractControlValidationIssue({
      boundaryKind: 'part_completion',
      code: modelIssue.code,
      category: schemaConfigError ? 'contract' : 'shape',
      path: modelIssue.path,
      message: modelIssue.message,
      partId: part.id,
      retryability: schemaConfigError ? 'terminal' : 'corrective_retry',
    })
  )), raw);
}

export interface FindingContractPartCompletionMutationGuard {
  readonly changedPaths?: readonly string[];
  readonly checks?: readonly {
    readonly command: string;
    readonly status: 'passed' | 'failed' | 'not_run';
  }[];
  readonly outcomesByFindingId: ReadonlyMap<string, {
    readonly outcome: 'addressed' | 'disputed' | 'blocked';
    readonly evidence: readonly string[];
  }>;
}

export function validateFindingContractPartCompletion(
  raw: unknown,
  part: PartDefinition,
  mutationGuard?: FindingContractPartCompletionMutationGuard,
): FindingContractPartCompletionClaim {
  const issues = collectFindingContractPartCompletionIssues(raw, part);
  if (issues.length > 0) {
    throw new FindingContractPartCompletionValidationError(issues, raw);
  }
  const claim = parseFindingContractPartCompletionClaim(raw, part);
  const mutationIssues = mutationGuard === undefined
    ? []
    : collectMutationGuardIssues(claim, mutationGuard, part.id);
  if (mutationIssues.length > 0) {
    throw new FindingContractPartCompletionValidationError(mutationIssues, raw);
  }
  return claim;
}

export function createFindingContractPartCompletionMutationGuard(
  raw: unknown,
  part: PartDefinition,
): FindingContractPartCompletionMutationGuard {
  const payload = isRecord(raw) ? raw : {};
  return {
    ...(readChangedPaths(payload.changedPaths, part) ?? {}),
    ...(readChecks(payload.checks) ?? {}),
    outcomesByFindingId: readValidOutcomes(payload.findingOutcomes, part),
  };
}

export function collectFindingContractPartCompletionIssues(
  raw: unknown,
  part: PartDefinition,
): FindingContractControlValidationIssue[] {
  const issues: FindingContractControlValidationIssue[] = [];
  const assignment = part.findingContract;
  if (assignment === undefined) {
    return [issue({
      code: 'contract.missing_assignment',
      category: 'contract',
      path: '$',
      message: `Part "${part.id}" is missing findingContract assignment`,
      partId: part.id,
      retryability: 'terminal',
    })];
  }
  if (!isRecord(raw)) {
    return [issue({
      code: 'shape.root',
      category: 'shape',
      path: '$',
      message: `Part "${part.id}" structured output must be an object`,
      partId: part.id,
      retryability: 'corrective_retry',
    })];
  }

  collectUnknownKeys(raw, ['findingOutcomes', 'changedPaths', 'checks', 'summary'], '$', part.id, issues);
  collectOutcomeIssues(raw.findingOutcomes, part, issues);
  collectChangedPathIssues(raw.changedPaths, part, issues);
  collectCheckIssues(raw.checks, part.id, issues);
  collectSummaryIssues(raw.summary, part.id, issues);
  return issues;
}

function collectOutcomeIssues(
  raw: unknown,
  part: PartDefinition,
  issues: FindingContractControlValidationIssue[],
): void {
  const assignment = part.findingContract;
  if (assignment === undefined) return;
  if (!Array.isArray(raw)) {
    issues.push(issue({
      code: 'shape.finding_outcomes_array',
      category: 'shape',
      path: 'findingOutcomes',
      message: `Part "${part.id}" findingOutcomes must be an array`,
      partId: part.id,
      retryability: 'corrective_retry',
    }));
    return;
  }
  const assignedIds = new Set(assignment.findingIds);
  const seenIds = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const path = `findingOutcomes[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue({
        code: 'shape.finding_outcome',
        category: 'shape',
        path,
        message: `Part "${part.id}" ${path} must be an object`,
        partId: part.id,
        retryability: 'corrective_retry',
      }));
      continue;
    }
    collectUnknownKeys(entry, ['findingId', 'outcome', 'evidence'], path, part.id, issues);
    const findingId = readNonEmptyString(entry.findingId);
    if (findingId === undefined) {
      issues.push(issue({
        code: 'shape.finding_id',
        category: 'shape',
        path: `${path}.findingId`,
        message: `Part "${part.id}" ${path}.findingId must be a non-empty string`,
        partId: part.id,
        retryability: 'corrective_retry',
      }));
    } else if (!assignedIds.has(findingId)) {
      issues.push(issue({
        code: 'authority.unassigned_finding',
        category: 'authority',
        path: `${path}.findingId`,
        message: `Part "${part.id}" returned an outcome for unassigned finding "${findingId}"`,
        findingId,
        partId: part.id,
        retryability: 'terminal',
      }));
    } else if (seenIds.has(findingId)) {
      issues.push(issue({
        code: 'contract.duplicate_outcome',
        category: 'contract',
        path: `${path}.findingId`,
        message: `Part "${part.id}" returned duplicate outcomes for finding "${findingId}"`,
        findingId,
        partId: part.id,
        retryability: 'corrective_retry',
      }));
    }
    if (findingId !== undefined) seenIds.add(findingId);

    const outcome = readOutcome(entry.outcome);
    if (outcome === undefined) {
      issues.push(issue({
        code: 'contract.invalid_outcome',
        category: 'contract',
        path: `${path}.outcome`,
        message: `Part "${part.id}" returned an invalid outcome`,
        ...(findingId === undefined ? {} : { findingId }),
        partId: part.id,
        retryability: 'corrective_retry',
      }));
    }
    const evidence = readNonEmptyStringArray(entry.evidence);
    if (evidence === undefined) {
      issues.push(issue({
        code: 'evidence.invalid_evidence',
        category: 'evidence',
        path: `${path}.evidence`,
        message: `Part "${part.id}" ${path}.evidence must be a non-empty array of non-empty strings`,
        ...(findingId === undefined ? {} : { findingId }),
        partId: part.id,
        retryability: 'corrective_retry',
      }));
    } else if (outcome === 'disputed' && !evidence.some((entry) => FILE_LINE_EVIDENCE_PATTERN.test(entry))) {
      issues.push(issue({
        code: 'evidence.disputed_file_line',
        category: 'evidence',
        path: `${path}.evidence`,
        message: `Part "${part.id}" disputed finding "${findingId ?? '(unknown)'}" without file:line evidence`,
        ...(findingId === undefined ? {} : { findingId }),
        partId: part.id,
        retryability: 'corrective_retry',
      }));
    }
  }
  for (const findingId of assignedIds) {
    if (!seenIds.has(findingId)) {
      issues.push(issue({
        code: 'contract.missing_outcome',
        category: 'contract',
        path: `findingOutcomes.finding:${findingId}`,
        message: `Part "${part.id}" omitted an outcome for assigned finding "${findingId}"`,
        findingId,
        partId: part.id,
        retryability: 'corrective_retry',
      }));
    }
  }
}

function collectChangedPathIssues(
  raw: unknown,
  part: PartDefinition,
  issues: FindingContractControlValidationIssue[],
): void {
  if (!Array.isArray(raw)) {
    issues.push(issue({
      code: 'shape.changed_paths_array',
      category: 'shape',
      path: 'changedPaths',
      message: `Part "${part.id}" changedPaths must be an array`,
      partId: part.id,
      retryability: 'corrective_retry',
    }));
    return;
  }
  const writePaths = part.findingContract?.writePaths ?? [];
  for (const [index, entry] of raw.entries()) {
    const path = `changedPaths[${index}]`;
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      issues.push(issue({
        code: 'shape.changed_path',
        category: 'shape',
        path,
        message: `Part "${part.id}" ${path} must be a non-empty relative path`,
        partId: part.id,
        retryability: 'corrective_retry',
      }));
      continue;
    }
    let normalized: string;
    try {
      normalized = normalizeFindingContractPath(entry, `Part "${part.id}" ${path}`);
    } catch (error) {
      issues.push(issue({
        code: 'authority.invalid_changed_path',
        category: 'authority',
        path,
        message: error instanceof Error ? error.message : String(error),
        partId: part.id,
        retryability: 'terminal',
      }));
      continue;
    }
    if (!writePaths.some((writePath) => findingContractPathIsWithin(normalized, writePath))) {
      issues.push(issue({
        code: 'authority.changed_path_outside_assignment',
        category: 'authority',
        path,
        message: `Part "${part.id}" changed path is outside its writePaths assignment: ${normalized}`,
        partId: part.id,
        retryability: 'terminal',
      }));
    }
  }
}

function collectCheckIssues(
  raw: unknown,
  partId: string,
  issues: FindingContractControlValidationIssue[],
): void {
  if (!Array.isArray(raw)) {
    issues.push(issue({
      code: 'shape.checks_array',
      category: 'shape',
      path: 'checks',
      message: `Part "${partId}" checks must be an array`,
      partId,
      retryability: 'corrective_retry',
    }));
    return;
  }
  for (const [index, entry] of raw.entries()) {
    const path = `checks[${index}]`;
    if (!isRecord(entry)) {
      issues.push(issue({
        code: 'shape.check',
        category: 'shape',
        path,
        message: `Part "${partId}" ${path} must be an object`,
        partId,
        retryability: 'corrective_retry',
      }));
      continue;
    }
    collectUnknownKeys(entry, ['command', 'status'], path, partId, issues);
    if (readNonEmptyString(entry.command) === undefined) {
      issues.push(issue({
        code: 'shape.check_command',
        category: 'shape',
        path: `${path}.command`,
        message: `Part "${partId}" ${path}.command must be a non-empty string`,
        partId,
        retryability: 'corrective_retry',
      }));
    }
    if (readCheckStatus(entry.status) === undefined) {
      issues.push(issue({
        code: 'contract.invalid_check_status',
        category: 'contract',
        path: `${path}.status`,
        message: `Part "${partId}" returned an invalid check status`,
        partId,
        retryability: 'corrective_retry',
      }));
    }
  }
}

function collectSummaryIssues(
  raw: unknown,
  partId: string,
  issues: FindingContractControlValidationIssue[],
): void {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > 2_000) {
    issues.push(issue({
      code: 'shape.summary',
      category: 'shape',
      path: 'summary',
      message: `Part "${partId}" summary must be a non-empty string of at most 2000 characters`,
      partId,
      retryability: 'corrective_retry',
    }));
  }
}

function collectMutationGuardIssues(
  claim: FindingContractPartCompletionClaim,
  guard: FindingContractPartCompletionMutationGuard,
  partId: string,
): FindingContractControlValidationIssue[] {
  const issues: FindingContractControlValidationIssue[] = [];
  if (guard.changedPaths !== undefined && !sameJson(claim.changedPaths, guard.changedPaths)) {
    issues.push(mutationIssue(partId, 'changedPaths'));
  }
  if (guard.checks !== undefined && !sameJson(claim.checks, guard.checks)) {
    issues.push(mutationIssue(partId, 'checks'));
  }
  for (const outcome of claim.findingOutcomes) {
    const expected = guard.outcomesByFindingId.get(outcome.findingId);
    if (expected !== undefined && !sameJson(outcome, { findingId: outcome.findingId, ...expected })) {
      issues.push(mutationIssue(partId, `findingOutcomes.finding:${outcome.findingId}`, outcome.findingId));
    }
  }
  return issues;
}

function mutationIssue(
  partId: string,
  path: string,
  findingId?: string,
): FindingContractControlValidationIssue {
  return issue({
    code: 'mutation.valid_field_changed',
    category: 'mutation',
    path,
    message: `Part "${partId}" correction changed previously valid field "${path}"`,
    ...(findingId === undefined ? {} : { findingId }),
    partId,
    retryability: 'corrective_retry',
  });
}

function readChangedPaths(
  raw: unknown,
  part: PartDefinition,
): Pick<FindingContractPartCompletionMutationGuard, 'changedPaths'> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const normalized: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) return undefined;
    try {
      const path = normalizeFindingContractPath(entry, 'changedPaths');
      if (!part.findingContract?.writePaths.some((writePath) => findingContractPathIsWithin(path, writePath))) {
        return undefined;
      }
      normalized.push(path);
    } catch {
      return undefined;
    }
  }
  return { changedPaths: normalized };
}

function readChecks(
  raw: unknown,
): Pick<FindingContractPartCompletionMutationGuard, 'checks'> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const checks: Array<{ command: string; status: 'passed' | 'failed' | 'not_run' }> = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return undefined;
    const command = readNonEmptyString(entry.command);
    const status = readCheckStatus(entry.status);
    if (command === undefined || status === undefined) return undefined;
    checks.push({ command, status });
  }
  return { checks };
}

function readValidOutcomes(
  raw: unknown,
  part: PartDefinition,
): Map<string, { outcome: 'addressed' | 'disputed' | 'blocked'; evidence: string[] }> {
  const result = new Map<string, { outcome: 'addressed' | 'disputed' | 'blocked'; evidence: string[] }>();
  if (!Array.isArray(raw)) return result;
  const assignedIds = new Set(part.findingContract?.findingIds ?? []);
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const findingId = readNonEmptyString(entry.findingId);
    const outcome = readOutcome(entry.outcome);
    const evidence = readNonEmptyStringArray(entry.evidence);
    if (
      findingId === undefined
      || !assignedIds.has(findingId)
      || result.has(findingId)
      || outcome === undefined
      || evidence === undefined
      || (outcome === 'disputed' && !evidence.some((item) => FILE_LINE_EVIDENCE_PATTERN.test(item)))
    ) {
      continue;
    }
    result.set(findingId, { outcome, evidence });
  }
  return result;
}

function createRejectedPartCompletionDigest(raw: unknown): FindingContractRejectedPartCompletionDigest {
  const canonical = canonicalJson(raw);
  return {
    hash: createHash('sha256').update(canonical).digest('hex'),
    preview: canonical.length <= 2_000 ? canonical : `${canonical.slice(0, 1_999)}…`,
  };
}

function collectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  partId: string,
  issues: FindingContractControlValidationIssue[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value).filter((key) => !allowed.has(key)).sort()) {
    issues.push(issue({
      code: 'shape.unknown_key',
      category: 'shape',
      path: `${path}.${key}`,
      message: `Part "${partId}" ${path} contains unknown property "${key}"`,
      partId,
      retryability: 'corrective_retry',
    }));
  }
}

function issue(
  input: Omit<FindingContractControlValidationIssue, 'boundaryKind'>,
): FindingContractControlValidationIssue {
  return createFindingContractControlValidationIssue({
    ...input,
    boundaryKind: 'part_completion',
  });
}

function readOutcome(value: unknown): 'addressed' | 'disputed' | 'blocked' | undefined {
  return value === 'addressed' || value === 'disputed' || value === 'blocked'
    ? value
    : undefined;
}

function readCheckStatus(value: unknown): 'passed' | 'failed' | 'not_run' | undefined {
  return value === 'passed' || value === 'failed' || value === 'not_run'
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return undefined;
  const strings = value.filter((entry): entry is string => (
    typeof entry === 'string' && entry.trim().length > 0 && entry.length <= 1_000
  ));
  return strings.length === value.length ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
