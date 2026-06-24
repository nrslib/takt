import { resolve } from 'node:path';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type DevloopMergeCommandRunner = DevloopCommandRunner;

export type MergeGateResult =
  | 'SAFE_TO_MERGE'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'REQUEST_CHANGES'
  | 'POLICY_DENY'
  | 'CHECKS_FAILED';

export interface MergeGatePolicy {
  requiredLabel: string;
  forbiddenPathPatterns: readonly string[];
  humanReviewPathPatterns: readonly string[];
  maxFilesChanged: number;
  maxLinesChanged: number;
  mergeMethod: 'squash' | 'merge' | 'rebase';
}

export interface MergeGatePrSnapshot {
  url: string;
  number: number;
  headRefOid: string;
  labels: readonly string[];
  reviewDecision?: string;
  mergeStateStatus?: string;
  isDraft: boolean;
  changedFiles: number;
  additions: number;
  deletions: number;
}

export interface MergeGateEvaluationInput {
  pr: MergeGatePrSnapshot;
  changedPaths: readonly string[];
  checksPassed: boolean;
  expectedHeadSha?: string;
  policy?: Partial<MergeGatePolicy>;
}

export interface MergeGateReport {
  result: MergeGateResult;
  passed: boolean;
  pr?: MergeGatePrSnapshot;
  changedPaths: readonly string[];
  reasons: string[];
  mergeCommand?: readonly string[];
  detail?: string;
}

export interface MergeIfSafeOptions {
  pr: string;
  repoPath?: string;
  repo?: string;
  expectedHeadSha?: string;
  policy?: Partial<MergeGatePolicy>;
  runner?: DevloopMergeCommandRunner;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_POLICY: MergeGatePolicy = {
  requiredLabel: 'agent:auto-merge',
  forbiddenPathPatterns: [
    '.github/**',
    'infra/**',
    'terraform/**',
    'migrations/**',
    'auth/**',
    'billing/**',
    'payments/**',
    '**/.env*',
    '**/*secret*',
    '**/*credential*',
  ],
  humanReviewPathPatterns: [
    'package.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',
    'Dockerfile',
    'src/middleware*',
    'src/routes*',
    'src/config*',
  ],
  maxFilesChanged: 12,
  maxLinesChanged: 500,
  mergeMethod: 'squash',
};

interface GhPrViewResponse {
  url?: string;
  number?: number;
  headRefOid?: string;
  labels?: Array<{ name?: string }>;
  reviewDecision?: string;
  mergeStateStatus?: string;
  isDraft?: boolean;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
}

function resolvePolicy(policy: Partial<MergeGatePolicy> | undefined): MergeGatePolicy {
  return {
    ...DEFAULT_POLICY,
    ...policy,
    forbiddenPathPatterns: policy?.forbiddenPathPatterns ?? DEFAULT_POLICY.forbiddenPathPatterns,
    humanReviewPathPatterns: policy?.humanReviewPathPatterns ?? DEFAULT_POLICY.humanReviewPathPatterns,
  };
}

function sanitizeDetail(text: string): string {
  return sanitizeSensitiveText(text).trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split('/');
  const source = segments.map((segment) => {
    if (segment === '**') {
      return '(?:.*)';
    }
    return escapeRegExp(segment).replaceAll('\\*', '[^/]*');
  }).join('/');
  return new RegExp(`^${source}$`);
}

function pathMatches(path: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => globToRegExp(pattern).test(path));
}

