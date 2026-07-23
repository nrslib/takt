import type {
  FindingContractPartCompletionClaim,
  Language,
  PartDefinition,
  PartResult,
} from '../models/types.js';
import type { FindingLedger } from './findings/types.js';
import { FILE_LINE_EVIDENCE_PATTERN } from './findings/evidence.js';
import {
  renderActionableFindingLedgerInstructionSummary,
  renderCompactActionableFindingLedgerInstructionSummary,
  selectActionableFindingEntries,
} from './findings/context.js';
import { parsePartDefinitionEntry } from './part-definition-validator.js';
export {
  createFindingContractDecompositionJsonSchema,
  createFindingContractFeedbackJsonSchema,
  createFindingContractPartCompletionJsonSchema,
} from './team-leader-finding-contract-schema.js';
import {
  FINDING_CONTRACT_CHANGED_PATH_OUTSIDE_ASSIGNMENT_REASON,
  FINDING_CONTRACT_CHANGED_PATHS_LIMITS,
  FindingContractInputValidationError,
  findingContractPathIsWithin,
  findingContractPathsOverlap,
  normalizeFindingContractPath,
  requireBoundedString,
  requireExactKeys,
  requireNonEmptyString,
  requireObject,
  requireStringArray,
} from './team-leader-finding-contract-validation.js';

export interface FindingContractPartBatchValidationIssue {
  readonly code:
    | 'missing_assignment'
    | 'unknown_finding'
    | 'duplicate_repair_assignment'
    | 'overlapping_write_path';
  readonly message: string;
  readonly partId?: string;
  readonly findingId?: string;
}

export interface FindingContractPartIndexEntry {
  id: string;
  title: string;
  role: 'diagnose' | 'repair' | 'verify';
  findingIds: string[];
  status: string;
  summary: string;
  claimAssessment?: {
    status: 'invalid';
    validation: FindingContractClaimValidation;
  };
  outcomes: Array<{
    findingId: string;
    outcome: 'addressed' | 'disputed' | 'blocked';
    evidence: string[];
  }>;
  checks: {
    passed: number;
    failed: number;
    notRun: number;
  };
}

export interface FindingContractFindingDigest {
  findingId: string;
  partId: string;
  title: string;
  role: 'diagnose' | 'repair' | 'verify';
  status: string;
  claimAssessment?: {
    status: 'invalid';
  };
  outcome?: {
    outcome: 'addressed' | 'disputed' | 'blocked';
    evidence: string[];
  };
  checks: FindingContractPartIndexEntry['checks'];
}

export interface SequencedFindingContractPartIndexEntry {
  sequence: number;
  entry: FindingContractPartIndexEntry;
}

const INVALID_COMPLETION_CLAIM_REASON = 'Completion claim failed validation';

export type FindingContractClaimValidation =
  | {
      readonly code: 'changed_path_outside_assignment';
      readonly fieldPath: `changedPaths[${number}]`;
      readonly reason: typeof FINDING_CONTRACT_CHANGED_PATH_OUTSIDE_ASSIGNMENT_REASON;
    }
  | {
      readonly code: 'invalid_completion_claim';
      readonly fieldPath: '$';
      readonly reason: typeof INVALID_COMPLETION_CLAIM_REASON;
    };

const COMPACT_SUMMARY_MAX_LENGTH = 300;
const COMPACT_EVIDENCE_MAX_ITEMS = 3;
const COMPACT_EVIDENCE_MAX_LENGTH = 300;

export function parseFindingContractPartDefinition(entry: unknown, index: number): PartDefinition {
  const raw = requireObject(entry, `Part[${index}]`);
  requireExactKeys(raw, `Part[${index}]`, ['id', 'title', 'instruction', 'findingContract']);
  const base = parsePartDefinitionEntry(entry, index);
  const assignment = requireObject(raw.findingContract, `Part[${index}] "findingContract"`);
  requireExactKeys(
    assignment,
    `Part[${index}] "findingContract"`,
    ['findingIds', 'role', 'writePaths', 'readPaths'],
  );
  const role = requireNonEmptyString(assignment.role, `Part[${index}] "findingContract.role"`);
  if (role !== 'diagnose' && role !== 'repair' && role !== 'verify') {
    throw new FindingContractInputValidationError(`Part[${index}] "findingContract.role" is invalid: ${role}`);
  }
  const writePaths = requireStringArray(
    assignment.writePaths,
    `Part[${index}] "findingContract.writePaths"`,
  ).map((path, pathIndex) => normalizeFindingContractPath(path, `Part[${index}] writePaths[${pathIndex}]`));
  const readPaths = requireStringArray(
    assignment.readPaths,
    `Part[${index}] "findingContract.readPaths"`,
  ).map((path, pathIndex) => normalizeFindingContractPath(path, `Part[${index}] readPaths[${pathIndex}]`));
  return {
    ...base,
    findingContract: {
      findingIds: requireStringArray(
        assignment.findingIds,
        `Part[${index}] "findingContract.findingIds"`,
        { nonEmpty: true },
      ),
      role,
      writePaths,
      readPaths,
    },
  };
}

