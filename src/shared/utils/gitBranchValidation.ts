const DISALLOWED_BRANCH_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const PSEUDO_REF_BRANCH_NAMES = new Set(['HEAD']);

export interface BranchValidationLabels {
  readonly branchLabel: string;
  readonly invalidBranchLabel: string;
}

const GENERIC_BRANCH_LABELS: BranchValidationLabels = {
  branchLabel: 'branch',
  invalidBranchLabel: 'Invalid branch',
};

export function assertValidLocalBranchName(
  branch: string,
  labels: BranchValidationLabels = GENERIC_BRANCH_LABELS,
): void {
  const error = getLocalBranchNameError(branch, labels);
  if (error !== undefined) {
    throw new Error(error);
  }
}

export function isValidLocalBranchName(branch: string): boolean {
  return getLocalBranchNameError(branch, GENERIC_BRANCH_LABELS) === undefined;
}

export function getLocalBranchNameError(
  branch: string,
  labels: BranchValidationLabels = GENERIC_BRANCH_LABELS,
): string | undefined {
  const trimmed = branch.trim();
  if (trimmed.length === 0 || trimmed !== branch) {
    return `${labels.branchLabel} must be a non-empty branch name without surrounding whitespace.`;
  }
  if (branch.includes(':')) {
    return `${labels.branchLabel} must be a branch name, not a refspec: ${branch}`;
  }
  if (branch.includes('@{')) {
    return `${labels.branchLabel} must be a plain branch name, not a reflog selector: ${branch}`;
  }
  if (branch.startsWith('-')) {
    return `${labels.branchLabel} must be a plain local branch name, not a Git option: ${branch}`;
  }
  if (PSEUDO_REF_BRANCH_NAMES.has(branch)) {
    return `${labels.branchLabel} must be a branch name, not a pseudo-ref: ${branch}`;
  }
  if (!isValidGitBranchRefName(branch)) {
    return `${labels.invalidBranchLabel}: ${branch}`;
  }
  return undefined;
}

function isValidGitBranchRefName(branch: string): boolean {
  if (
    branch.startsWith('/')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.includes('//')
    || branch.includes('..')
    || hasInvalidGitBranchCharacter(branch)
  ) {
    return false;
  }

  return branch.split('/').every((part) =>
    part.length > 0
    && !part.startsWith('.')
    && !part.endsWith('.lock'));
}

export function toLocalBranchRef(branch: string): string {
  assertValidLocalBranchName(branch);
  return `refs/heads/${branch}`;
}

export function toRemoteTrackingBranchRef(branch: string): string {
  assertValidLocalBranchName(branch);
  return `refs/remotes/origin/${branch}`;
}

export function toPullRequestBaseRef(branch: string): string {
  assertValidLocalBranchName(branch);
  return `refs/takt/pr-base/${branch}`;
}

function hasInvalidGitBranchCharacter(branch: string): boolean {
  for (const char of branch) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127 || DISALLOWED_BRANCH_CHARACTERS.has(char)) {
      return true;
    }
  }
  return false;
}
