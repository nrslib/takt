import {
  getGitProvider,
} from '../../git/index.js';
import type {
  SystemStepExistingPr,
  SystemStepGitProvider,
  SystemStepIssue,
  SystemStepIssueListItem,
  SystemStepPrListItem,
  SystemStepPrReviewData,
} from '../../../core/workflow/system/system-step-services.js';
import { getCurrentBranch } from '../../task/index.js';

export interface CurrentBranchResolution {
  readonly branch?: string;
  readonly error?: string;
}

export function getCommandErrorDetail(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    if (typeof stderr === 'string' && stderr.trim().length > 0) {
      return stderr.trim();
    }
    if (Buffer.isBuffer(stderr)) {
      const text = stderr.toString('utf-8').trim();
      if (text.length > 0) {
        return text;
      }
    }
  }

  return String(error);
}

export function isMergeConflictError(error: unknown): boolean {
  const detail = getCommandErrorDetail(error);
  return /\bCONFLICT\b|Automatic merge failed/i.test(detail);
}

export function appendSecondaryError(primary: string, label: string, secondary: unknown): string {
  const secondaryDetail = getCommandErrorDetail(secondary);
  return `${primary} (${label}: ${secondaryDetail})`;
}

export function resolveCurrentBranch(cwd: string): CurrentBranchResolution {
  try {
    const branch = getCurrentBranch(cwd).trim();
    return branch.length > 0 ? { branch } : {};
  } catch (error) {
    return { error: getCommandErrorDetail(error) };
  }
}

function requireAvailableProvider(cwd: string, gitProvider?: SystemStepGitProvider) {
  const provider = gitProvider ?? getGitProvider();
  const cliStatus = provider.checkCliStatus(cwd);
  if (!cliStatus.available) {
    throw new Error(cliStatus.error);
  }
  return provider;
}

export function fetchExistingPr(
  cwd: string,
  branch: string,
  gitProvider?: SystemStepGitProvider,
): SystemStepExistingPr | undefined {
  return requireAvailableProvider(cwd, gitProvider).findExistingPr(branch, cwd);
}

export function fetchPrContext(
  cwd: string,
  prNumber: number,
  gitProvider?: SystemStepGitProvider,
): SystemStepPrReviewData {
  return requireAvailableProvider(cwd, gitProvider).fetchPrReviewComments(prNumber, cwd);
}

export function fetchIssueContext(
  cwd: string,
  issueNumber: number,
  gitProvider?: SystemStepGitProvider,
): SystemStepIssue {
  return requireAvailableProvider(cwd, gitProvider).fetchIssue(issueNumber, cwd);
}

export function fetchOpenIssueList(
  cwd: string,
  gitProvider?: SystemStepGitProvider,
): SystemStepIssueListItem[] {
  return requireAvailableProvider(cwd, gitProvider).listOpenIssues(cwd);
}

export function fetchOpenPrList(
  cwd: string,
  gitProvider?: SystemStepGitProvider,
): SystemStepPrListItem[] {
  return requireAvailableProvider(cwd, gitProvider).listOpenPrs(cwd);
}