export function validateFindingContractPartBatch(
  parts: PartDefinition[],
  targetFindingIds: readonly string[],
): void {
  const issues = collectFindingContractPartBatchValidationIssues(parts, targetFindingIds);
  if (issues.length > 0) {
    throw new FindingContractInputValidationError(issues.map((issue) => issue.message).join('; '));
  }
}

export function collectFindingContractPartBatchValidationIssues(
  parts: readonly PartDefinition[],
  targetFindingIds: readonly string[],
): FindingContractPartBatchValidationIssue[] {
  const targetIds = new Set(targetFindingIds);
  const repairOwners = new Map<string, string>();
  const issues: FindingContractPartBatchValidationIssue[] = [];
  const writeOwners: Array<{ path: string; partId: string }> = [];
  for (const part of parts) {
    const assignment = part.findingContract;
    if (!assignment) {
      issues.push({
        code: 'missing_assignment',
        partId: part.id,
        message: `Part "${part.id}" is missing findingContract assignment`,
      });
      continue;
    }
    for (const findingId of assignment.findingIds) {
      if (!targetIds.has(findingId)) {
        issues.push({
          code: 'unknown_finding',
          partId: part.id,
          findingId,
          message: `Part "${part.id}" references unknown actionable finding "${findingId}"`,
        });
      }
      if (assignment.role === 'repair') {
        const owner = repairOwners.get(findingId);
        if (owner !== undefined) {
          issues.push({
            code: 'duplicate_repair_assignment',
            partId: part.id,
            findingId,
            message: `Finding "${findingId}" is assigned to multiple repair parts: "${owner}" and "${part.id}"`,
          });
        } else {
          repairOwners.set(findingId, part.id);
        }
      }
    }
    for (const path of assignment.writePaths) {
      const conflicts = writeOwners.filter((entry) => findingContractPathsOverlap(entry.path, path));
      for (const conflict of conflicts) {
        issues.push({
          code: 'overlapping_write_path',
          partId: part.id,
          message: `Finding Contract part write paths overlap in one batch: `
            + `"${conflict.partId}:${conflict.path}" and "${part.id}:${path}"`,
        });
      }
      writeOwners.push({ path, partId: part.id });
    }
  }
  return issues;
}

