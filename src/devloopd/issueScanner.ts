import { resolve } from 'node:path';
import {
  createDefaultDevloopCommandRunner,
  type DevloopCommandRunner,
} from './commandRunner.js';
import { getErrorMessage } from '../shared/utils/index.js';
import { sanitizeSensitiveText } from '../shared/utils/sensitiveText.js';

export type DevloopIssueScannerCommandRunner = DevloopCommandRunner;

export type IssueCandidateMode = 'auto_pr_only' | 'auto_merge_candidate' | 'human_required' | 'skip';
export type IssueMechanicalRisk = 'low' | 'medium' | 'high';
export type IssueScanFailureKind = 'command_missing' | 'gh_error' | 'rate_limited';

export interface RawIssueInput {
  number: number;
  title: string;
  body?: string | null;
  url: string;
  labels: readonly string[];
  updatedAt: string;
  comments: number;
}

export interface IssueCandidate {
  number: number;
  title: string;
  url: string;
  labels: readonly string[];
  updatedAt: string;
  comments: number;
  mechanicalRisk: IssueMechanicalRisk;
  mode: IssueCandidateMode;
  reason: string;
}

export interface IssueScanPolicy {
  labelsAny: readonly string[];
  labelsForbidden: readonly string[];
  autoMergeLabels: readonly string[];
  humanRequiredPatterns: readonly RegExp[];
  unsafeRequestPatterns: readonly RegExp[];
  limit: number;
}

export interface ScanIssuesOptions {
  repoPath?: string;
  repo?: string;
  policy?: Partial<IssueScanPolicy>;
  env?: NodeJS.ProcessEnv;
  runner?: DevloopIssueScannerCommandRunner;
}

export interface IssueScanReport {
  passed: boolean;
  message: string;
  candidates: IssueCandidate[];
  skipped: IssueCandidate[];
  failureKind?: IssueScanFailureKind;
  retryAfterSeconds?: number;
}

interface GhIssue {
  number?: number;
  title?: string;
  body?: string | null;
  url?: string;
  labels?: Array<{ name?: string }>;
  updatedAt?: string;
  comments?: unknown[] | number;
}

const DEFAULT_POLICY: IssueScanPolicy = {
  labelsAny: ['agent:ready', 'bug', 'tests', 'docs'],
  labelsForbidden: [
    'human-required',
    'security-sensitive',
    'blocked',
    'do-not-touch',
    'billing',
    'payments',
    'infra',
  ],
  autoMergeLabels: ['agent:auto-merge', 'docs', 'tests'],
  humanRequiredPatterns: [
    /\bauth\b/i,
    /\bbilling\b/i,
    /\bpayments?\b/i,
    /\bmigrations?\b/i,
    /\binfra\b/i,
    /\bgithub actions?\b/i,
    /\bsecurity\b/i,
    /\bdependency\b/i,
  ],
  unsafeRequestPatterns: [
    /\b(secret|credential|private key|api key|token)\b/i,
    /\b\.env\b/i,
    /\bbypass (ci|checks?)\b/i,
    /\bskip (ci|checks?)\b/i,
    /\badmin merge\b/i,
    /\bforce push\b/i,
    /\brm -rf\b/i,
  ],
  limit: 50,
};

function resolvePolicy(policy: Partial<IssueScanPolicy> | undefined): IssueScanPolicy {
  return {
    ...DEFAULT_POLICY,
    ...policy,
    labelsAny: policy?.labelsAny ?? DEFAULT_POLICY.labelsAny,
    labelsForbidden: policy?.labelsForbidden ?? DEFAULT_POLICY.labelsForbidden,
    autoMergeLabels: policy?.autoMergeLabels ?? DEFAULT_POLICY.autoMergeLabels,
    humanRequiredPatterns: policy?.humanRequiredPatterns ?? DEFAULT_POLICY.humanRequiredPatterns,
    unsafeRequestPatterns: policy?.unsafeRequestPatterns ?? DEFAULT_POLICY.unsafeRequestPatterns,
  };
}

