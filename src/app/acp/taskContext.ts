import type { AcpTaskContext } from './types.js';

type PresentAcpTaskContext = AcpTaskContext & (
  | { branch: string }
  | { baseBranch: string }
  | { prNumber: number }
);

const CONTEXT_VALUE_PATTERN = String.raw`([^\s,;!?。、]+)`;
const BRANCH_PATTERN = new RegExp(String.raw`(?:^|[\s,.;!?。、])branch\s*[:=]\s*${CONTEXT_VALUE_PATTERN}`, 'iu');
const BASE_BRANCH_PATTERN = new RegExp(
  String.raw`(?:^|[\s,.;!?。、])(?:baseBranch|base_branch)\s*[:=]\s*${CONTEXT_VALUE_PATTERN}`,
  'iu',
);
const PR_NUMBER_KEY_PATTERN = new RegExp(
  String.raw`(?:^|[\s,.;!?。、])(?:prNumber|pr_number)\s*[:=]\s*${CONTEXT_VALUE_PATTERN}`,
  'iu',
);
const PR_NUMBER_LABEL_PATTERN = new RegExp(String.raw`\bPR\s*#\s*${CONTEXT_VALUE_PATTERN}`, 'iu');
const REMOTE_TRACKING_REF_PREFIXES = ['origin/', 'refs/remotes/'];
const DISALLOWED_BRANCH_PREFIXES = ['refs/'];
const DISALLOWED_BRANCH_CHARACTERS = new Set(['~', '^', ':', '?', '*', '[', ']', '\\']);

export function assertValidAcpBranchName(branch: string): void {
  const trimmed = branch.trim();
  if (trimmed.length === 0 || trimmed !== branch) {
    throw new Error('ACP branch must be a non-empty branch name without surrounding whitespace.');
  }
  if (branch.includes(':')) {
    throw new Error(`ACP branch must be a branch name, not a refspec: ${branch}`);
  }
  if (branch.includes('@{')) {
    throw new Error(`ACP branch must be a plain branch name, not a reflog selector: ${branch}`);
  }
  if (branch.startsWith('-')) {
    throw new Error(`ACP branch must be a plain local branch name, not a Git option: ${branch}`);
  }
  if (DISALLOWED_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
    throw new Error(`ACP branch must be a plain local branch name, not a full ref: ${branch}`);
  }
  if (REMOTE_TRACKING_REF_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
    throw new Error(`ACP branch must be a branch name, not a remote-tracking ref: ${branch}`);
  }

  if (!isValidGitBranchRefName(branch)) {
    throw new Error(`Invalid ACP branch: ${branch}`);
  }
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

export function isValidAcpBranchName(branch: string): boolean {
  try {
    assertValidAcpBranchName(branch);
    return true;
  } catch {
    return false;
  }
}

function assertValidAcpPrNumber(prNumber: number): void {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('ACP prNumber must be a positive integer.');
  }
}

export function assertValidAcpTaskContext(context: AcpTaskContext): void {
  if (context.branch !== undefined) {
    assertValidAcpBranchName(context.branch);
  }
  if (context.baseBranch !== undefined) {
    assertValidAcpBranchName(context.baseBranch);
  }
  if (context.prNumber !== undefined) {
    assertValidAcpPrNumber(context.prNumber);
  }
}

function extractContextValue(text: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(text)?.[1]?.replace(/[.。]+$/u, '').trim();
  return value ? value : undefined;
}

function extractPrNumber(text: string): number | undefined {
  const value = extractContextValue(text, PR_NUMBER_KEY_PATTERN)
    ?? extractContextValue(text, PR_NUMBER_LABEL_PATTERN);
  if (!value) {
    return undefined;
  }

  if (!/^-?\d+$/u.test(value)) {
    throw new Error('ACP prNumber must be a positive integer.');
  }

  const parsed = Number.parseInt(value, 10);
  assertValidAcpPrNumber(parsed);
  return parsed;
}

export function hasAcpTaskContext(context: AcpTaskContext | undefined): context is PresentAcpTaskContext {
  return context?.branch !== undefined
    || context?.baseBranch !== undefined
    || context?.prNumber !== undefined;
}

export function extractAcpTaskContextFromText(text: string): PresentAcpTaskContext | undefined {
  const branch = extractContextValue(text, BRANCH_PATTERN);
  const baseBranch = extractContextValue(text, BASE_BRANCH_PATTERN);
  const prNumber = extractPrNumber(text);
  if (branch !== undefined) {
    assertValidAcpBranchName(branch);
  }
  if (baseBranch !== undefined) {
    assertValidAcpBranchName(baseBranch);
  }
  const context: AcpTaskContext = {
    ...(branch !== undefined && { branch }),
    ...(baseBranch !== undefined && { baseBranch }),
    ...(prNumber !== undefined && { prNumber }),
  };
  return hasAcpTaskContext(context) ? context : undefined;
}

export function mergeAcpTaskContext(
  base: AcpTaskContext | undefined,
  override: PresentAcpTaskContext,
): PresentAcpTaskContext;
export function mergeAcpTaskContext(
  base: AcpTaskContext | undefined,
  override: AcpTaskContext | undefined,
): PresentAcpTaskContext | undefined;
export function mergeAcpTaskContext(
  base: AcpTaskContext | undefined,
  override: AcpTaskContext | undefined,
): PresentAcpTaskContext | undefined {
  const merged: AcpTaskContext = {
    ...(base?.branch !== undefined && { branch: base.branch }),
    ...(base?.baseBranch !== undefined && { baseBranch: base.baseBranch }),
    ...(base?.prNumber !== undefined && { prNumber: base.prNumber }),
    ...(override?.branch !== undefined && { branch: override.branch }),
    ...(override?.baseBranch !== undefined && { baseBranch: override.baseBranch }),
    ...(override?.prNumber !== undefined && { prNumber: override.prNumber }),
  };
  return hasAcpTaskContext(merged) ? merged : undefined;
}
