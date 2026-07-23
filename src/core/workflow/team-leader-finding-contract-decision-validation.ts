import { createHash } from 'node:crypto';
import {
  FindingContractControlValidationError,
  hasFindingContractEvidenceOrReferenceIssue as hasControlEvidenceOrReferenceIssue,
  type FindingContractControlValidationIssue,
} from './team-leader-finding-contract-control-validation.js';

export type FindingContractDecisionValidationCategory =
  | 'shape'
  | 'decision_contract'
  | 'reference'
  | 'evidence';

export interface FindingContractDecisionValidationIssue {
  readonly code: string;
  readonly category: FindingContractDecisionValidationCategory;
  readonly path: string;
  readonly message: string;
  readonly retryability?: FindingContractControlValidationIssue['retryability'];
  readonly findingId?: string;
  readonly partId?: string;
}

export interface FindingContractRejectedDecisionDigest {
  readonly hash: string;
  readonly decision?: string;
  readonly partIds: readonly string[];
  readonly assignments: readonly {
    readonly partId: string;
    readonly findingIds: readonly string[];
    readonly role?: string;
  }[];
  readonly fixCoverage: readonly {
    readonly findingId?: string;
    readonly disposition?: string;
    readonly supportingPartIds: readonly string[];
    readonly verificationPartIds: readonly string[];
  }[];
  readonly blockers: readonly string[];
}

const DECISION_DIGEST_MAX_ITEMS = 100;
const DECISION_DIGEST_MAX_STRING_LENGTH = 500;
const VALIDATION_ISSUE_MESSAGE_MAX_LENGTH = 2_000;

export class FindingContractTeamLeaderDecisionValidationError
  extends FindingContractControlValidationError<FindingContractRejectedDecisionDigest> {
  readonly decisionDigest: FindingContractRejectedDecisionDigest;

  constructor(
    issues: readonly FindingContractDecisionValidationIssue[],
    decisionDigest: FindingContractRejectedDecisionDigest,
  ) {
    const controlIssues = issues.map((issue): FindingContractControlValidationIssue => ({
      ...issue,
      boundaryKind: 'decision',
      category: issue.category,
      retryability: issue.retryability ?? 'corrective_retry',
    }));
    super(controlIssues, decisionDigest);
    this.name = 'FindingContractTeamLeaderDecisionValidationError';
    this.decisionDigest = decisionDigest;
  }
}

export function createFindingContractTeamLeaderDecisionValidationError(
  rawDecision: unknown,
  issues: readonly FindingContractDecisionValidationIssue[],
): FindingContractTeamLeaderDecisionValidationError {
  if (issues.length === 0) {
    throw new Error('Finding Contract decision validation error requires at least one issue');
  }
  return new FindingContractTeamLeaderDecisionValidationError(
    issues,
    createFindingContractRejectedDecisionDigest(rawDecision),
  );
}

export function createFindingContractDecisionValidationIssue(
  issue: FindingContractDecisionValidationIssue,
): FindingContractDecisionValidationIssue {
  return {
    ...issue,
    message: issue.message.length <= VALIDATION_ISSUE_MESSAGE_MAX_LENGTH
      ? issue.message
      : `${issue.message.slice(0, VALIDATION_ISSUE_MESSAGE_MAX_LENGTH - 1)}…`,
  };
}

export function sortFindingContractDecisionValidationIssues(
  issues: readonly FindingContractDecisionValidationIssue[],
): FindingContractDecisionValidationIssue[] {
  return [...issues].sort((left, right) => (
    validationIssueIdentity(left).localeCompare(validationIssueIdentity(right))
      || left.message.localeCompare(right.message)
  ));
}

