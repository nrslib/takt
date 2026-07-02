import type { AcpTaskContext } from './types.js';
import {
  assertValidTaskContextBranchName,
  assertValidTaskContextPrNumber,
  isValidTaskContextBranchName,
} from '../../features/tasks/taskContextValidation.js';

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
const ACP_BRANCH_VALIDATION_LABELS = {
  branchLabel: 'ACP branch',
  invalidBranchLabel: 'Invalid ACP branch',
};

export function assertValidAcpBranchName(branch: string): void {
  assertValidTaskContextBranchName(branch, ACP_BRANCH_VALIDATION_LABELS);
}

export function isValidAcpBranchName(branch: string): boolean {
  return isValidTaskContextBranchName(branch);
}

function assertValidAcpPrNumber(prNumber: number): void {
  assertValidTaskContextPrNumber(prNumber, 'ACP prNumber');
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
    throw new Error('ACP prNumber must be a positive safe integer.');
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