function buildPolicyReasons(input: MergeGateEvaluationInput, policy: MergeGatePolicy): {
  policyDeny: string[];
  humanReview: string[];
  requestChanges: string[];
  checksFailed: string[];
} {
  const policyDeny: string[] = [];
  const humanReview: string[] = [];
  const requestChanges: string[] = [];
  const checksFailed: string[] = [];

  if (input.expectedHeadSha !== undefined && input.pr.headRefOid !== input.expectedHeadSha) {
    policyDeny.push(`head SHA mismatch: expected ${input.expectedHeadSha}, got ${input.pr.headRefOid}`);
  }

  if (!input.checksPassed) {
    checksFailed.push('GitHub checks did not pass');
  }

  if (input.pr.isDraft) {
    humanReview.push('PR is draft');
  }
  if (!input.pr.labels.includes(policy.requiredLabel)) {
    humanReview.push(`missing required label: ${policy.requiredLabel}`);
  }
  if (input.pr.reviewDecision !== undefined && input.pr.reviewDecision !== 'APPROVED') {
    requestChanges.push(`review decision is ${input.pr.reviewDecision}`);
  }
  if (input.pr.mergeStateStatus !== undefined && !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(input.pr.mergeStateStatus)) {
    humanReview.push(`merge state is ${input.pr.mergeStateStatus}`);
  }
  if (input.pr.changedFiles > policy.maxFilesChanged) {
    humanReview.push(`changed file count exceeds policy: ${input.pr.changedFiles} > ${policy.maxFilesChanged}`);
  }
  if (input.pr.additions + input.pr.deletions > policy.maxLinesChanged) {
    humanReview.push(`changed line count exceeds policy: ${input.pr.additions + input.pr.deletions} > ${policy.maxLinesChanged}`);
  }

  for (const path of input.changedPaths) {
    const forbiddenPattern = pathMatches(path, policy.forbiddenPathPatterns);
    if (forbiddenPattern !== undefined) {
      policyDeny.push(`forbidden path touched: ${path} (${forbiddenPattern})`);
      continue;
    }
    const humanReviewPattern = pathMatches(path, policy.humanReviewPathPatterns);
    if (humanReviewPattern !== undefined) {
      humanReview.push(`human review path touched: ${path} (${humanReviewPattern})`);
    }
  }

  return { policyDeny, humanReview, requestChanges, checksFailed };
}

export function evaluateMergeGate(input: MergeGateEvaluationInput): MergeGateReport {
  const policy = resolvePolicy(input.policy);
  const reasons = buildPolicyReasons(input, policy);

  if (reasons.policyDeny.length > 0) {
    return {
      result: 'POLICY_DENY',
      passed: false,
      pr: input.pr,
      changedPaths: input.changedPaths,
      reasons: reasons.policyDeny,
    };
  }
  if (reasons.checksFailed.length > 0) {
    return {
      result: 'CHECKS_FAILED',
      passed: false,
      pr: input.pr,
      changedPaths: input.changedPaths,
      reasons: reasons.checksFailed,
    };
  }
  if (reasons.requestChanges.length > 0) {
    return {
      result: 'REQUEST_CHANGES',
      passed: false,
      pr: input.pr,
      changedPaths: input.changedPaths,
      reasons: reasons.requestChanges,
    };
  }
  if (reasons.humanReview.length > 0) {
    return {
      result: 'HUMAN_REVIEW_REQUIRED',
      passed: false,
      pr: input.pr,
      changedPaths: input.changedPaths,
      reasons: reasons.humanReview,
    };
  }

  return {
    result: 'SAFE_TO_MERGE',
    passed: true,
    pr: input.pr,
    changedPaths: input.changedPaths,
    reasons: [],
  };
}

function parsePrView(raw: string, prRef: string): MergeGatePrSnapshot {
  const parsed = JSON.parse(raw) as GhPrViewResponse;
  if (!parsed.headRefOid || parsed.number === undefined || !parsed.url) {
    throw new Error(`gh pr view returned incomplete data for ${prRef}`);
  }

  return {
    url: parsed.url,
    number: parsed.number,
    headRefOid: parsed.headRefOid,
    labels: parsed.labels?.flatMap((label) => label.name ? [label.name] : []) ?? [],
    reviewDecision: parsed.reviewDecision,
    mergeStateStatus: parsed.mergeStateStatus,
    isDraft: parsed.isDraft === true,
    changedFiles: parsed.changedFiles ?? 0,
    additions: parsed.additions ?? 0,
    deletions: parsed.deletions ?? 0,
  };
}