function sanitizeText(text: string): string {
  return sanitizeSensitiveText(text).replace(/\s+/g, ' ').trim();
}

function hasAnyLabel(labels: readonly string[], expected: readonly string[]): boolean {
  return labels.some((label) => expected.includes(label));
}

function findMatchingLabel(labels: readonly string[], expected: readonly string[]): string | undefined {
  return labels.find((label) => expected.includes(label));
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isRateLimitText(text: string): boolean {
  return /\b(api )?rate limit\b/i.test(text)
    || /\bsecondary rate limit\b/i.test(text)
    || /\bretry-after\b/i.test(text)
    || /\bretry after\b/i.test(text);
}

function parseRetryAfterSeconds(text: string): number | undefined {
  const retryAfterHeader = /\bretry-after\s*:?\s*(\d+)\b/i.exec(text);
  if (retryAfterHeader?.[1]) {
    return Number(retryAfterHeader[1]);
  }

  const retryAfterText = /\bretry after\s+(\d+)\s*(?:s|sec|secs|second|seconds)?\b/i.exec(text);
  if (retryAfterText?.[1]) {
    return Number(retryAfterText[1]);
  }

  return undefined;
}

function riskForMode(mode: IssueCandidateMode): IssueMechanicalRisk {
  if (mode === 'auto_merge_candidate') return 'low';
  if (mode === 'auto_pr_only') return 'medium';
  return 'high';
}

function buildBaseCandidate(issue: RawIssueInput): Pick<IssueCandidate, 'number' | 'title' | 'url' | 'labels' | 'updatedAt' | 'comments'> {
  return {
    number: issue.number,
    title: sanitizeText(issue.title),
    url: issue.url,
    labels: [...issue.labels],
    updatedAt: issue.updatedAt,
    comments: issue.comments,
  };
}

export function classifyIssue(issue: RawIssueInput, policyInput?: Partial<IssueScanPolicy>): IssueCandidate {
  const policy = resolvePolicy(policyInput);
  const baseCandidate = buildBaseCandidate(issue);
  const labels = baseCandidate.labels;
  const joinedUntrustedText = `${issue.title}\n${issue.body ?? ''}`;
  const forbiddenLabel = findMatchingLabel(labels, policy.labelsForbidden);

  if (forbiddenLabel !== undefined) {
    return {
      ...baseCandidate,
      mechanicalRisk: 'high',
      mode: 'skip',
      reason: `forbidden label: ${forbiddenLabel}`,
    };
  }

  if (!hasAnyLabel(labels, policy.labelsAny)) {
    return {
      ...baseCandidate,
      mechanicalRisk: 'medium',
      mode: 'skip',
      reason: `missing allowed backlog label: ${policy.labelsAny.join(', ')}`,
    };
  }

  if (matchesAny(joinedUntrustedText, policy.unsafeRequestPatterns)) {
    return {
      ...baseCandidate,
      mechanicalRisk: 'high',
      mode: 'human_required',
      reason: 'unsafe request in untrusted issue text',
    };
  }

  if (matchesAny(joinedUntrustedText, policy.humanRequiredPatterns)) {
    return {
      ...baseCandidate,
      mechanicalRisk: 'high',
      mode: 'human_required',
      reason: 'matches human-review-required topic',
    };
  }

  const mode: IssueCandidateMode = hasAnyLabel(labels, policy.autoMergeLabels)
    ? 'auto_merge_candidate'
    : 'auto_pr_only';
  return {
    ...baseCandidate,
    mechanicalRisk: riskForMode(mode),
    mode,
    reason: mode === 'auto_merge_candidate'
      ? 'ready label and low-risk labels present'
      : 'ready for auto PR, merge requires later gate',
  };
}

function normalizeGhIssue(issue: GhIssue): RawIssueInput | undefined {
  if (issue.number === undefined || !issue.title || !issue.url || !issue.updatedAt) {
    return undefined;
  }
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    labels: issue.labels?.flatMap((label) => label.name ? [label.name] : []) ?? [],
    updatedAt: issue.updatedAt,
    comments: Array.isArray(issue.comments) ? issue.comments.length : issue.comments ?? 0,
  };
}

