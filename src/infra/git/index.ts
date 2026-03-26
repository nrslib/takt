/**
 * Git provider factory
 *
 * Returns the singleton GitProvider instance.
 * Resolution order:
 *   1. Explicit vcs_provider from config (via initGitProvider)
 *   2. Auto-detection from git remote URL
 *   3. GitHub fallback
 */

import { GitHubProvider } from '../github/GitHubProvider.js';
import { GitLabProvider } from '../gitlab/index.js';
import { detectVcsProvider } from './detect.js';
import { resolveConfigValue } from '../config/resolveConfigValue.js';
import { formatIssueAsTask, parseIssueNumbers } from './format.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import type { GitProvider, CreatePrOptions, CreatePrResult } from './types.js';
import type { VcsProviderType } from './detect.js';

export type { GitProvider, Issue, CliStatus, ExistingPr, CreatePrOptions, CreatePrResult, CommentResult, CreateIssueOptions, CreateIssueResult, PrReviewComment, PrReviewData } from './types.js';
export { formatIssueAsTask, parseIssueNumbers, isIssueReference, formatPrReviewAsTask, buildPrBody } from './format.js';

let provider: GitProvider | undefined;
let currentProviderType: VcsProviderType | undefined;

function createProvider(type: VcsProviderType): GitProvider {
  switch (type) {
    case 'gitlab':
      return new GitLabProvider();
    case 'github':
      return new GitHubProvider();
  }
}

function resolveProviderType(configValue: VcsProviderType | undefined, cwd?: string): VcsProviderType {
  if (configValue) {
    return configValue;
  }
  return detectVcsProvider(cwd) ?? 'github';
}

/**
 * Initialize the git provider from project configuration.
 *
 * Reads `vcs_provider` from the resolved config (project → global).
 * If not set, falls back to auto-detection from git remote URL.
 * If auto-detection also fails, defaults to GitHub.
 *
 * Safe to call multiple times: the singleton is only re-created
 * when the resolved provider type actually changes.
 */
export function initGitProvider(projectDir: string): void {
  const configValue = resolveConfigValue(projectDir, 'vcsProvider') as VcsProviderType | undefined;
  const resolved = resolveProviderType(configValue, projectDir);

  if (provider && currentProviderType === resolved) {
    return;
  }

  provider = createProvider(resolved);
  currentProviderType = resolved;
}

/**
 * Get the singleton GitProvider instance.
 *
 * If `initGitProvider` has not been called, falls back to
 * auto-detection → GitHub default.
 */
export function getGitProvider(): GitProvider {
  if (!provider) {
    const resolved = resolveProviderType(undefined);
    provider = createProvider(resolved);
    currentProviderType = resolved;
  }
  return provider;
}

export function createPullRequestSafely(
  gitProvider: GitProvider,
  options: CreatePrOptions,
  cwd?: string,
): CreatePrResult {
  try {
    return gitProvider.createPullRequest(options, cwd);
  } catch (createPrError) {
    return {
      success: false,
      error: getErrorMessage(createPrError),
    };
  }
}

/**
 * Resolve issue references in a task string using the singleton GitProvider.
 *
 * If task contains `#N` patterns (space-separated), fetches issues and returns formatted text.
 * Otherwise returns the task string as-is.
 * Throws if VCS CLI is not available or issue fetch fails.
 */
export function resolveIssueTask(task: string, cwd?: string): string {
  const tokens = task.trim().split(/\s+/);
  const issueNumbers = parseIssueNumbers(tokens);

  if (issueNumbers.length === 0) {
    return task;
  }

  const gitProvider = getGitProvider();
  const cliStatus = gitProvider.checkCliStatus(cwd);
  if (!cliStatus.available) {
    throw new Error(cliStatus.error);
  }

  const issues = issueNumbers.map((n) => gitProvider.fetchIssue(n, cwd));
  return issues.map(formatIssueAsTask).join('\n\n---\n\n');
}