export function parseFindingContractPartCompletionClaim(
  raw: unknown,
  part: PartDefinition,
): FindingContractPartCompletionClaim {
  const payload = requireObject(raw, `Part "${part.id}" structured output`);
  requireExactKeys(payload, `Part "${part.id}" structured output`, [
    'findingOutcomes',
    'changedPaths',
    'checks',
    'summary',
  ]);
  if (!part.findingContract) {
    throw new FindingContractInputValidationError(`Part "${part.id}" is missing findingContract assignment`);
  }
  if (!Array.isArray(payload.findingOutcomes)) {
    throw new FindingContractInputValidationError(`Part "${part.id}" findingOutcomes must be an array`);
  }
  const assignedIds = new Set(part.findingContract.findingIds);
  const seenIds = new Set<string>();
  const findingOutcomes = payload.findingOutcomes.map((entry, index) => {
    const outcome = requireObject(entry, `Part "${part.id}" findingOutcomes[${index}]`);
    requireExactKeys(outcome, `Part "${part.id}" findingOutcomes[${index}]`, [
      'findingId',
      'outcome',
      'evidence',
    ]);
    const findingId = requireNonEmptyString(outcome.findingId, `Part "${part.id}" findingOutcomes[${index}].findingId`);
    if (!assignedIds.has(findingId)) {
      throw new FindingContractInputValidationError(
        `Part "${part.id}" returned an outcome for unassigned finding "${findingId}"`,
      );
    }
    if (seenIds.has(findingId)) {
      throw new FindingContractInputValidationError(
        `Part "${part.id}" returned duplicate outcomes for finding "${findingId}"`,
      );
    }
    seenIds.add(findingId);
    const disposition = requireNonEmptyString(outcome.outcome, `Part "${part.id}" findingOutcomes[${index}].outcome`);
    if (disposition !== 'addressed' && disposition !== 'disputed' && disposition !== 'blocked') {
      throw new FindingContractInputValidationError(`Part "${part.id}" returned invalid outcome "${disposition}"`);
    }
    const parsedOutcome: 'addressed' | 'disputed' | 'blocked' = disposition;
    const evidence = requireStringArray(
      outcome.evidence,
      `Part "${part.id}" findingOutcomes[${index}].evidence`,
      { nonEmpty: true, maxItems: 20, maxItemLength: 1000 },
    );
    if (parsedOutcome === 'disputed' && !evidence.some((entry) => FILE_LINE_EVIDENCE_PATTERN.test(entry))) {
      throw new FindingContractInputValidationError(
        `Part "${part.id}" disputed finding "${findingId}" without file:line evidence`,
      );
    }
    return {
      findingId,
      outcome: parsedOutcome,
      evidence,
    };
  });
  for (const findingId of assignedIds) {
    if (!seenIds.has(findingId)) {
      throw new FindingContractInputValidationError(
        `Part "${part.id}" omitted an outcome for assigned finding "${findingId}"`,
      );
    }
  }
  if (!Array.isArray(payload.checks)) {
    throw new FindingContractInputValidationError(`Part "${part.id}" checks must be an array`);
  }
  const checks = payload.checks.map((entry, index) => {
    const check = requireObject(entry, `Part "${part.id}" checks[${index}]`);
    requireExactKeys(check, `Part "${part.id}" checks[${index}]`, ['command', 'status']);
    const status = requireNonEmptyString(check.status, `Part "${part.id}" checks[${index}].status`);
    if (status !== 'passed' && status !== 'failed' && status !== 'not_run') {
      throw new FindingContractInputValidationError(`Part "${part.id}" returned invalid check status "${status}"`);
    }
    const parsedStatus: 'passed' | 'failed' | 'not_run' = status;
    return {
      command: requireNonEmptyString(check.command, `Part "${part.id}" checks[${index}].command`),
      status: parsedStatus,
    };
  });
  const changedPaths = requireStringArray(
    payload.changedPaths,
    `Part "${part.id}" changedPaths`,
    FINDING_CONTRACT_CHANGED_PATHS_LIMITS,
  )
    .map((path, index) => normalizeFindingContractPath(path, `Part "${part.id}" changedPaths[${index}]`));
  for (const [index, path] of changedPaths.entries()) {
    if (!part.findingContract.writePaths.some((writePath) => findingContractPathIsWithin(path, writePath))) {
      throw new FindingContractInputValidationError(
        `Part "${part.id}" changed path is outside its writePaths assignment: ${path}`,
        {
          code: 'changed_path_outside_assignment',
          fieldPath: `changedPaths[${index}]`,
          reason: FINDING_CONTRACT_CHANGED_PATH_OUTSIDE_ASSIGNMENT_REASON,
        },
      );
    }
  }
  return {
    findingOutcomes,
    changedPaths,
    checks,
    summary: requireBoundedString(payload.summary, `Part "${part.id}" summary`, 2000),
  };
}

export type FindingContractPartCompletionClaimAssessment =
  | {
      readonly status: 'valid';
      readonly claim: FindingContractPartCompletionClaim;
    }
  | {
      readonly status: 'invalid';
      readonly validation: FindingContractClaimValidation;
    };

export function assessFindingContractPartCompletionClaim(
  raw: unknown,
  part: PartDefinition,
): FindingContractPartCompletionClaimAssessment {
  try {
    return {
      status: 'valid',
      claim: parseFindingContractPartCompletionClaim(raw, part),
    };
  } catch (error) {
    if (!(error instanceof FindingContractInputValidationError)) throw error;
    return {
      status: 'invalid',
      validation: error.classification ?? {
        code: 'invalid_completion_claim',
        fieldPath: '$',
        reason: INVALID_COMPLETION_CLAIM_REASON,
      },
    };
  }
}