function parseIssues(raw: string): RawIssueInput[] {
  const parsed = JSON.parse(raw) as GhIssue[];
  return parsed.flatMap((issue) => {
    const normalized = normalizeGhIssue(issue);
    return normalized ? [normalized] : [];
  });
}

export async function scanIssues(options: ScanIssuesOptions = {}): Promise<IssueScanReport> {
  const repoPath = resolve(options.repoPath ?? process.cwd());
  const env = options.env ?? process.env;
  const policy = resolvePolicy(options.policy);
  const runner = options.runner ?? createDefaultDevloopCommandRunner();
  const ghCommand = runner.resolveCommand('gh', env);
  if (ghCommand === undefined) {
    return { passed: false, message: 'command not found: gh', candidates: [], skipped: [], failureKind: 'command_missing' };
  }

  const args = [
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,body,labels,assignees,updatedAt,url,comments',
    '--limit',
    String(policy.limit),
  ];
  if (options.repo) {
    args.push('--repo', options.repo);
  }

  const result = await runner.exec(ghCommand, args, { cwd: repoPath, env });
  if (result.exitCode !== 0) {
    const detail = sanitizeText(result.stderr || result.stdout);
    if (isRateLimitText(detail)) {
      const retryAfterSeconds = parseRetryAfterSeconds(detail);
      return {
        passed: false,
        message: retryAfterSeconds === undefined
          ? `gh issue list rate limited: ${detail}`
          : `gh issue list rate limited; retry after ${retryAfterSeconds}s: ${detail}`,
        candidates: [],
        skipped: [],
        failureKind: 'rate_limited',
        retryAfterSeconds,
      };
    }

    return {
      passed: false,
      message: `gh issue list failed: ${detail}`,
      candidates: [],
      skipped: [],
      failureKind: 'gh_error',
    };
  }

  let issues: RawIssueInput[];
  try {
    issues = parseIssues(result.stdout);
  } catch (error) {
    return {
      passed: false,
      message: `gh issue list returned invalid JSON: ${sanitizeText(getErrorMessage(error))}`,
      candidates: [],
      skipped: [],
      failureKind: 'gh_error',
    };
  }

  const classified = issues.map((issue) => classifyIssue(issue, policy));
  const candidates = classified.filter((candidate) => candidate.mode !== 'skip' && candidate.mode !== 'human_required');
  const skipped = classified.filter((candidate) => candidate.mode === 'skip' || candidate.mode === 'human_required');

  return {
    passed: true,
    message: `Found ${candidates.length} candidate issue(s)`,
    candidates,
    skipped,
  };
}

function formatCandidate(candidate: IssueCandidate): string {
  return `#${candidate.number} [${candidate.mode}/${candidate.mechanicalRisk}] ${candidate.title} - ${candidate.reason}`;
}

export function formatIssueScanReport(report: IssueScanReport): string {
  const lines = [
    report.passed ? 'devloopd scan-issues passed' : 'devloopd scan-issues failed',
    report.message,
  ];

  if (report.candidates.length > 0) {
    lines.push('Candidates:');
    lines.push(...report.candidates.map((candidate) => `- ${formatCandidate(candidate)}`));
  }
  if (report.skipped.length > 0) {
    lines.push('Skipped:');
    lines.push(...report.skipped.map((candidate) => `- ${formatCandidate(candidate)}`));
  }
  if (report.retryAfterSeconds !== undefined) {
    lines.push(`Retry after: ${report.retryAfterSeconds}s`);
  }

  return lines.join('\n');
}
