import type { Language } from '../models/types.js';
import {
  assertValidLocalBranchName,
  isValidLocalBranchName,
} from '../../shared/utils/gitBranchValidation.js';

export interface PullRequestContext {
  readonly source: 'pr_review';
  readonly prNumber: number;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseBranchSource: 'pull_request' | 'default_branch_fallback';
}

export interface PersistedPullRequestContext {
  readonly source: 'pr_review';
  readonly pr_number: number;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly base_branch_source: PullRequestContext['baseBranchSource'];
}

export function createPullRequestContext(input: PullRequestContext): PullRequestContext {
  if (input.source !== 'pr_review') {
    throw new Error('PR context source must be "pr_review".');
  }
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) {
    throw new Error('PR context prNumber must be a positive safe integer.');
  }
  assertValidLocalBranchName(input.baseBranch, {
    branchLabel: 'PR context baseBranch',
    invalidBranchLabel: 'Invalid PR context baseBranch',
  });
  assertValidLocalBranchName(input.headBranch, {
    branchLabel: 'PR context headBranch',
    invalidBranchLabel: 'Invalid PR context headBranch',
  });
  if (
    input.baseBranchSource !== 'pull_request'
    && input.baseBranchSource !== 'default_branch_fallback'
  ) {
    throw new Error('PR context baseBranchSource is invalid.');
  }

  return {
    source: 'pr_review',
    prNumber: input.prNumber,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    baseBranchSource: input.baseBranchSource,
  };
}

export function encodePullRequestContext(
  context: PullRequestContext,
): PersistedPullRequestContext {
  const snapshot = createPullRequestContext(context);
  return {
    source: snapshot.source,
    pr_number: snapshot.prNumber,
    base_branch: snapshot.baseBranch,
    head_branch: snapshot.headBranch,
    base_branch_source: snapshot.baseBranchSource,
  };
}

export function decodePullRequestContext(value: unknown): PullRequestContext {
  if (!isPersistedPullRequestContext(value)) {
    throw new Error('Persisted PR context must contain only snake_case PR context fields.');
  }
  return createPullRequestContext({
    source: value.source,
    prNumber: value.pr_number,
    baseBranch: value.base_branch,
    headBranch: value.head_branch,
    baseBranchSource: value.base_branch_source,
  });
}

function isPersistedPullRequestContext(value: unknown): value is PersistedPullRequestContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'source',
    'pr_number',
    'base_branch',
    'head_branch',
    'base_branch_source',
  ];
  if (
    Object.keys(record).length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.hasOwn(record, key))
  ) {
    return false;
  }

  return record.source === 'pr_review'
    && typeof record.pr_number === 'number'
    && Number.isSafeInteger(record.pr_number)
    && record.pr_number > 0
    && typeof record.base_branch === 'string'
    && isValidLocalBranchName(record.base_branch)
    && typeof record.head_branch === 'string'
    && isValidLocalBranchName(record.head_branch)
    && (record.base_branch_source === 'pull_request'
      || record.base_branch_source === 'default_branch_fallback');
}

export function renderPullRequestContext(
  context: PullRequestContext,
  language: Language,
): string {
  const diffRange = `${context.baseBranch}...${context.headBranch}`;
  const fallback = context.baseBranchSource === 'default_branch_fallback'
    ? language === 'ja'
      ? '\n\nPR baseを取得できなかったため、default branchをbaseとして使用しています。'
      : '\n\nThe PR base was unavailable, so the default branch is being used as the base.'
    : '';
  if (language === 'ja') {
    return `## PR Context\n\nこの実行はPR由来です。単一コミットや現在のworking treeだけでなく、PRのbaseからheadまでの累積差分を判断対象にしてください。\n\n- PR: #${context.prNumber}\n- Base: ${context.baseBranch}\n- Head: ${context.headBranch}\n- Diff range: ${diffRange}\n\n必要な判断は現在の\`${diffRange}\`差分で確認してください。\`review-target.md\`と過去reportはsnapshotであり、最新差分の代替ではありません。${fallback}`;
  }
  return `## PR Context\n\nThis execution originates from a pull request. Judge the cumulative diff from the PR base to head, not only a single commit or the current working tree.\n\n- PR: #${context.prNumber}\n- Base: ${context.baseBranch}\n- Head: ${context.headBranch}\n- Diff range: ${diffRange}\n\nVerify decisions against the current \`${diffRange}\` diff. \`review-target.md\` and prior reports are snapshots, not replacements for the latest diff.${fallback}`;
}
