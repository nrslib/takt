import { createHash } from 'node:crypto';

export type FindingContractControlBoundaryKind =
  | 'decomposition'
  | 'part_completion'
  | 'decision';

export type FindingContractControlValidationCategory =
  | 'shape'
  | 'contract'
  | 'decision_contract'
  | 'reference'
  | 'evidence'
  | 'authority'
  | 'mutation';

export type FindingContractControlRetryability =
  | 'corrective_retry'
  | 'terminal';

export interface FindingContractControlValidationIssue {
  readonly boundaryKind: FindingContractControlBoundaryKind;
  readonly code: string;
  readonly category: FindingContractControlValidationCategory;
  readonly path: string;
  readonly message: string;
  readonly findingId?: string;
  readonly partId?: string;
  readonly retryability: FindingContractControlRetryability;
}

export interface FindingContractRejectedOutputDigest {
  readonly hash: string;
}

const VALIDATION_ISSUE_MESSAGE_MAX_LENGTH = 2_000;

export class FindingContractControlValidationError<
  TDigest extends FindingContractRejectedOutputDigest = FindingContractRejectedOutputDigest,
> extends Error {
  readonly issues: readonly FindingContractControlValidationIssue[];
  readonly issueFingerprint: string;

  constructor(
    issues: readonly FindingContractControlValidationIssue[],
    readonly outputDigest: TDigest,
  ) {
    if (issues.length === 0) {
      throw new Error('Finding Contract control validation error requires at least one issue');
    }
    const normalizedIssues = deduplicateValidationIssues(sortFindingContractControlValidationIssues(
      issues.map(createFindingContractControlValidationIssue),
    ));
    super(normalizedIssues.map((issue) => issue.message).join('; '));
    this.name = 'FindingContractControlValidationError';
    this.issues = normalizedIssues;
    this.issueFingerprint = fingerprintFindingContractControlValidationIssues(normalizedIssues);
  }

  get retryability(): FindingContractControlRetryability {
    return this.issues.some((issue) => issue.retryability === 'terminal')
      ? 'terminal'
      : 'corrective_retry';
  }
}

export function createFindingContractControlValidationIssue(
  issue: FindingContractControlValidationIssue,
): FindingContractControlValidationIssue {
  return {
    ...issue,
    message: issue.message.length <= VALIDATION_ISSUE_MESSAGE_MAX_LENGTH
      ? issue.message
      : `${issue.message.slice(0, VALIDATION_ISSUE_MESSAGE_MAX_LENGTH - 1)}…`,
  };
}

export function sortFindingContractControlValidationIssues(
  issues: readonly FindingContractControlValidationIssue[],
): FindingContractControlValidationIssue[] {
  return [...issues].sort((left, right) => (
    validationIssueIdentity(left).localeCompare(validationIssueIdentity(right))
      || left.message.localeCompare(right.message)
  ));
}

export function fingerprintFindingContractControlValidationIssues(
  issues: readonly FindingContractControlValidationIssue[],
): string {
  const identities = [...new Set(issues.map(validationIssueIdentity))].sort();
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

export function hasFindingContractEvidenceOrReferenceIssue(
  issues: readonly FindingContractControlValidationIssue[],
): boolean {
  return issues.some((issue) => issue.category === 'evidence' || issue.category === 'reference');
}

function validationIssueIdentity(issue: FindingContractControlValidationIssue): string {
  return JSON.stringify({
    boundaryKind: issue.boundaryKind,
    code: issue.code,
    category: issue.category,
    path: issue.path.replace(/\[\d+\]/g, '[]'),
    findingId: issue.findingId,
    partId: issue.partId,
    retryability: issue.retryability,
  });
}

function deduplicateValidationIssues(
  issues: readonly FindingContractControlValidationIssue[],
): FindingContractControlValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const identity = `${validationIssueIdentity(issue)}:${issue.message}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