export function buildFindingContractPartIndexEntry(result: PartResult): FindingContractPartIndexEntry {
  if (!result.part.findingContract) {
    throw new Error(`Part "${result.part.id}" is missing findingContract assignment`);
  }
  if (result.response.status !== 'done') {
    return {
      id: result.part.id,
      title: result.part.title,
      role: result.part.findingContract.role,
      findingIds: [...result.part.findingContract.findingIds],
      status: result.response.status,
      summary: truncateCompactText(result.response.error ?? result.response.content),
      outcomes: [],
      checks: { passed: 0, failed: 0, notRun: 0 },
    };
  }
  const assessment = assessFindingContractPartCompletionClaim(
    result.response.structuredOutput,
    result.part,
  );
  if (assessment.status === 'invalid') {
    return {
      id: result.part.id,
      title: result.part.title,
      role: result.part.findingContract.role,
      findingIds: [...result.part.findingContract.findingIds],
      status: result.response.status,
      summary: 'Invalid completion claim',
      claimAssessment: {
        status: 'invalid',
        validation: assessment.validation,
      },
      outcomes: [],
      checks: { passed: 0, failed: 0, notRun: 0 },
    };
  }
  const claim = assessment.claim;
  return {
    id: result.part.id,
    title: result.part.title,
    role: result.part.findingContract.role,
    findingIds: [...result.part.findingContract.findingIds],
    status: result.response.status,
    summary: truncateCompactText(claim.summary),
    outcomes: claim.findingOutcomes.map((outcome) => ({
      ...outcome,
      evidence: outcome.evidence
        .slice(0, COMPACT_EVIDENCE_MAX_ITEMS)
        .map((entry) => truncateCompactText(entry, COMPACT_EVIDENCE_MAX_LENGTH)),
    })),
    checks: {
      passed: claim.checks.filter((check) => check.status === 'passed').length,
      failed: claim.checks.filter((check) => check.status === 'failed').length,
      notRun: claim.checks.filter((check) => check.status === 'not_run').length,
    },
  };
}

export function buildLatestFindingContractDigests(
  sequencedEntries: readonly SequencedFindingContractPartIndexEntry[],
): FindingContractFindingDigest[] {
  const latestByFindingId = new Map<string, FindingContractFindingDigest>();
  const seenSequences = new Set<number>();
  const entries = [...sequencedEntries].sort((left, right) => left.sequence - right.sequence);
  for (const { sequence, entry } of entries) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error(`Finding Contract part sequence is invalid: ${sequence}`);
    }
    if (seenSequences.has(sequence)) {
      throw new Error(`Finding Contract part sequence is duplicated: ${sequence}`);
    }
    seenSequences.add(sequence);
    for (const findingId of entry.findingIds) {
      const outcome = entry.outcomes.find((candidate) => candidate.findingId === findingId);
      latestByFindingId.set(findingId, {
        findingId,
        partId: entry.id,
        title: entry.title,
        role: entry.role,
        status: entry.status,
        ...(entry.claimAssessment === undefined
          ? {}
          : { claimAssessment: { status: entry.claimAssessment.status } }),
        ...(outcome === undefined
          ? {}
          : { outcome: { outcome: outcome.outcome, evidence: outcome.evidence } }),
        checks: entry.checks,
      });
    }
  }
  return [...latestByFindingId.values()].sort((left, right) => {
    return left.findingId.localeCompare(right.findingId);
  });
}

function truncateCompactText(value: string, maxLength = COMPACT_SUMMARY_MAX_LENGTH): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

export function renderActionableFindingContractSummary(
  ledger: FindingLedger,
  findingIds?: readonly string[],
): string {
  return renderActionableFindingLedgerInstructionSummary(ledger, findingIds);
}

export function renderCompactActionableFindingContractSummary(
  ledger: FindingLedger,
  findingIds?: readonly string[],
): string {
  return renderCompactActionableFindingLedgerInstructionSummary(ledger, findingIds);
}

export function collectActionableFindingIds(ledger: FindingLedger): string[] {
  return selectActionableFindingEntries(ledger).map((finding) => finding.id);
}

export function appendFindingContractPartAssignmentInstruction(
  instruction: string,
  part: PartDefinition,
  language: Language | undefined,
  actionableFindings: string,
): string {
  if (part.findingContract === undefined) {
    throw new Error(`Part "${part.id}" is missing findingContract assignment`);
  }
  const guidance = language === 'ja'
    ? [
        'これは並列作業の協調契約であり、filesystem sandbox ではありません。',
        '`findingIds` の範囲だけを扱い、変更は `writePaths` の内側に限定してください。',
        '`writePaths`、`readPaths`、`changedPaths` はリテラルなパスです。ワイルドカードの `*` と `?` は使えません。',
        '`readPaths` は調査対象の目安であり、必要な依存関係の読み取りを禁止するものではありません。',
      ]
    : [
        'This is a parallel-work coordination contract, not a filesystem sandbox.',
        'Handle only the assigned findingIds and keep changes within writePaths.',
        'writePaths, readPaths, and changedPaths are literal paths; wildcard characters * and ? are not allowed.',
        'readPaths guide inspection but do not prohibit reading required dependencies.',
      ];
  return [
    instruction,
    '',
    '## Finding Contract Part Assignment',
    ...guidance,
    '```json',
    JSON.stringify(part.findingContract, null, 2),
    '```',
    '',
    '## Assigned Finding Details',
    actionableFindings,
  ].join('\n');
}
