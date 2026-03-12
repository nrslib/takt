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
import { GitLabProvider } from '../gitlab/GitLabProvider.js';
import { detectVcsProvider } from './detect.js';
import { resolveConfigValue } from '../config/resolveConfigValue.js';
import { resolveIssueTask as resolveIssueTaskGeneric } from './format.js';
import type { GitProvider } from './types.js';
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

function resolveProviderType(configValue: VcsProviderType | undefined): VcsProviderType {
  if (configValue) {
    return configValue;
  }
  return detectVcsProvider() ?? 'github';
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
  const resolved = resolveProviderType(configValue);

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
    const detected = detectVcsProvider() ?? 'github';
    provider = createProvider(detected);
    currentProviderType = detected;
  }
  return provider;
}

/**
 * Resolve issue references in a task string using the singleton GitProvider.
 */
export function resolveIssueTask(task: string): string {
  return resolveIssueTaskGeneric(task, () => getGitProvider());
}

/**
 * Reset the singleton (for testing).
 */
export function resetGitProvider(): void {
  provider = undefined;
  currentProviderType = undefined;
}