export function fingerprintFindingContractDecisionValidationIssues(
  issues: readonly FindingContractDecisionValidationIssue[],
): string {
  const identities = [...new Set(issues.map(validationIssueIdentity))].sort();
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

export function hasFindingContractEvidenceOrReferenceIssue(
  issues: readonly FindingContractDecisionValidationIssue[],
): boolean {
  return hasControlEvidenceOrReferenceIssue(issues.map((issue) => ({
    ...issue,
    boundaryKind: 'decision',
    category: issue.category,
    retryability: 'corrective_retry',
  })));
}

export function createFindingContractRejectedDecisionDigest(
  rawDecision: unknown,
): FindingContractRejectedDecisionDigest {
  const raw = isRecord(rawDecision) ? rawDecision : {};
  const canonicalAssignments = readObjectArray(raw.parts)
    .map((part) => {
      const findingContract = isRecord(part.findingContract) ? part.findingContract : {};
      return {
        partId: readRawString(part.id) ?? '',
        findingIds: readRawStringArray(findingContract.findingIds).sort(),
        ...(readRawString(findingContract.role) === undefined
          ? {}
          : { role: readRawString(findingContract.role) }),
      };
    })
    .sort((left, right) => left.partId.localeCompare(right.partId));
  const canonicalFixCoverage = readObjectArray(raw.fixCoverage)
    .map((coverage) => ({
      ...(readRawString(coverage.findingId) === undefined
        ? {}
        : { findingId: readRawString(coverage.findingId) }),
      ...(readRawString(coverage.disposition) === undefined
        ? {}
        : { disposition: readRawString(coverage.disposition) }),
      supportingPartIds: readRawStringArray(coverage.supportingPartIds).sort(),
      verificationPartIds: readRawStringArray(coverage.verificationPartIds).sort(),
    }))
    .sort((left, right) => (
      (left.findingId ?? '').localeCompare(right.findingId ?? '')
        || (left.disposition ?? '').localeCompare(right.disposition ?? '')
    ));
  const canonicalBlockers = readRawStringArray(raw.blockers).sort();
  const canonicalSummary = {
    ...(readRawString(raw.decision) === undefined ? {} : { decision: readRawString(raw.decision) }),
    partIds: canonicalAssignments.map((assignment) => assignment.partId),
    assignments: canonicalAssignments,
    fixCoverage: canonicalFixCoverage,
    blockers: canonicalBlockers,
  };
  const visibleAssignments = canonicalAssignments.slice(0, DECISION_DIGEST_MAX_ITEMS).map((assignment) => ({
    partId: boundText(assignment.partId, DECISION_DIGEST_MAX_STRING_LENGTH),
    findingIds: assignment.findingIds
      .slice(0, DECISION_DIGEST_MAX_ITEMS)
      .map((findingId) => boundText(findingId, DECISION_DIGEST_MAX_STRING_LENGTH)),
    ...(assignment.role === undefined
      ? {}
      : { role: boundText(assignment.role, DECISION_DIGEST_MAX_STRING_LENGTH) }),
  }));
  const visibleFixCoverage = canonicalFixCoverage.slice(0, DECISION_DIGEST_MAX_ITEMS).map((coverage) => ({
    ...(coverage.findingId === undefined
      ? {}
      : { findingId: boundText(coverage.findingId, DECISION_DIGEST_MAX_STRING_LENGTH) }),
    ...(coverage.disposition === undefined
      ? {}
      : { disposition: boundText(coverage.disposition, DECISION_DIGEST_MAX_STRING_LENGTH) }),
    supportingPartIds: coverage.supportingPartIds
      .slice(0, DECISION_DIGEST_MAX_ITEMS)
      .map((partId) => boundText(partId, DECISION_DIGEST_MAX_STRING_LENGTH)),
    verificationPartIds: coverage.verificationPartIds
      .slice(0, DECISION_DIGEST_MAX_ITEMS)
      .map((partId) => boundText(partId, DECISION_DIGEST_MAX_STRING_LENGTH)),
  }));
  return {
    hash: createHash('sha256').update(canonicalJson(canonicalSummary)).digest('hex'),
    ...(canonicalSummary.decision === undefined
      ? {}
      : { decision: boundText(canonicalSummary.decision, DECISION_DIGEST_MAX_STRING_LENGTH) }),
    partIds: visibleAssignments.map((assignment) => assignment.partId),
    assignments: visibleAssignments,
    fixCoverage: visibleFixCoverage,
    blockers: canonicalBlockers
      .slice(0, DECISION_DIGEST_MAX_ITEMS)
      .map((blocker) => boundText(blocker, DECISION_DIGEST_MAX_STRING_LENGTH)),
  };
}

function validationIssueIdentity(issue: FindingContractDecisionValidationIssue): string {
  return canonicalJson({
    code: issue.code,
    category: issue.category,
    path: issue.path.replace(/\[\d+\]/g, '[]'),
    findingId: issue.findingId,
    partId: issue.partId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRawString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readRawStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readObjectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(isRecord)
    : [];
}

function boundText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Finding Contract decision digest contains a non-serializable value');
  }
  return serialized;
}