async function loadPrSnapshot(
  runner: DevloopMergeCommandRunner,
  ghCommand: string,
  prRef: string,
  repoPath: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<MergeGatePrSnapshot> {
  const args = [
    'pr',
    'view',
    prRef,
    '--json',
    'url,number,headRefOid,labels,reviewDecision,mergeStateStatus,isDraft,changedFiles,additions,deletions',
  ];
  if (repo) {
    args.push('--repo', repo);
  }

  const result = await runner.exec(ghCommand, args, { cwd: repoPath, env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr view failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }
  return parsePrView(result.stdout, prRef);
}

async function loadChangedPaths(
  runner: DevloopMergeCommandRunner,
  ghCommand: string,
  prRef: string,
  repoPath: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const args = ['pr', 'diff', prRef, '--name-only'];
  if (repo) {
    args.push('--repo', repo);
  }
  const result = await runner.exec(ghCommand, args, { cwd: repoPath, env });
  if (result.exitCode !== 0) {
    throw new Error(`gh pr diff failed: ${sanitizeDetail(result.stderr || result.stdout)}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function checkGithubChecks(
  runner: DevloopMergeCommandRunner,
  ghCommand: string,
  prRef: string,
  repoPath: string,
  repo: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const args = ['pr', 'checks', prRef, '--watch'];
  if (repo) {
    args.push('--repo', repo);
  }
  const result = await runner.exec(ghCommand, args, { cwd: repoPath, env });
  return result.exitCode === 0;
}

function buildMergeArgs(prRef: string, headSha: string, policy: MergeGatePolicy, repo: string | undefined): string[] {
  const methodFlag = policy.mergeMethod === 'merge' ? '--merge' : policy.mergeMethod === 'rebase' ? '--rebase' : '--squash';
  const args = [
    'pr',
    'merge',
    prRef,
    '--auto',
    methodFlag,
    '--delete-branch',
    '--match-head-commit',
    headSha,
  ];
  if (repo) {
    args.push('--repo', repo);
  }
  return args;
}

export async function mergeIfSafe(options: MergeIfSafeOptions): Promise<MergeGateReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const ghCommand = runner.resolveCommand('gh', env);
  if (ghCommand === undefined) {
    return {
      result: 'POLICY_DENY',
      passed: false,
      changedPaths: [],
      reasons: ['command not found: gh'],
    };
  }

  try {
    const policy = resolvePolicy(options.policy);
    const pr = await loadPrSnapshot(runner, ghCommand, options.pr, repoPath, options.repo, env);
    const changedPaths = await loadChangedPaths(runner, ghCommand, options.pr, repoPath, options.repo, env);
    const checksPassed = await checkGithubChecks(runner, ghCommand, options.pr, repoPath, options.repo, env);
    const report = evaluateMergeGate({
      pr,
      changedPaths,
      checksPassed,
      expectedHeadSha: options.expectedHeadSha,
      policy,
    });

    if (!report.passed) {
      return report;
    }

    const mergeArgs = buildMergeArgs(options.pr, pr.headRefOid, policy, options.repo);
    const result = await runner.exec(ghCommand, mergeArgs, { cwd: repoPath, env });
    if (result.exitCode !== 0) {
      return {
        ...report,
        result: 'CHECKS_FAILED',
        passed: false,
        reasons: ['gh pr merge failed'],
        detail: sanitizeDetail(result.stderr || result.stdout),
      };
    }

    return {
      ...report,
      mergeCommand: [ghCommand, ...mergeArgs],
    };
  } catch (error) {
    return {
      result: 'POLICY_DENY',
      passed: false,
      changedPaths: [],
      reasons: [error instanceof Error ? sanitizeDetail(error.message) : sanitizeDetail(String(error))],
    };
  }
}

export function formatMergeGateReport(report: MergeGateReport): string {
  const lines = [
    `devloopd merge-if-safe: ${report.result}`,
    ...report.reasons.map((reason) => `- ${reason}`),
  ];
  if (report.pr) {
    lines.push(`PR: ${report.pr.url}`);
    lines.push(`Head: ${report.pr.headRefOid}`);
  }
  if (report.mergeCommand) {
    lines.push(`Merge command: ${report.mergeCommand.join(' ')}`);
  }
  if (report.detail) {
    lines.push(`Detail: ${report.detail}`);
  }
  return lines.join('\n');
}
