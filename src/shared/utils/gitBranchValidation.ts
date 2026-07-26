const DISALLOWED_BRANCH_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', '\\']);
const DISALLOWED_BRANCH_PREFIXES = ['refs/'];
const REMOTE_TRACKING_REF_PREFIXES = ['origin/', 'refs/remotes/'];
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

function getLocalBranchNameError(
  branch: string,
  labels: BranchValidationLabels,
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
  if (DISALLOWED_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
    return `${labels.branchLabel} must be a plain local branch name, not a full ref: ${branch}`;
  }
  if (REMOTE_TRACKING_REF_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
    return `${labels.branchLabel} must be a branch name, not a remote-tracking ref: ${branch}`;
  }
  if (!isValidGitBranchRefName(branch)) {
    return `${labels.invalidBranchLabel}: ${branch}`;
  }
  return undefined;
}

function isValidGitBranchRefName(branch: string): boolean {
  if (
    branch === '@'
    || branch.startsWith('/')
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

function hasInvalidGitBranchCharacter(branch: string): boolean {
  for (const char of branch) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127 || DISALLOWED_BRANCH_CHARACTERS.has(char)) {
      return true;
    }
  }
  return false;
}
