const DISALLOWED_BRANCH_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', ']', '\\']);
const DISALLOWED_BRANCH_PREFIXES = ['refs/'];
const REMOTE_TRACKING_REF_PREFIXES = ['origin/', 'refs/remotes/'];

interface BranchValidationLabels {
  branchLabel: string;
  invalidBranchLabel: string;
}

const GENERIC_BRANCH_LABELS: BranchValidationLabels = {
  branchLabel: 'taskContext branch',
  invalidBranchLabel: 'Invalid taskContext branch',
};

export function assertValidTaskContextBranchName(
  branch: string,
  labels: BranchValidationLabels,
): void {
  const error = getTaskContextBranchNameError(branch, labels);
  if (error !== undefined) {
    throw new Error(error);
  }
}

export function isValidTaskContextBranchName(branch: string): boolean {
  return getTaskContextBranchNameError(branch, GENERIC_BRANCH_LABELS) === undefined;
}

function getTaskContextBranchNameError(branch: string, labels: BranchValidationLabels): string | undefined {
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

export function assertValidTaskContextPrNumber(prNumber: number, label: string): void {
  if (!isValidTaskContextPrNumber(prNumber)) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

export function isValidTaskContextPrNumber(prNumber: number): boolean {
  return Number.isSafeInteger(prNumber) && prNumber > 0;
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
