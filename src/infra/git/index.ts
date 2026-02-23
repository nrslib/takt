/**
 * Git provider factory
 *
 * Returns the singleton GitProvider instance.
 * Currently wired to GitHubProvider; swap here when adding GitLab support.
 */

import { GitHubProvider } from '../github/GitHubProvider.js';
import type { GitProvider } from './types.js';

export type { GitProvider, Issue, CliStatus, ExistingPr, CreatePrOptions, CreatePrResult, CreateIssueOptions, CreateIssueResult } from './types.js';

let provider: GitProvider | undefined;

export function getGitProvider(): GitProvider {
  if (!provider) {
    provider = new GitHubProvider();
  }
  return provider;
}
